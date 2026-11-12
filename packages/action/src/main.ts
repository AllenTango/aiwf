/**
 * @aiwf/action — 主入口(契约:packages/core/src/contracts/index.ts)。
 * OWNER: M4 / M3(触发准入 + 每日配额 + 脱敏接线)。
 * 经 esbuild 打包为 CJS(packages/action/dist/index.js,GitHub Marketplace 依赖 dist 入库)。
 *
 * 流程:
 *   1. 校验运行环境(GITHUB_WORKSPACE / GITHUB_TOKEN)与 inputs;
 *   2. 触发准入(trusted/anyone + allowed_actors)——**在读取 Issue 之前**判定,
 *      被拒时只 core.warning 后正常结束,避免外部用户把仓库 run 刷成红灯;
 *   3. 每日运行配额(daily_run_limit)——统计失败时 fail-open;
 *   4. 构造脱敏器,组装 WorkflowConfig(redact / secretValues / maxTasks /
 *      maxDurationMs),onEvent 经 event-bridge 桥接到 core.*;
 *   5. 失败遏制:致命 → setFailed;已产出 deliverable 但 PR 缺失 → warning + 仍输出
 *      branch/summary;仅当零成员成果且非 dry_run 时升级为 setFailed。
 */
import * as core from '@actions/core';
import * as github from '@actions/github';
import type {
  Deliverable,
  EngineConfig,
  EventSink,
  GitOps,
  Logger,
  PlatformClient,
  RunResult,
  TaskInput,
  WorkflowConfig,
  WorkflowPlan,
} from '@aiwf/core';
import {
  buildRunRecordComment,
  collectSecretValues,
  computeTaskFingerprint,
  createEngine,
  createRedactor,
  createWorkflowRunner,
  findApprovedDecision,
  findLastRunRecord,
  NodeGitOps,
} from '@aiwf/core';
import { bridgePipelineEvent, redactPipelineEvent, setDeliverableOutputs } from './event-bridge.js';
import { resolveActor, resolveAuthorAssociation } from './event-identity.js';
import { GitHubPlatformClient } from './github-platform.js';
import { evaluateTrigger } from './guard.js';
import { parseActionInputs, type ActionInputs } from './inputs.js';
import { enforceDailyQuota, parseWorkflowFileName, type RunCounter } from './quota.js';

/** 脱敏器类型(与 core 的 Redactor 同构)。 */
type Redactor = (text: string) => string;
/**
 * 模块级脱敏器(懒加载一次)。
 *
 * 之所以放在模块级:run() 之外的兜底 catch 也要能脱敏,避免异常栈里带出密钥。
 */
let cachedRedactor: Redactor | undefined;
function globalRedactor(): Redactor {
  if (cachedRedactor === undefined) {
    cachedRedactor = createRedactor(process.env);
  }
  return cachedRedactor;
}

interface WorkerDeps {
  platform: PlatformClient;
  git: GitOps;
  repoDir: string;
  logger: Logger;
  onEvent: EventSink;
  redactor: Redactor;
  /** 本次运行已知的凭证明文(供 core 扫描成员产出文件)。 */
  secretValues: readonly string[];
  /** 已批准的决策包(两段式审批的第二次执行)。 */
  presetPlan?: WorkflowPlan;
  /** 本轮只出决策包,不派发队员。 */
  decisionOnly?: boolean;
}

/** 组装全局工作流配置;engine 实例与 engineConfig 同源(cpu/timeout 等可由 core 侧取用)。 */
function assembleWorkerConfig(inputs: ActionInputs, deps: WorkerDeps): WorkflowConfig {
  const engineConfig: EngineConfig = {
    kind: inputs.engine,
    ...(inputs.model === undefined ? {} : { model: inputs.model }),
    timeoutMs: inputs.timeoutMs,
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
    redact: deps.redactor,
    secretValues: deps.secretValues,
    maxTasks: inputs.maxTasks,
    maxDurationMs: computeWallClockBudgetMs(inputs),
    budgetUnits: inputs.budgetUnits,
    modelPool: inputs.modelPool,
    guidelines: inputs.guidelines,
    ...(deps.presetPlan !== undefined ? { presetPlan: deps.presetPlan } : {}),
    ...(deps.decisionOnly === true ? { decisionOnly: true } : {}),
  };
}

