/**
 * 核心工作流流水线(M1):ingest → plan → dispatch → synthesize → deliver。
 *
 * - 每个阶段开头先发 `{ type: 'stage' }` 事件;所有事件同时喂 onEvent 与 logger。
 * - 成员级失败绝不抛出:一律呈现为 TaskResult{status:'failed'} 并按依赖传播跳过;
 * - 流水线级失败(仓库上下文构建、规划/校验、交付)允许抛出——任务无法继续。
 * - dry-run:只跑 ingest/plan/deliver,零副作用,summary 含 "(dry-run)"。
 */

import type {
  ChangedFile,
  Deliverable,
  Engine,
  EngineConfig,
  EventSink,
  Logger,
  LogLevel,
  PipelineEvent,
  PipelineStage,
  PlanBudget,
  PlanTask,
  PlanVerdict,
  Redactor,
  RunResult,
  TaskInput,
  TaskResult,
  TaskStatus,
  WorkflowConfig,
  WorkflowPlan,
  WorkflowRunner,
} from '../contracts/index.js';
import { buildRepoContext, extractKeywords } from '../infra/index.js';
import { validatePlan, topoLayers, flattenTopo } from './plan-utils.js';
import { deliverBranchName, taskBranchName, uniqueBranchName } from './branch-name.js';
import { materializeChangedFiles } from './materialize.js';
import { applySecretPolicy } from './secret-policy.js';
import { resolveTaskModel, trimToBudget } from './plan-economics.js';
import { buildDecisionPackageComment, buildDecisionSummary } from './decision-package.js';
import {
  buildDeliverSummary,
  buildVerdictComment,
  buildVerdictSummary,
  overallStatus,
  parseConflictFiles,
  type MergeConflict,
} from './summary.js';
import { buildPullRequestBody } from './pull-request-body.js';

const DEFAULT_BRANCH_PREFIX = 'aiwf/';
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_MAX_TASKS = 6;
const DEFAULT_ENGINE_TIMEOUT_MS = 600_000;

