/**
 * @aiwf/action — 主入口(契约:packages/core/src/contracts/index.ts)。
 * OWNER: M4. 经 esbuild 打包为 CJS(packages/action/dist/index.js,GitHub Marketplace 依赖 dist 入库)。
 *
 * 流程:
 *   1. 校验运行环境(GITHUB_WORKSPACE / GITHUB_TOKEN)与 inputs;
 *   2. 组装 WorkflowConfig(见 workflows 契约),onEvent 经 event-bridge 桥接到 core.*;
 *   3. 失败遏制:致命 → setFailed;已产出 deliverable 但 PR 缺失 → warning + 仍输出
 *      branch/summary;仅当零成员成果且非 dry_run 时升级为 setFailed。
 */
import * as core from '@actions/core';
import type {
  EngineConfig,
  EventSink,
  GitOps,
  Logger,
  PlatformClient,
  RunResult,
  TaskInput,
  WorkflowConfig,
} from '@aiwf/core';
import { createEngine, createWorkflowRunner, NodeGitOps } from '@aiwf/core';
import { bridgePipelineEvent, setDeliverableOutputs } from './event-bridge.js';
import { GitHubPlatformClient } from './github-platform.js';
import { parseActionInputs, type ActionInputs } from './inputs.js';

const coreLogger: Logger = {
  debug: (message) => core.debug(message),
  info: (message) => core.info(message),
  warn: (message) => core.warning(message),
  error: (message) => core.error(message),
};

interface WorkerDeps {
  platform: PlatformClient;
  git: GitOps;
  repoDir: string;
  logger: Logger;
  onEvent: EventSink;
}

/** 组装全局工作流配置;engine 实例与 engineConfig 同源(cpu/timeout 等可由 core 侧取用)。 */
function assembleWorkerConfig(inputs: ActionInputs, deps: WorkerDeps): WorkflowConfig {
  const engineConfig: EngineConfig = {
    kind: inputs.engine,
    ...(inputs.model === undefined ? {} : { model: inputs.model }),
  };
  return {
    engine: createEngine(engineConfig),
    platform: deps.platform,
    git: deps.git,
    repoDir: deps.repoDir,
    logger: deps.logger,
    onEvent: deps.onEvent,
    engineConfig,
    branchPrefix: inputs.branchPrefix,
    maxParallel: inputs.maxParallel,
    dryRun: inputs.dryRun,
  };
}

