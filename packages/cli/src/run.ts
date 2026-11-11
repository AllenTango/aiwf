import {
  NodeGitOps,
  createEngine,
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
import { renderEvent, renderFinalReport, renderPlan, renderStageBanner } from './render.js';
import type { RunEnv, RunFlagValues } from './run-config.js';
import { resolveRunConfig } from './run-config.js';
import { resolveTaskInput } from './task-input.js';

/**
 * Full `aiwf run` orchestration:
 *   ingest → resolveTaskInput → git-root validation → WorkflowConfig assembly
 *   (createEngine + LocalPlatformClient + NodeGitOps) →
 *   createWorkflowRunner(config).run(task) → UX rendering → exit code.
 *
 * Throws UsageError (→ exit 2) for input problems; member failures are
 * encoded in RunResult and mapped to exit 1 by the shell.
 */
export async function executeRun(
  flags: RunFlagValues,
  env: RunEnv = {},
): Promise<RunResult> {
  const logger: Logger = makeConsoleLogger(console);

  // [1/5 ingest] -----------------------------------------------
  logger.info(renderStageBanner('ingest'));
  const task: TaskInput = await resolveTaskInput(flags);

  const cli = resolveRunConfig(flags, env);

  // git root validation happens before any engine is created.
  const repoDir = await resolveGitRoot(flags.dir ?? process.cwd());
  const git = new NodeGitOps();
  const baseBranch = cli.baseBranch ?? (await git.currentBranch(repoDir));
  logger.info(`目标仓库:${repoDir}(基线分支:${baseBranch})`);

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
    if (event.type === 'log') {
      logger[event.level](event.message);
      return;
    }
    for (const line of renderEvent(event)) logger.info(line);
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
    for (const line of renderPlan(result.deliverable.plan)) logger.info(line);
  }

  // [5/5 deliver] — closing report box (✔/△/✘ per member, ✅/⚠️/❌ overall).
  logger.info(renderFinalReport(result, { notes }));

  // Scriptable output: full RunResult JSON after the human-facing report.
  if (cli.json) {
    console.log(JSON.stringify(result, null, 2));
  }

  // 0 = all members completed; 1 = finished but failed/partial members exist.
  process.exitCode = mapExitCode(result.deliverable.taskResults);
  return result;
}