export function createWorkflowRunner(config: WorkflowConfig): WorkflowRunner {
  const logger: Logger = config.logger ?? silentLogger();
  const prefix = config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const maxParallel = Math.max(1, Math.floor(config.maxParallel ?? DEFAULT_MAX_PARALLEL));
  const dryRun = config.dryRun === true;
  const engineConfig = mergeEngineConfig(config.engine, config.engineConfig);
  /** 统一脱敏出口:所有离开本次运行的文本都要过它。 */
  const redact: Redactor = config.redact ?? ((text: string): string => text);
  /** 本次运行已知的凭证明文(用于产出物扫描)。 */
  const secretValues: readonly string[] = config.secretValues ?? [];
  /** 墙钟预算截止时间戳(缺省不限)。 */
  const deadline: number | undefined =
    config.maxDurationMs !== undefined && config.maxDurationMs > 0
      ? Date.now() + config.maxDurationMs
      : undefined;


  /** 所有事件统一出口:喂 onEvent,并向 logger 镜像一行可读日志。 */
  const mirrored: EventSink = (event) => {
    config.onEvent?.(event);
    mirrorToLogger(logger, event);
  };
  const log = (level: LogLevel, message: string): void => {
    mirrored({ type: 'log', level, message: redact(message), at: Date.now() });
  };

  return {
    async run(task: TaskInput): Promise<RunResult> {
      const startedAt = Date.now();
      const stageHistory: { stage: PipelineStage; at: number }[] = [];
      const emitStage = (stage: PipelineStage): void => {
        const at = Date.now();
        mirrored({ type: 'stage', stage, at });
        stageHistory.push({ stage, at });
      };

      // ---------------------------------------------------------------- 1)
      emitStage('ingest');
      log('info', `[ingest] 构建仓库上下文(rootDir=${config.repoDir})`);
      // 需求关键词 → 让快照把「与需求相关的文件」也带进来(队长判断该调整还是该新做的依据)。
      const keywords = extractKeywords(
        [task.title, task.body, ...(task.comments ?? [])].join('\n'),
      );
      const repo = await buildRepoContext(config.repoDir, { keywords });
      const baseBranch = config.baseBranch?.trim() || await config.git.currentBranch(config.repoDir);
      log(
        'info',
        `[ingest] baseBranch=${baseBranch}(调度前当前分支);repo.branch=${repo.branch}` +
          `;关键文件 ${repo.keyFiles.length} 个;近期提交 ${repo.recentCommits?.length ?? 0} 条`,
      );

      // ---------------------------------------------------------------- 2)
      emitStage('plan');
      let plan: WorkflowPlan;
      // 预算与编制约束必须回喂给队长:不给它预算,它就无从做成本权衡,只能拍脑袋拆任务。
      const budget: PlanBudget = {
        maxTasks: config.maxTasks !== undefined && config.maxTasks > 0 ? config.maxTasks : DEFAULT_MAX_TASKS,
        maxParallel,
        ...(config.maxDurationMs !== undefined ? { wallClockBudgetMs: config.maxDurationMs } : {}),
        ...(config.budgetUnits !== undefined ? { budgetUnits: config.budgetUnits } : {}),
        ...(config.modelPool !== undefined ? { modelPool: config.modelPool } : {}),
      };
      // 预置计划(两段式审批的第二次执行):跳过队长调用,直接采用已批准的决策包。
      if (config.presetPlan !== undefined) {
        plan = config.presetPlan;
        log('info', '[plan] 使用已批准的决策包(跳过队长规划调用)');
      } else {
        try {
          plan = await config.engine.plan({ task, repo, budget }, engineConfig);
        } catch (err) {
          const reason = errorMessage(err);
          log('error', `[plan] 引擎规划失败:${reason}`);
          throw new Error(`引擎规划失败:${reason}`);
        }
      }

      // ---- 队长裁决:不是 proceed 就直接短路,一个队员都不派 -------------
      const verdict = plan.verdict ?? 'proceed';
      if (verdict !== 'proceed') {
        const summary = redact(buildVerdictSummary(plan, verdict));
        const deliverable: Deliverable = {
          branch: '',
          summary,
          plan: redactPlan(plan, redact),
          taskResults: [],
        };
        log(
          'warn',
          `[plan] 队长裁决:${verdict} — ${redact(plan.rationale ?? plan.summary)}(本次未派发任何队员)`,
        );
        await postVerdictToSource(config, task, plan, verdict, redact, log);
        emitStage('deliver');
        mirrored({ type: 'deliver', deliverable, at: Date.now() });
        return { deliverable, stageHistory, durationMs: Date.now() - startedAt };
      }

      try {
        validatePlan(plan);
      } catch (err) {
        const message = errorMessage(err);
        log('error', `[plan] ${message}`);
        throw err instanceof Error ? err : new Error(message);
      }

      // 价值感知裁剪:超编制上限/成本预算时,砍价值最低的任务(而不是拓扑序靠前的)。
      // 保留部分始终满足依赖闭合(砍掉一个任务会连带砍掉它的全部后继)。
      const trim = trimToBudget(plan.tasks, {
        maxTasks: config.maxTasks,
        budgetUnits: config.budgetUnits,
      });
      if (trim.trimmed) {
        const droppedIds = trim.dropped.map((t) => t.id).join('、');
        log(
          'warn',
          `[plan] 计划超出预算(编制上限 ${config.maxTasks ?? '-'} / 成本预算 ${config.budgetUnits ?? '-'} 单位),` +
            `已按价值裁剪:保留 ${trim.kept.length} 个任务,砍掉 ${trim.dropped.length} 个(${droppedIds})`,
        );
        plan = { ...plan, tasks: trim.kept };
      }
      mirrored({ type: 'plan', plan: redactPlan(plan, redact), at: Date.now() });
      log('info', `[plan] 计划就绪:${plan.tasks.length} 个任务 — ${redact(plan.summary)}`);

      // ---- 两段式审批:第一轮只出决策包,不派发任何队员 ----
      if (config.decisionOnly === true) {
        const summary = redact(buildDecisionSummary(plan));
        const deliverable: Deliverable = {
          branch: '',
          summary,
          plan: redactPlan(plan, redact),
          taskResults: [],
        };
        log('warn', '[plan] 审批模式:已产出决策包,本轮不派发任何队员(等待 @aiwf go 批准)');
        await postDecisionPackage(config, task, plan, redact, log);
        emitStage('deliver');
        mirrored({ type: 'deliver', deliverable, at: Date.now() });
        return { deliverable, stageHistory, durationMs: Date.now() - startedAt };
      }

      const layers = topoLayers(plan.tasks);
      const order = flattenTopo(plan.tasks);

      // ------------------------------------------------------------- 干跑
      if (dryRun) {
        const summary = redact(buildDeliverSummary({ plan, results: [], conflicts: [], dryRun: true }));
        const deliverable: Deliverable = {
          branch: '',
          summary,
          plan: redactPlan(plan, redact),
          taskResults: [],
        };
        log('warn', '(dry-run) 演练模式:跳过成员执行、分支合成与 PR 创建');
        emitStage('deliver');
        mirrored({ type: 'deliver', deliverable, at: Date.now() });
        return { deliverable, stageHistory, durationMs: Date.now() - startedAt };
      }

      // ---------------------------------------------------------------- 3)
      emitStage('dispatch');
      const resultsById = new Map<string, TaskResult>();
      const branchByTask = new Map<string, string>();
      const worktreeByTask = new Map<string, string>();
      const usedBranches = new Set<string>();

      const runMemberTask = async (pt: PlanTask): Promise<TaskResult> => {
        // 墙钟预算:超预算后不再开新工作树(避免继续消耗额度)。
        if (deadline !== undefined && Date.now() > deadline) {
          const skipped: TaskResult = {
            taskId: pt.id,
            status: 'failed',
            summary: '超出本次运行的时间预算,未执行',
            changedFiles: [],
            notes: ['按时间预算策略跳过:本次运行已超出 maxDurationMs'],
            error: 'skipped: exceeded time budget',
          };
          log('warn', `[dispatch] 任务 ${pt.id} 已跳过:超出本次运行的时间预算`);
          mirrored({ type: 'task-result', result: skipped, at: Date.now() });
          return skipped;
        }
        const branch = uniqueBranchName(taskBranchName(pt.id, prefix), usedBranches);
        usedBranches.add(branch);
        mirrored({ type: 'task-dispatch', taskId: pt.id, branch, at: Date.now() });
        log('info', `[dispatch] 任务 ${pt.id} → 分支 ${branch}`);

        let worktreeDir: string;
        try {
          worktreeDir = await config.git.ensureWorktree(config.repoDir, branch);
        } catch (err) {
          const reason = errorMessage(err);
          log('error', `[dispatch] 任务 ${pt.id} 创建工作树失败:${reason}`);
          return failedResult(pt.id, `工作树创建失败:${reason}`, reason);
        }
        branchByTask.set(pt.id, branch);
        worktreeByTask.set(pt.id, worktreeDir);

        try {
          // per-task 模型:队长为不同队员指派了不同模型时,这里解析成真实 model id。
          const resolvedModel = resolveTaskModel(pt.model, config.modelPool, undefined);
          const taskForMember: PlanTask = resolvedModel !== undefined ? { ...pt, model: resolvedModel } : pt;
          let result = await config.engine.executeTask(
            {
              worktreeDir,
              branch,
              repo,
              plan,
              task: taskForMember,
              ...(config.guidelines !== undefined && config.guidelines.length > 0
                ? { guidelines: config.guidelines }
                : {}),
            },
            engineConfig,
          );

          // ---- 凭证防护(落盘前)----------------------------------
          // 命中凭证特征的文件:整文件剔除(并从工作树物理删除);内容命中的:就地脱敏。
          // 目的:密钥绝不能进入 git 提交与 PR diff(GitHub 不对二者做 secret 掩码)。
          const guarded = applySecretPolicy(result.changedFiles, secretValues, redact);
          if (guarded.dropped > 0 || guarded.redacted > 0) {
            result.changedFiles = guarded.files;
            if (guarded.dropped > 0) {
              result.notes.push(`已排除 ${guarded.dropped} 个疑似凭证文件(不落盘、不提交)`);
            }
            if (guarded.redacted > 0) {
              result.notes.push(`已对 ${guarded.redacted} 个文件中的疑似凭证做脱敏`);
            }
            if (result.status === 'completed') result.status = 'partial';
            log(
              'warn',
              `[dispatch] 任务 ${pt.id} 产出含疑似凭证:剔除 ${guarded.dropped} 个文件,脱敏 ${guarded.redacted} 个文件`,
            );
          }

          // 物化:changedFiles 逐条落盘(delete→删,add/modify→确保父目录并写)
          // 被剔除的凭证文件以 delete 形式物理删除,避免其被 `git add -A` 带进提交。
          const removals: ChangedFile[] = guarded.droppedPaths.map((p) => ({ path: p, action: 'delete' }));
          const mat = await materializeChangedFiles(worktreeDir, [...guarded.files, ...removals]);
          if (mat.skipped.length > 0) {
            for (const s of mat.skipped) result.notes.push(`物化跳过:${s.path}(${s.reason})`);
            if (result.status === 'completed') result.status = 'partial';
            log('warn', `[dispatch] 任务 ${pt.id} 有 ${mat.skipped.length} 个变更文件未能落盘`);
          }
          log('info', `[dispatch] 任务 ${pt.id} 物化完成:写入 ${mat.written.length} / 删除 ${mat.removed.length}`);
          // 提交:commitAll 内部应已处理"无变更则跳过"
          try {
            await config.git.commitAll(worktreeDir, `[aiwf] ${pt.id}: ${pt.title}`);
          } catch (err) {
            const reason = errorMessage(err);
            if (result.status === 'completed') result.status = 'partial';
            result.notes.push(`提交失败:${reason}`);
            log('warn', `[dispatch] 任务 ${pt.id} 提交失败:${reason}`);
          }
          mirrored({ type: 'task-result', result: redactResult(result, redact), at: Date.now() });
          log(
            result.status === 'failed' ? 'error' : result.status === 'partial' ? 'warn' : 'info',
            `[dispatch] 任务 ${pt.id} 完成:${result.status} — ${redact(result.error ?? result.summary)}`,
          );
          return result;
        } catch (err) {
          const reason = errorMessage(err);
          const result = failedResult(pt.id, `引擎执行异常:${reason}`, reason);
          mirrored({ type: 'task-result', result, at: Date.now() });
          log('error', `[dispatch] 任务 ${pt.id} 执行异常:${reason}`);
          return result;
        }
      };

      for (const layer of layers) {
        await runWithLimit(layer, maxParallel, async (pt) => {
          // 失败传播:直接或间接依赖已失败 → 不执行,合成 skipped 结果并照常进入合成
          const failedDep = pt.dependsOn.find((d) => resultsById.get(d)?.status === 'failed');
          if (failedDep !== undefined) {
            const result: TaskResult = {
              taskId: pt.id,
              status: 'failed',
              summary: `依赖 ${failedDep} 失败,本任务未执行`,
              changedFiles: [],
              notes: [`按失败传播策略跳过:依赖 ${failedDep} 失败`],
              error: `skipped: dependency ${failedDep} failed`,
            };
            resultsById.set(pt.id, result);
            mirrored({ type: 'task-result', result, at: Date.now() });
            log('warn', `[dispatch] 任务 ${pt.id} 已跳过:skipped: dependency ${failedDep} failed`);
            return;
          }
          const result = await runMemberTask(pt);
          resultsById.set(pt.id, result);
        });
      }
      const dispatchCounts = countByStatus(resultsById.values());
      log('info', `[dispatch] 分派完成:成功 ${dispatchCounts.completed} / 部分 ${dispatchCounts.partial} / 失败 ${dispatchCounts.failed}(共 ${order.length})`);

      // 后续公共量:按拓扑稳定顺序的最终结果
      const results: TaskResult[] = [];
      for (const id of order.map((t) => t.id)) {
        const r = resultsById.get(id);
        if (r !== undefined) results.push(r);
      }

      // ---------------------------------------------------------------- 4)
      emitStage('synthesize');
      const deliverBranch = deliverBranchName(task.title, prefix);
      log('info', `[synthesize] 交付分支:${deliverBranch}(从 baseBranch=${baseBranch} 的工作树)`);

      const disposed = new Set<string>();
      const disposeMemberWorktrees = async (): Promise<void> => {
        for (const [taskId, dir] of worktreeByTask) {
          if (disposed.has(dir)) continue;
          disposed.add(dir);
          try {
            await config.git.removeWorktree(config.repoDir, dir);
            log('debug', `[synthesize] 已清理成员工作树(任务 ${taskId}):${dir}`);
          } catch (err) {
            log('warn', `[synthesize] 清理成员工作树失败(任务 ${taskId}):${errorMessage(err)}`);
          }
        }
      };

      let deliverDir: string;
      try {
        deliverDir = await config.git.ensureWorktree(config.repoDir, deliverBranch);
      } catch (err) {
        const reason = errorMessage(err);
        log('error', `[synthesize] 交付工作树创建失败:${reason}`);
        await disposeMemberWorktrees();
        throw new Error(`交付工作树创建失败:${reason}`);
      }

      const conflicts: MergeConflict[] = [];
      let mergedCount = 0;
      try {
        for (const pt of order) {
          const branch = branchByTask.get(pt.id);
          const result = resultsById.get(pt.id);
          const mergeable =
            branch !== undefined &&
            result !== undefined &&
            (result.status === 'completed' || result.status === 'partial');
          if (!mergeable || branch === undefined) continue;
          try {
            await config.git.mergeBranch(deliverDir, branch);
            mergedCount += 1;
            log('info', `[synthesize] 已合并成员分支 ${branch}(任务 ${pt.id})`);
          } catch (err) {
            // 冲突:立刻记录(含冲突文件列表),继续其余成员分支,互不影响
            const reason = errorMessage(err);
            const files = parseConflictFiles(reason);
            conflicts.push({ branch, taskId: pt.id, files, message: reason });
            log('error', `[synthesize] 合并成员分支 ${branch} 冲突${files.length > 0 ? `,冲突文件:${files.join('、')}` : `:${reason}`};已记录并继续其余分支`);
          }
        }
      } finally {
        await disposeMemberWorktrees();
      }

      const summary = redact(buildDeliverSummary({ plan, results, conflicts, dryRun: false }));
      log('info', `[synthesize] 合并完成:成功 ${mergedCount} / 冲突 ${conflicts.length};结项报告已生成(整体状态:${overallStatus(results, conflicts)})`);

      // ---------------------------------------------------------------- 5)
      emitStage('deliver');
      log('info', `[deliver] 创建 PR:head=${deliverBranch} base=${baseBranch}`);
      const deliverable: Deliverable = {
        branch: deliverBranch,
        summary,
        plan: redactPlan(plan, redact),
        taskResults: results.map((r) => redactResult(r, redact)),
      };
      try {
        const pr = await config.platform.createPullRequest({
          title: redact(`[aiwf] ${task.title}`),
          body: redact(buildPullRequestBody(task, plan, results, summary)),
          headBranch: deliverBranch,
          baseBranch,
          reportComment: summary,
        });
        deliverable.pullRequest = pr;
        log('info', `[deliver] PR 创建成功:#${pr.number} — ${pr.url}`);
      } finally {
        try {
          await config.git.removeWorktree(config.repoDir, deliverDir);
          log('debug', `[deliver] 已清理交付工作树:${deliverDir}`);
        } catch (err) {
          log('warn', `[deliver] 清理交付工作树失败:${errorMessage(err)}`);
        }
      }
      mirrored({ type: 'deliver', deliverable, at: Date.now() });
      return { deliverable, stageHistory, durationMs: Date.now() - startedAt };
    },
  };
}