/**
 * 墙钟预算:最坏情况 = 任务串行执行(并行度 1)时的总时长,再乘 1.2 余量并取整到整秒。
 * core 侧在超出预算后不再派发新成员,避免长尾任务无限期占用 runner。
 */
export function computeWallClockBudgetMs(inputs: ActionInputs): number {
  const rounds = Math.ceil(inputs.maxTasks / Math.max(1, inputs.maxParallel));
  const raw = inputs.timeoutMs * rounds * 1.2;
  return Math.ceil(raw / 1000) * 1000;
}

/**
 * 取触发者 login 与权限等级(纯函数在 event-identity.ts,便于单测)。
 */

/** 构造一个经脱敏的 Logger(四个方法全部过 redactor)。 */
function createRedactingLogger(redactor: Redactor): Logger {
  return {
    debug: (message) => core.debug(redactor(message)),
    info: (message) => core.info(redactor(message)),
    warn: (message) => core.warning(redactor(message)),
    error: (message) => core.error(redactor(message)),
  };
}

export async function run(): Promise<void> {
  // ---- 脱敏器(最先构造,后续所有输出点复用) ----
  const redactor = createRedactor(process.env);
  const secretValues = collectSecretValues(process.env);
  const logger = createRedactingLogger(redactor);

  // ---- 运行环境 ----
  const repoDir = process.env.GITHUB_WORKSPACE;
  if (repoDir === undefined || repoDir === '') {
    core.setFailed(
      redactor(
        '环境变量 GITHUB_WORKSPACE 缺失:本 action 必须在 actions/checkout 之后运行(GitHub Actions 会自动注入该变量)。',
      ),
    );
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === '') {
    core.setFailed(
      redactor(
        '环境变量 GITHUB_TOKEN 缺失:请在该步骤 env 中配置 GITHUB_TOKEN: ${{ github.token }}(或具备 issues/pull-requests 写权限的 PAT)。',
      ),
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
      core.setFailed(redactor(`输入参数无效:\n- ${outcome.errors.join('\n- ')}`));
      return;
    }
    inputs = outcome.inputs;
  } catch (error) {
    core.setFailed(
      redactor(
        `解析 inputs 失败:${describeError(error)}请核对取值与 action.yml 的约束一致(如 dry_run 仅接受 true/false)。`,
      ),
    );
    return;
  }

  // ---- 触发准入(必须在读取 Issue 之前!) ----
  const actor = resolveActor(github.context.actor, github.context.payload);
  const authorAssociation = resolveAuthorAssociation(github.context.payload);
  const triggerDecision = evaluateTrigger({
    policy: inputs.triggerPolicy,
    allowedActors: inputs.allowedActors,
    actor,
    authorAssociation,
  });
  if (!triggerDecision.allowed) {
    // 只 warning、不 setFailed:外部用户触发时不该把仓库 run 刷成红灯。
    core.warning(redactor(`🚫 触发准入未通过:${triggerDecision.reason}`));
    return;
  }

  // ---- 每日运行配额 ----
  const quotaDecision = await enforceDailyQuota({
    limit: inputs.dailyRunLimit,
    counter: createWorkflowRunCounter(token),
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    workflowId: resolveWorkflowId(),
  });
  if (!quotaDecision.allowed) {
    core.warning(redactor(`🚫 超出每日运行配额:${quotaDecision.reason}`));
    return;
  }

  core.info(
    redactor(
      `▶ 任务已接收:${inputs.taskRef} · engine=${inputs.engine}` +
        `${inputs.model ? ` · model=${inputs.model}` : ''} · branch_prefix=${inputs.branchPrefix}` +
        ` · max_parallel=${inputs.maxParallel} · dry_run=${inputs.dryRun}`,
    ),
  );
  core.info(
    redactor(
      `🔐 准入与配额:触发者=${actor || '(未知)'} · 权限等级=${authorAssociation || 'NONE(未知)'}` +
        ` · 触发策略=${inputs.triggerPolicy}` +
        `${inputs.allowedActors.length > 0 ? ` · 白名单=[${inputs.allowedActors.join(', ')}]` : ' · 白名单=(空)'}` +
        ` · ${triggerDecision.reason}`,
    ),
  );
  core.info(
    redactor(
      `⏱ 配额与预算:每日上限=${inputs.dailyRunLimit === 0 ? '不限' : inputs.dailyRunLimit}` +
        ` · ${quotaDecision.reason}` +
        ` · 单步超时=${inputs.timeoutMs}ms · 编制人数上限=${inputs.maxTasks}` +
        ` · 成本预算=${inputs.budgetUnits === 0 ? '不限' : `${inputs.budgetUnits} 单位`}` +
        ` · 墙钟预算=${computeWallClockBudgetMs(inputs)}ms`,
    ),
  );
  core.info(
    redactor(
      `🧰 编制配置:模型池=${Object.keys(inputs.modelPool).length > 0 ? Object.entries(inputs.modelPool).map(([r, m]) => `${r}→${m}`).join(', ') : '(未配置,沿用默认模型)'}` +
        ` · 行为准则=${inputs.guidelines.length} 条(仓库配置)`,
    ),
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
        redactor(
          `无法确定 base 分支(base_branch 为空且读取当前分支失败):${describeError(error)}请检查 checkout 是否成功,或显式设置 base_branch。`,
        ),
      );
      return;
    }
  }

  // ---- 平台客户端与任务预取 ----
  const platform = new GitHubPlatformClient({
    token,
    baseBranchFallback: baseBranch,
    onNotice: (message) => core.warning(redactor(message)),
  });

  let task: TaskInput;
  try {
    task = await platform.fetchTask(inputs.taskRef);
    core.info(
      redactor(`Issue 已读取:${task.title} (正文 ${task.body.length} 字 · 附加评论 ${task.comments?.length ?? 0} 条)`),
    );
  } catch (error) {
    core.setFailed(
      redactor(`读取任务 ${inputs.taskRef} 失败:${describeError(error)}请确认 Issue 存在且 token 有权访问。`),
    );
    return;
  }

  // ---- 幂等短路:任务内容没实质变化 → 不重复烧额度 ----
  const fingerprint = computeTaskFingerprint(task);
  if (inputs.idempotent) {
    try {
      const comments = await platform.listIssueComments(inputs.taskRef);
      const last = findLastRunRecord(comments);
      if (last !== null && last.fingerprint === fingerprint) {
        core.warning(
          redactor(
            `⏭ 幂等短路:任务内容与上次运行完全一致(指纹 ${fingerprint.slice(0, 8)}),` +
              '本次不调用模型、不派发队员。确需重跑请修改任务内容,或把 idempotent 设为 false。',
          ),
        );
        return;
      }
    } catch (error) {
      core.warning(redactor(`读取运行记录失败(跳过幂等检查):${describeError(error)}`));
    }
  }

  // ---- 两段式审批:先看有没有已批准的决策包 ----
  let presetPlan: WorkflowPlan | undefined;
  let decisionOnly = false;
  if (inputs.approve) {
    try {
      const comments = await platform.listIssueComments(inputs.taskRef);
      const approved = findApprovedDecision(comments);
      if (approved !== null) {
        presetPlan = approved;
        core.info(redactor(`✅ 检测到已批准的决策包(队员数 ${approved.tasks.length}),按其执行。`));
      } else {
        decisionOnly = true;
        core.info(redactor('⏸ 审批模式:本轮只产出决策包并回帖,等待你回复 `@aiwf go` 后再派发队员。'));
      }
    } catch (error) {
      // 读评论失败不应阻断:降级为「本轮只出决策包」。
      decisionOnly = true;
      core.warning(
        redactor(`读取任务评论失败(降级为只出决策包):${describeError(error)}`),
      );
    }
  }

  // ---- 运行流水线 ----
  const config = assembleWorkerConfig(inputs, {
    platform,
    git,
    repoDir,
    logger,
    // core 侧已脱敏;这里再包一层,防止将来 core 漏改某个字段。
    onEvent: (event) => {
      bridgePipelineEvent(redactPipelineEvent(event, redactor));
    },
    redactor,
    secretValues,
    ...(presetPlan !== undefined ? { presetPlan } : {}),
    ...(decisionOnly ? { decisionOnly: true } : {}),
  });
  const runner = createWorkflowRunner(config);
  core.info('AI 研发团队启动:队长规划 → 并行队员 → 队长合成。');

  let result: RunResult | undefined;
  try {
    result = await runner.run(task);
  } catch (error) {
    if (result === undefined) {
      core.setFailed(
        redactor(
          `AI 研发团队执行失败(未产出 RunResult 即中止):${describeError(error)}详细过程见上方日志。`,
        ),
      );
      await recordRun(undefined);
      return;
    }
    // 防御:runner 同时返回结果又抛出时,按"有产出但可能缺 PR"降级处理。
    finalizeRunResult(result, config, error, redactor);
    await recordRun(result);
    return;
  }
  if (result === undefined) {
    // 防御:类型上 run() 要么产出结果要么抛错;此处兜底保持同语义。
    core.setFailed(redactor('AI 研发团队执行失败:工作流终止且未产出 RunResult。详细过程见上方日志。'));
    await recordRun(undefined);
    return;
  }
  finalizeRunResult(result, config, undefined, redactor);
  await recordRun(result);

  /**
   * 写下本次运行记录(供下次幂等比对)。
   *
   * ⚠️ **审批模式的第一轮不写记录**:那一轮只产出决策包、没派任何队员,
   * 若写记录,人批准后的第二轮会因「指纹相同」被幂等短路 —— 决策包永远执行不了。
   */
  async function recordRun(runResult: RunResult | undefined): Promise<void> {
    if (decisionOnly) return;
    try {
      await platform.postComment(
        inputs.taskRef,
        buildRunRecordComment({
          fingerprint,
          at: new Date().toISOString(),
          members: runResult?.deliverable.taskResults.length ?? 0,
          verdict: runResult?.deliverable.plan.verdict ?? 'proceed',
        }),
      );
    } catch (error) {
      core.warning(redactor(`写入运行记录失败(不影响本次结果):${describeError(error)}`));
    }
  }
}

