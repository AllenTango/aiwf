import {
  NodeGitOps,
  collectSecretValues,
  createEngine,
  createRedactor,
  createWorkflowRunner,
} from '@aiwf/core';
import type {
  EventSink,
  Logger,
  PipelineEvent,
  RunResult,
  TaskInput,
  WorkflowConfig,
} from '@aiwf/core';
import { makeConsoleLogger } from './logger.js';
import { LocalPlatformClient } from './local-platform.js';
import { mapExitCode } from './exit-code.js';
import { resolveGitRoot } from './git-root.js';
import { renderEvent, renderFinalReport, renderPlan } from './render.js';
import type { RunEnv, RunFlagValues } from './run-config.js';
import { resolveRunConfig } from './run-config.js';
import { resolveTaskInput } from './task-input.js';

/**
 * Full `aiwf run` orchestration:
 *   ingest → resolveTaskInput → git-root validation → WorkflowConfig assembly
 *   (createEngine + LocalPlatformClient + NodeGitOps) →
 *   createWorkflowRunner(config).run(task) → UX rendering → exit code.
 *
 * 安全基座(M5):
 * - 统一脱敏器覆盖终端输出(console logger)、事件渲染行与 `--json` 输出;
 * - 单步超时 / 成员任务数 / 墙钟预算均有硬上限,防止一次运行放大模型开销。
 *
 * Throws UsageError (→ exit 2) for input problems; member failures are
 * encoded in RunResult and mapped to exit 1 by the shell.
 */
export async function executeRun(
  flags: RunFlagValues,
  env: RunEnv = {},
): Promise<RunResult> {
  // 统一脱敏器:收集环境变量中的凭证明文,后续所有出口(终端 / JSON)都过它。
  const redactor = createRedactor(process.env as Record<string, string | undefined>);
  const secretValues = collectSecretValues(
    process.env as Record<string, string | undefined>,
  );

  const logger: Logger = makeConsoleLogger(console, redactor);

  // [1/5 ingest] banner 由流水线 stage 事件统一渲染(见 onEvent sink)。
  const task: TaskInput = await resolveTaskInput(flags);

  const cli = resolveRunConfig(flags, env);

  // git root validation happens before any engine is created.
  const repoDir = await resolveGitRoot(flags.dir ?? process.cwd());
  const git = new NodeGitOps();
  const baseBranch = cli.baseBranch ?? (await git.currentBranch(repoDir));
  logger.info(`目标仓库:${repoDir}(基线分支:${baseBranch})`);
  logger.info(
    `本次运行:模型任务数上限 ${cli.maxTasks} · 墙钟预算 ${Math.round(cli.wallClockBudgetMs / 1000)}s · 脱敏已启用`,
  );

  // Local delivery plumbing (platform side of the contract).
  const notes: string[] = [];
  const platform = new LocalPlatformClient({
    git,
    repoDir,
    baseBranch,
    logger,
    notes,
  });

  // [2/5 plan] — the pipeline emits stage/plan/task-* events; we render them.
  let sawPlanEvent = false;
  const onEvent: EventSink = (event: PipelineEvent): void => {
    if (event.type === 'plan') sawPlanEvent = true;
    // log 类事件由核心的 logger 镜像负责打印,这里跳过以免双打。
    if (event.type === 'log') return;
    for (const line of renderEvent(event)) logger.info(redactor(line));
  };

  const engine = createEngine({
    kind: cli.engine,
    ...(cli.model !== undefined ? { model: cli.model } : {}),
    ...(cli.timeoutMs !== undefined ? { timeoutMs: cli.timeoutMs } : {}),
  });

  const config: WorkflowConfig = {
    engine,
    platform,
    git,
    repoDir,
    logger,
    onEvent,
    engineConfig: {
      kind: cli.engine,
      ...(cli.model !== undefined ? { model: cli.model } : {}),
      ...(cli.timeoutMs !== undefined ? { timeoutMs: cli.timeoutMs } : {}),
    },
    branchPrefix: cli.branchPrefix,
    maxParallel: cli.maxParallel,
    redact: redactor,
    secretValues,
    maxTasks: cli.maxTasks,
    maxDurationMs: cli.wallClockBudgetMs,
    budgetUnits: cli.budgetUnits,
    modelPool: cli.modelPool,
    guidelines: cli.guidelines,
    ...(cli.dryRun ? { dryRun: true } : {}),
  };

  const runner = createWorkflowRunner(config);

  // [3/5 dispatch] → [4/5 synthesize] happen inside the runner.
  let result: RunResult;
  try {
    result = await runner.run(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`流水线异常终止:${message}`);
    throw error; // fatal → exit 2 at the shell boundary
  }

  // Fallback if the pipeline did not emit a plan event this stage state.
  if (!sawPlanEvent && result.deliverable.plan.tasks.length > 0) {
    logger.info('[2/5 plan](来自 RunResult)');
    for (const line of renderPlan(result.deliverable.plan)) logger.info(redactor(line));
  }

  // [5/5 deliver] — closing report box (✔/△/✘ per member, ✅/⚠️/❌ overall).
  logger.info(renderFinalReport(result, { notes }, undefined, redactor));

  // Scriptable output: full RunResult JSON after the human-facing report.
  if (cli.json) {
    console.log(redactor(JSON.stringify(result, null, 2)));
  }

  // 0 = all members completed; 1 = finished but failed/partial members exist.
  process.exitCode = mapExitCode(result.deliverable.taskResults);
  return result;
}
