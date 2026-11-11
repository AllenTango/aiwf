/**
 * 核心工作流流水线(M1):ingest → plan → dispatch → synthesize → deliver。
 *
 * - 每个阶段开头先发 `{ type: 'stage' }` 事件;所有事件同时喂 onEvent 与 logger。
 * - 成员级失败绝不抛出:一律呈现为 TaskResult{status:'failed'} 并按依赖传播跳过;
 * - 流水线级失败(仓库上下文构建、规划/校验、交付)允许抛出——任务无法继续。
 * - dry-run:只跑 ingest/plan/deliver,零副作用,summary 含 "(dry-run)"。
 */

import type {
  Deliverable,
  Engine,
  EngineConfig,
  EventSink,
  Logger,
  LogLevel,
  PipelineEvent,
  PipelineStage,
  PlanTask,
  RunResult,
  TaskInput,
  TaskResult,
  TaskStatus,
  WorkflowConfig,
  WorkflowPlan,
  WorkflowRunner,
} from '../contracts/index.js';
import { buildRepoContext } from '../infra/index.js';
import { validatePlan, topoLayers, flattenTopo } from './plan-utils.js';
import { deliverBranchName, taskBranchName, uniqueBranchName } from './branch-name.js';
import { materializeChangedFiles } from './materialize.js';
import { buildDeliverSummary, overallStatus, parseConflictFiles, type MergeConflict } from './summary.js';
import { buildPullRequestBody } from './pull-request-body.js';

const DEFAULT_BRANCH_PREFIX = 'aiwf/';
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_ENGINE_TIMEOUT_MS = 600_000;

export function createWorkflowRunner(config: WorkflowConfig): WorkflowRunner {
  const logger: Logger = config.logger ?? silentLogger();
  const prefix = config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const maxParallel = Math.max(1, Math.floor(config.maxParallel ?? DEFAULT_MAX_PARALLEL));
  const dryRun = config.dryRun === true;
  const engineConfig = mergeEngineConfig(config.engine, config.engineConfig);

  /** 所有事件统一出口:喂 onEvent,并向 logger 镜像一行可读日志。 */
  const mirrored: EventSink = (event) => {
    config.onEvent?.(event);
    mirrorToLogger(logger, event);
  };
  const log = (level: LogLevel, message: string): void => {
    mirrored({ type: 'log', level, message, at: Date.now() });
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
      const repo = await buildRepoContext(config.repoDir);
      const baseBranch = config.baseBranch?.trim() || await config.git.currentBranch(config.repoDir);
      log('info', `[ingest] baseBranch=${baseBranch}(调度前当前分支);repo.branch=${repo.branch}`);

      // ---------------------------------------------------------------- 2)
      emitStage('plan');
      let plan: WorkflowPlan;
      try {
        plan = await config.engine.plan({ task, repo }, engineConfig);
      } catch (err) {
        const reason = errorMessage(err);
        log('error', `[plan] 引擎规划失败:${reason}`);
        throw new Error(`引擎规划失败:${reason}`);
      }
      try {
        validatePlan(plan);
      } catch (err) {
        const message = errorMessage(err);
        log('error', `[plan] ${message}`);
        throw err instanceof Error ? err : new Error(message);
      }
      mirrored({ type: 'plan', plan, at: Date.now() });
      log('info', `[plan] 计划就绪:${plan.tasks.length} 个任务 — ${plan.summary}`);

      const layers = topoLayers(plan.tasks);
      const order = flattenTopo(plan.tasks);

      // ------------------------------------------------------------- 干跑
      if (dryRun) {
        const summary = buildDeliverSummary({ plan, results: [], conflicts: [], dryRun: true });
        const deliverable: Deliverable = { branch: '', summary, plan, taskResults: [] };
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
          const result = await config.engine.executeTask(
            { worktreeDir, branch, repo, plan, task: pt },
            engineConfig,
          );
          // 物化:changedFiles 逐条落盘(delete→删,add/modify→确保父目录并写)
          const mat = await materializeChangedFiles(worktreeDir, result.changedFiles);
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
          mirrored({ type: 'task-result', result, at: Date.now() });
          log(
            result.status === 'failed' ? 'error' : result.status === 'partial' ? 'warn' : 'info',
            `[dispatch] 任务 ${pt.id} 完成:${result.status} — ${result.error ?? result.summary}`,
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

      const summary = buildDeliverSummary({ plan, results, conflicts, dryRun: false });
      log('info', `[synthesize] 合并完成:成功 ${mergedCount} / 冲突 ${conflicts.length};结项报告已生成(整体状态:${overallStatus(results, conflicts)})`);

      // ---------------------------------------------------------------- 5)
      emitStage('deliver');
      log('info', `[deliver] 创建 PR:head=${deliverBranch} base=${baseBranch}`);
      const deliverable: Deliverable = { branch: deliverBranch, summary, plan, taskResults: results };
      try {
        const pr = await config.platform.createPullRequest({
          title: `[aiwf] ${task.title}`,
          body: buildPullRequestBody(task, plan, results, summary),
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