/**
 * 终态收账:outputs 一律尽力设置;PR 缺失降级为 warning;
 * 仅当"零成员成果 且 非 dry_run"时才 setFailed(全 mock 演练/部分失败等场景不红灯)。
 */
function finalizeRunResult(
  result: RunResult,
  config: WorkflowConfig,
  causedBy: unknown,
  redactor: Redactor,
): void {
  const deliverable = result.deliverable;
  const memberResults = deliverable.taskResults ?? [];
  const stageTrail = result.stageHistory.map((entry) => entry.stage).join(' → ');
  const causeText = causedBy === undefined ? '' : `底层原因:${describeError(causedBy)}`;

  setDeliverableOutputs(redactDeliverable(deliverable, redactor));
  core.info(
    `🏁 运行结束:耗时 ${Math.round(result.durationMs)} ms · 阶段 ${stageTrail || '(未记录)'} · 成员成果 ${memberResults.length} 项。`,
  );

  if (deliverable.pullRequest === undefined) {
    core.warning(
      redactor(
        `未交付 Pull Request${causeText === '' ? '' : `,${causeText}`}` +
          `(branch/summary 输出仍有效:branch=${deliverable.branch || '(无)'});` +
          'dry_run 下属预期行为,否则请检查合成/推送阶段日志。',
      ),
    );
    if (memberResults.length === 0 && !config.dryRun) {
      core.setFailed(
        redactor(
          `团队零成员成果(taskResults 为空):仅推进到规划/交付阶段,无物可交。${causeText}`,
        ),
      );
    }
    return;
  }

  core.info(`PR 已就绪:${deliverable.pullRequest.url}(分支 ${deliverable.branch})。`);
}