// ---------------------------------------------------------------------- 工具

/**
 * 把队长的决策包回帖到任务源(Issue),等人批准。
 */
async function postDecisionPackage(
  config: WorkflowConfig,
  task: TaskInput,
  plan: WorkflowPlan,
  redact: Redactor,
  log: (level: LogLevel, message: string) => void,
): Promise<void> {
  const ref = task.ref;
  if (ref === undefined || ref === '') {
    log('warn', '[plan] 任务没有来源引用,决策包仅出现在日志与 summary 中');
    return;
  }
  if (typeof config.platform.postComment !== 'function') {
    log('warn', '[plan] 当前平台不支持回帖,决策包仅出现在日志与 summary 中');
    return;
  }
  try {
    await config.platform.postComment(ref, redact(buildDecisionPackageComment(plan)));
    log('info', `[plan] 决策包已回帖到任务源:${ref}`);
  } catch (err) {
    log('warn', `[plan] 决策包回帖失败(不影响本次运行):${errorMessage(err)}`);
  }
}

/**
 * 把队长的裁决回帖到任务源(Issue),让人类看得见「为什么没干活」。
 *
 * 回帖失败不阻断流程(裁决已经生效,只是通知没送到)。
 */
async function postVerdictToSource(
  config: WorkflowConfig,
  task: TaskInput,
  plan: WorkflowPlan,
  verdict: Exclude<PlanVerdict, 'proceed'>,
  redact: Redactor,
  log: (level: LogLevel, message: string) => void,
): Promise<void> {
  const ref = task.ref;
  if (ref === undefined || ref === '') {
    log('warn', '[plan] 任务没有来源引用,裁决结果仅出现在日志与 summary 中');
    return;
  }
  if (typeof config.platform.postComment !== 'function') {
    log('warn', '[plan] 当前平台不支持回帖,裁决结果仅出现在日志与 summary 中');
    return;
  }
  try {
    await config.platform.postComment(ref, redact(buildVerdictComment(plan, verdict)));
    log('info', `[plan] 裁决结果已回帖到任务源:${ref}`);
  } catch (err) {
    log('warn', `[plan] 裁决结果回帖失败(不影响裁决本身):${errorMessage(err)}`);
  }
}