export async function run(): Promise<void> {
  // ---- 运行环境 ----
  const repoDir = process.env.GITHUB_WORKSPACE;
  if (repoDir === undefined || repoDir === '') {
    core.setFailed(
      '环境变量 GITHUB_WORKSPACE 缺失:本 action 必须在 actions/checkout 之后运行(GitHub Actions 会自动注入该变量)。',
    );
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === '') {
    core.setFailed(
      '环境变量 GITHUB_TOKEN 缺失:请在该步骤 env 中配置 GITHUB_TOKEN: ${{ github.token }}(或具备 issues/pull-requests 写权限的 PAT)。',
    );
    return;
  }

  // ---- inputs ----
  let inputs: ActionInputs;
  try {
    const outcome = parseActionInputs(
      {
        getInput: (name) => core.getInput(name),
        getBooleanInput: (name) => core.getBooleanInput(name),
      },
      process.env,
    );
    if (outcome.ok === false) {
      core.setFailed(`输入参数无效:\n- ${outcome.errors.join('\n- ')}`);
      return;
    }
    inputs = outcome.inputs;
  } catch (error) {
    core.setFailed(
      `解析 inputs 失败:${describeError(error)}请核对取值与 action.yml 的约束一致(如 dry_run 仅接受 true/false)。`,
    );
    return;
  }

  core.info(
    `▶ 任务已接收:${inputs.taskRef} · engine=${inputs.engine}` +
      `${inputs.model ? ` · model=${inputs.model}` : ''} · branch_prefix=${inputs.branchPrefix}` +
      ` · max_parallel=${inputs.maxParallel} · dry_run=${inputs.dryRun}`,
  );

  // ---- base 分支(输入优先;空则取 checkout 的当前分支) ----
  const git = new NodeGitOps();
  let baseBranch: string;
  if (inputs.baseBranch !== undefined && inputs.baseBranch !== '') {
    baseBranch = inputs.baseBranch;
  } else {
    try {
      baseBranch = await git.currentBranch(repoDir);
      core.info(`base_branch 未设置,使用 checkout 当前分支:${baseBranch}`);
    } catch (error) {
      core.setFailed(
        `无法确定 base 分支(base_branch 为空且读取当前分支失败):${describeError(error)}请检查 checkout 是否成功,或显式设置 base_branch。`,
      );
      return;
    }
  }

  // ---- 平台客户端与任务预取 ----
  const platform = new GitHubPlatformClient({
    token,
    baseBranchFallback: baseBranch,
    onNotice: (message) => core.warning(message),
  });

  let task: TaskInput;
  try {
    task = await platform.fetchTask(inputs.taskRef);
    core.info(
      `Issue 已读取:${task.title} (正文 ${task.body.length} 字 · 附加评论 ${task.comments?.length ?? 0} 条)`,
    );
  } catch (error) {
    core.setFailed(`读取任务 ${inputs.taskRef} 失败:${describeError(error)}请确认 Issue 存在且 token 有权访问。`);
    return;
  }

  // ---- 运行流水线 ----
  const config = assembleWorkerConfig(inputs, {
    platform,
    git,
    repoDir,
    logger: coreLogger,
    onEvent: bridgePipelineEvent,
  });
  const runner = createWorkflowRunner(config);
  core.info('AI 研发团队启动:队长规划 → 并行队员 → 队长合成。');

  let result: RunResult | undefined;
  try {
    result = await runner.run(task);
  } catch (error) {
    if (result === undefined) {
      core.setFailed(`AI 研发团队执行失败(未产出 RunResult 即中止):${describeError(error)}详细过程见上方日志。`);
      return;
    }
    // 防御:runner 同时返回结果又抛出时,按"有产出但可能缺 PR"降级处理。
    finalizeRunResult(result, config, error);
    return;
  }
  if (result === undefined) {
    // 防御:类型上 run() 要么产出结果要么抛错;此处兜底保持同语义。
    core.setFailed('AI 研发团队执行失败:工作流终止且未产出 RunResult。详细过程见上方日志。');
    return;
  }
  finalizeRunResult(result, config);
}

/**
 * 终态收账:outputs 一律尽力设置;PR 缺失降级为 warning;
 * 仅当"零成员成果 且 非 dry_run"时才 setFailed(全 mock 演练/部分失败等场景不红灯)。
 */
function finalizeRunResult(result: RunResult, config: WorkflowConfig, causedBy?: unknown): void {
  const deliverable = result.deliverable;
  const memberResults = deliverable.taskResults ?? [];
  const stageTrail = result.stageHistory.map((entry) => entry.stage).join(' → ');
  const causeText = causedBy === undefined ? '' : `底层原因:${describeError(causedBy)}`;

  setDeliverableOutputs(deliverable);
  core.info(
    `🏁 运行结束:耗时 ${Math.round(result.durationMs)} ms · 阶段 ${stageTrail || '(未记录)'} · 成员成果 ${memberResults.length} 项。`,
  );

  if (deliverable.pullRequest === undefined) {
    core.warning(
      `未交付 Pull Request${causeText === '' ? '' : `,${causeText}`}` +
        `(branch/summary 输出仍有效:branch=${deliverable.branch || '(无)'});` +
        'dry_run 下属预期行为,否则请检查合成/推送阶段日志。',
    );
    if (memberResults.length === 0 && !config.dryRun) {
      core.setFailed(
        `团队零成员成果(taskResults 为空):仅推进到规划/交付阶段,无物可交。${causeText}`,
      );
    }
    return;
  }

  core.info(`PR 已就绪:${deliverable.pullRequest.url}(分支 ${deliverable.branch})。`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

run().catch((error: unknown) => {
  core.setFailed(`action 主流程崩溃:${describeError(error)}`);
});