/** 交付物整体脱敏(PR 正文/分支名/summary 均为「离开本次运行」的文本)。 */
function redactDeliverable(deliverable: Deliverable, redactor: Redactor): Deliverable {
  return {
    ...deliverable,
    summary: redactor(deliverable.summary),
    plan: {
      ...deliverable.plan,
      summary: redactor(deliverable.plan.summary),
      risks: deliverable.plan.risks.map((risk) => redactor(risk)),
      tasks: deliverable.plan.tasks.map((task) => ({
        ...task,
        title: redactor(task.title),
        instructions: redactor(task.instructions),
      })),
    },
    taskResults: deliverable.taskResults.map((result) => ({
      ...result,
      summary: redactor(result.summary),
      notes: result.notes.map((note) => redactor(note)),
      ...(result.error === undefined ? {} : { error: redactor(result.error) }),
      changedFiles: result.changedFiles.map((file) => ({
        ...file,
        ...(file.content === undefined ? {} : { content: redactor(file.content) }),
      })),
    })),
  };
}

/**
 * 解析工作流 workflow_id:
 *   - 优先用 GITHUB_WORKFLOW_REF 里的文件名(如 'aiwf.yml');
 *   - 其次用 GITHUB_WORKFLOW(路径) 的文件名;
 *   - 最后退化为 github.context.workflow 的文件名部分。
 */