/**
 * 计划脱敏:队长输出可能夹带凭证(issue 正文是不可信输入,成员总结同理)。
 * 只处理文本字段,不改结构。
 */
function redactPlan(plan: WorkflowPlan, redact: Redactor): WorkflowPlan {
  return {
    ...plan,
    summary: redact(plan.summary),
    risks: plan.risks.map((r) => redact(r)),
    tasks: plan.tasks.map((t) => ({
      ...t,
      title: redact(t.title),
      instructions: redact(t.instructions),
    })),
  };
}

/**
 * 成员结果脱敏:summary / notes / error 都会流向日志与 PR 正文。
 * changedFiles 的内容不在此处理——那由 secret-policy 精确处置(避免误伤正常代码)。
 */
function redactResult(result: TaskResult, redact: Redactor): TaskResult {
  return {
    ...result,
    summary: redact(result.summary),
    notes: result.notes.map((n) => redact(n)),
    ...(result.error !== undefined ? { error: redact(result.error) } : {}),
  };
}

function failedResult(taskId: string, summary: string, error: string): TaskResult {
  return { taskId, status: 'failed', summary, changedFiles: [], notes: [], error };
}

function countByStatus(results: Iterable<TaskResult>): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { completed: 0, partial: 0, failed: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/** 引擎配置合并:默认 kind 取自 engine 实例,timeoutMs 默认 10 分钟;用户值覆盖。 */
function mergeEngineConfig(engine: Engine, partial?: Partial<EngineConfig>): EngineConfig {
  return { kind: engine.kind, timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS, ...partial };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/**
 * 日志通道镜像:仅把 log 类事件写进 logger。
 * 其余事件(stage/plan/task-dispatch/task-result/deliver)属于展示层职责,
 * 由消费方的 onEvent 渲染(避免同一消息双打);结构化信息已在 RunResult 中。
 */
function mirrorToLogger(logger: Logger, event: PipelineEvent): void {
  if (event.type === 'log') {
    logger[event.level](event.message);
  }
}

/** 同层任务 worker-pool 并发,严格不超过 limit。 */
async function runWithLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let cursor = 0;
  const laneCount = Math.max(1, Math.min(limit, queue.length));
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < laneCount; i += 1) {
    lanes.push((async () => {
      while (cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        if (item !== undefined) await worker(item);
      }
    })());
  }
  await Promise.all(lanes);
}