function resolveWorkflowId(): string {
  const fromRef = parseWorkflowFileName(process.env.GITHUB_WORKFLOW_REF);
  if (fromRef !== undefined) {
    return fromRef;
  }
  const fromEnv = parseWorkflowFileName(process.env.GITHUB_WORKFLOW);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const contextWorkflow = github.context.workflow ?? '';
  const segments = contextWorkflow.split('/').filter((segment) => segment !== '');
  const fallback = segments[segments.length - 1];
  return fallback === undefined || fallback === '' ? 'unknown' : fallback;
}

/**
 * 构造当日运行次数计数器(用 octokit 的 actions.listWorkflowRuns)。
 *
 * 说明:
 *   - GitHub REST 的「按仓库列运行」接口(actions.listWorkflowRunsForRepo)不支持
 *     workflow_id 过滤,因此改用 `actions.listWorkflowRuns`(带 workflow_id 路径参数),
 *     精确限定到本工作流;
 *   - 用 `created>=<当日零点>` 限定时间窗;
 *   - **排除当前这次运行**:GitHub 在 action 启动前就已把本次 run 建好,若计入,
 *     limit=20 会在第 20 次就被拒(与「第 21 次被拒」的语义不符);
 *   - 分页拉取,避免超过 100 次/页时低估。
 */
function createWorkflowRunCounter(token: string): RunCounter {
  const octokit = github.getOctokit(token);
  return async ({ owner, repo, workflowId, since }) => {
    const currentRunId = github.context.runId;
    const perPage = 100;
    const sinceDay = since.slice(0, 10); // YYYY-MM-DD
    let counted = 0;
    let page = 1;
    // 显式分页:workflow_runs 是具名数组,直接依赖 paginate 的形状推断不稳妥。
    for (;;) {
      const response = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowId,
        // 服务端过滤走 GitHub 搜索语法的日期比较(>=),大幅减少返回量。
        created: `>=${sinceDay}`,
        per_page: perPage,
        page,
      });
      const runs = response.data.workflow_runs ?? [];
      for (const run of runs) {
        if (run.id === currentRunId) {
          continue; // 排除当前这次运行(否则 limit=N 会在第 N 次就被拒)
        }
        // 客户端二次过滤:created_at 与 since 同为 UTC ISO,字典序即时间序。
        if (typeof run.created_at === 'string' && run.created_at < since) {
          continue;
        }
        counted += 1;
      }
      if (runs.length < perPage) {
        break;
      }
      page += 1;
      if (page > 20) {
        // 兜底:最多统计 2000 次,避免异常情况下无限翻页。
        break;
      }
    }
    return counted;
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

run().catch((error: unknown) => {
  core.setFailed(globalRedactor()(`action 主流程崩溃:${describeError(error)}`));
});
