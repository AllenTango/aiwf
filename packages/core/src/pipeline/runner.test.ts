/**
 * pipeline runner 集成测试(内联 Fake,不 import engine/infra 真实实现):
 * 五阶段事件、依赖拓扑、maxParallel、失败传播、物化与提交、冲突降级、dry-run。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type {
  Engine,
  EngineConfig,
  GitOps,
  LogLevel,
  Logger,
  MemberContext,
  PipelineEvent,
  PipelineStage,
  PlanRequest,
  PlanTask,
  PlatformClient,
  PullRequestHandle,
  PullRequestPayload,
  TaskInput,
  TaskResult,
  WorkflowConfig,
  WorkflowPlan,
} from '../contracts/index.js';
import { createWorkflowRunner } from './runner.js';

// infra 由 M2 并行开发中:测试通过 mock 隔离,不加载真实实现
const mockBuildRepoContext = vi.hoisted(() =>
  vi.fn(async (rootDir: string) => ({
    rootDir,
    branch: 'main',
    treePreview: '(fake tree preview)',
    keyFiles: [],
  })),
);
vi.mock('../infra/index.js', () => ({ buildRepoContext: mockBuildRepoContext }));

// ------------------------------------------------------------------- fakes

class FakeGitOps implements GitOps {
  readonly ops: string[] = [];
  readonly currentBranchCalls: string[] = [];
  readonly commits: { dir: string; message: string }[] = [];
  readonly merges: { receiveDir: string; branch: string }[] = [];
  readonly removedWorktrees: string[] = [];
  readonly branchDirByBranch = new Map<string, string>();
  /** commitAll 时提交,提交后的快照(模拟 git 状态)。 */
  private readonly snapshotsByDir = new Map<string, Map<string, string>>();
  /** 命中的分支在 mergeBranch 时抛冲突(模拟 git 冲突)。 */
  conflicted = new Set<string>();
  commitAllCount = 0;

  async currentBranch(dir: string): Promise<string> {
    this.currentBranchCalls.push(dir);
    this.ops.push('currentBranch');
    return 'main';
  }

  async ensureWorktree(rootDir: string, branch: string): Promise<string> {
    this.ops.push(`ensureWorktree:${branch}`);
    const dir = path.join(rootDir, '.aiwf-worktrees', branch.replace(/[^a-zA-Z0-9._-]+/g, '_'));
    await mkdir(dir, { recursive: true });
    this.branchDirByBranch.set(branch, dir);
    this.snapshotsByDir.set(dir, await listFiles(dir));
    return dir;
  }

  /** 无变更(与快照一致)→ 跳过,不产生提交;有变更 → 记录提交。 */
  async commitAll(dir: string, message: string): Promise<void> {
    this.ops.push(`commitAll:${message}`);
    this.commitAllCount += 1;
    const before = this.snapshotsByDir.get(dir);
    if (before === undefined) throw new Error(`unknown worktree dir: ${dir}`);
    const after = await listFiles(dir);
    if (sameFiles(before, after)) return;
    this.snapshotsByDir.set(dir, after);
    this.commits.push({ dir, message });
  }

  async diffStat(dir: string, taskId: string, must: string): Promise<string> {
    return `dir=${dir} task=${taskId} must=${must}`;
  }

  async mergeBranch(receiveDir: string, branch: string): Promise<void> {
    this.ops.push(`merge:${branch}`);
    if (this.conflicted.has(branch)) {
      throw new Error(`CONFLICT (content): Merge conflict in ${branch}-conflict.txt`);
    }
    this.merges.push({ receiveDir, branch });
  }

  async removeWorktree(rootDir: string, worktreeDir: string): Promise<void> {
    this.ops.push('removeWorktree');
    this.removedWorktrees.push(worktreeDir);
  }

  async pushBranch(rootDir: string, branch: string, remote?: string): Promise<void> {
    this.ops.push(`pushBranch:${branch}:${remote ?? ''}`);
  }
}

function makeEngine(spec: {
  plan: WorkflowPlan;
  execute?: (ctx: MemberContext) => Promise<TaskResult> | TaskResult;
}): { engine: Engine; planCalls: PlanRequest[]; executeCalls: MemberContext[]; configs: EngineConfig[] } {
  const planCalls: PlanRequest[] = [];
  const executeCalls: MemberContext[] = [];
  const configs: EngineConfig[] = [];
  const engine: Engine = {
    kind: 'mock',
    async plan(req, cfg) {
      planCalls.push(req);
      configs.push(cfg);
      return spec.plan;
    },
    async executeTask(ctx, cfg) {
      executeCalls.push(ctx);
      configs.push(cfg);
      if (spec.execute !== undefined) return await spec.execute(ctx);
      return completedFor(ctx.task.id);
    },
  };
  return { engine, planCalls, executeCalls, configs };
}

function completedFor(taskId: string, over: Partial<TaskResult> = {}): TaskResult {
  return { taskId, status: 'completed', summary: `done:${taskId}`, changedFiles: [], notes: [], ...over };
}

class FakePlatform implements PlatformClient {
  readonly payloads: PullRequestPayload[] = [];
  async fetchTask(ref: string): Promise<TaskInput> {
    void ref;
    throw new Error('pipeline 不应调用 fetchTask');
  }
  async createPullRequest(payload: PullRequestPayload): Promise<PullRequestHandle> {
    this.payloads.push(payload);
    return { number: 7, url: 'https://git.local/pr/7' };
  }
}

function captureLogger(): { logger: Logger; lines: { level: LogLevel; message: string }[] } {
  const lines: { level: LogLevel; message: string }[] = [];
  const push =
    (level: LogLevel) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  const logger: Logger = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
  return { logger, lines };
}

// ------------------------------------------------------------------ helpers

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function planTask(id: string, dependsOn: string[] = [], title = `标题-${id}`): PlanTask {
  return { id, title, role: 'implementer', instructions: `执行 ${id}`, dependsOn, expectedOutputs: [] };
}

function makePlan(tasks: PlanTask[], summary = '队长计划摘要', risks: string[] = ['risk-one']): WorkflowPlan {
  return { summary, tasks, risks };
}

const TASK: TaskInput = {
  source: 'issue',
  ref: 'org/repo#42',
  title: '重构登录模块',
  body: '实现全新的登录流程,含单测。',
  comments: ['注意向后兼容'],
};

function stagesOf(events: readonly PipelineEvent[]): PipelineStage[] {
  const out: PipelineStage[] = [];
  for (const e of events) {
    if (e.type === 'stage') out.push(e.stage);
  }
  return out;
}

// -------------------------------------------------------------- harness env

let tempRoot = '';

beforeEach(async () => {
  mockBuildRepoContext.mockClear();
  tempRoot = await mkdtemp(path.join(tmpdir(), 'aiwf-runner-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

interface HarnessParts {
  engine: Engine;
  git: FakeGitOps;
  platform: FakePlatform;
  extra?: Partial<Pick<WorkflowConfig, 'maxParallel' | 'dryRun' | 'engineConfig' | 'branchPrefix'>>;
  onEvent?: (event: PipelineEvent) => void;
}

function buildHarness(parts: HarnessParts): {
  config: WorkflowConfig;
  events: PipelineEvent[];
  logLines: { level: LogLevel; message: string }[];
} {
  const events: PipelineEvent[] = [];
  const { logger, lines } = captureLogger();
  const extra = parts.extra ?? {};
  const config: WorkflowConfig = {
    engine: parts.engine,
    platform: parts.platform,
    git: parts.git,
    repoDir: tempRoot,
    branchPrefix: extra.branchPrefix ?? 'aiwf/',
    maxParallel: extra.maxParallel,
    dryRun: extra.dryRun,
    engineConfig: extra.engineConfig,
    logger,
    onEvent: (event) => {
      events.push(event);
      parts.onEvent?.(event);
    },
  };
  return { config, events, logLines: lines };
}

// -------------------------------------------------------------------- tests

describe('runner 五阶段主流程', () => {
  it('五个阶段按序发 stage 事件;stageHistory 与事件一致;PR 被创建', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({ plan: makePlan([planTask('t1'), planTask('t2', ['t1'])]) });
    const platform = new FakePlatform();
    const { config, events } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    const stageTypes = stagesOf(events);
    expect(stageTypes).toEqual(['ingest', 'plan', 'dispatch', 'synthesize', 'deliver']);
    expect(result.stageHistory.map((h) => h.stage)).toEqual(stageTypes);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.deliverable.pullRequest?.number).toBe(7);
    expect(result.deliverable.branch).toBe(platform.payloads[0]?.headBranch);
  });

  it('ingest:以 repoDir 构建仓库上下文并喂给 plan;baseBranch 来自 git.currentBranch', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({ plan: makePlan([planTask('t1')]) });
    const platform = new FakePlatform();
    const { config, logLines } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    expect(mockBuildRepoContext).toHaveBeenCalledWith(tempRoot);
    expect(fe.planCalls[0]?.repo.rootDir).toBe(tempRoot);
    expect(fe.planCalls[0]?.repo.branch).toBe('main');
    expect(git.currentBranchCalls).toEqual([tempRoot]);
    expect(platform.payloads[0]?.baseBranch).toBe('main');
    expect(platform.payloads[0]?.reportComment).toBe(result.deliverable.summary);
    // 日志通道只镜像 log 类事件;stage 事件属展示层,由 onEvent 承载。
    expect(logLines.some((l) => l.message.includes('[ingest] 构建仓库上下文'))).toBe(true);
  });

  it('依赖序:t2 总在 t1 之后,t3 总在 t2 之后', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({
      plan: makePlan([planTask('t1'), planTask('t2', ['t1']), planTask('t3', ['t2'])]),
    });
    const platform = new FakePlatform();
    const { config } = buildHarness({ engine: fe.engine, git, platform });
    await createWorkflowRunner(config).run(TASK);

    const ids = fe.executeCalls.map((c) => c.task.id);
    expect(ids).toEqual(['t1', 't2', 't3']);
  });

  it('并发上限:6 个独立任务、maxParallel=2 → 峰值并发恰为 2 且不超限', async () => {
    const git = new FakeGitOps();
    let active = 0;
    let peak = 0;
    const fe = makeEngine({
      plan: makePlan(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => planTask(id))),
      execute: async (ctx) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(20);
        active -= 1;
        return completedFor(ctx.task.id);
      },
    });
    const platform = new FakePlatform();
    const { config } = buildHarness({ engine: fe.engine, git, platform, extra: { maxParallel: 2 } });
    await createWorkflowRunner(config).run(TASK);

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
    expect(fe.executeCalls).toHaveLength(6);
  });

  it('失败传播:失败任务的所有后继(直接/间接)被合成为 skipped 结果,不再进入引擎', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({
      plan: makePlan([
        planTask('t1'),
        planTask('t2', ['t1']),
        planTask('t3', ['t2']),
        planTask('free'),
      ]),
      execute: async (ctx) => {
        if (ctx.task.id === 't1') {
          return { taskId: 't1', status: 'failed', summary: 'boom', changedFiles: [], notes: [], error: 'boom' };
        }
        return completedFor(ctx.task.id);
      },
    });
    const platform = new FakePlatform();
    const { config, events } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    // t1 与 free 同层并行,顺序不敏感;被跳过的 t2/t3 绝不进入引擎
    const executedIds = fe.executeCalls.map((c) => c.task.id).sort();
    expect(executedIds).toEqual(['free', 't1']);
    const byId = new Map(result.deliverable.taskResults.map((r) => [r.taskId, r] as const));
    expect(byId.get('t2')?.status).toBe('failed');
    expect(byId.get('t2')?.error).toBe('skipped: dependency t1 failed');
    expect(byId.get('t2')?.notes.join('\n')).toContain('依赖 t1 失败');
    expect(byId.get('t3')?.status).toBe('failed');
    expect(byId.get('t3')?.error).toBe('skipped: dependency t2 failed');
    expect(byId.get('free')?.status).toBe('completed');
    // 跳过任务没有 task-dispatch 事件,但有 task-result 事件
    const dispatchIds = events
      .filter((e) => e.type === 'task-dispatch')
      .map((e) => (e.type === 'task-dispatch' ? e.taskId : ''))
      .sort();
    expect(dispatchIds).toEqual(['free', 't1']);
    expect(events.some((e) => e.type === 'task-result' && e.result.taskId === 't3')).toBe(true);
    // 流程闭环:PR 依旧交付
    expect(result.deliverable.pullRequest).toBeDefined();
  });
});

describe('物化与提交', () => {
  it('changedFiles 逐条物化:add/modify 写盘、delete 删除;越界与缺 content 记 skip 并降级 partial', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({
      plan: makePlan([planTask('t1', [], '实现特性 A')]),
      execute: async () => ({
        taskId: 't1',
        status: 'completed',
        summary: 's',
        notes: [],
        changedFiles: [
          { path: 'src/feature.ts', action: 'add', content: 'export const A = 1;\n' },
          { path: 'docs/guide.md', action: 'modify', content: '# guide' },
          { path: 'legacy/old.txt', action: 'delete' },
          { path: '../escape.ts', action: 'add', content: 'nope' },
          { path: 'missing-content.ts', action: 'add' },
        ],
      }),
    });
    const platform = new FakePlatform();
    const { config } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    const wt = git.branchDirByBranch.get('aiwf/t1');
    expect(wt).toBeDefined();
    expect(await readFile(path.join(wt ?? '', 'src/feature.ts'), 'utf8')).toBe('export const A = 1;\n');
    expect(await readFile(path.join(wt ?? '', 'docs/guide.md'), 'utf8')).toBe('# guide');
    await expect(readFile(path.join(wt ?? '', 'legacy/old.txt'), 'utf8')).rejects.toThrow();

    const r = result.deliverable.taskResults[0];
    expect(r?.status).toBe('partial');
    expect(r?.notes.join('\n')).toContain('../escape.ts');
    expect(r?.notes.join('\n')).toContain('missing-content.ts');
    expect(git.commits.map((c) => c.message)).toEqual(['[aiwf] t1: 实现特性 A']);
  });

  it('空变更不提交:commitAll 仍被调用一次,但实现内部跳过 → 无实际提交', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({ plan: makePlan([planTask('t1')]) });
    const platform = new FakePlatform();
    const { config } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    expect(git.commitAllCount).toBe(1);
    expect(git.commits).toEqual([]);
    expect(result.deliverable.taskResults[0]?.status).toBe('completed');
  });

  it('executeTask 抛错 → 合成 failed 结果,run 不中断,后继被跳过', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({
      plan: makePlan([planTask('t1'), planTask('t2', ['t1'])]),
      execute: async () => {
        throw new Error('engine crashed');
      },
    });
    const platform = new FakePlatform();
    const { config, logLines } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    const byId = new Map(result.deliverable.taskResults.map((r) => [r.taskId, r] as const));
    expect(byId.get('t1')?.status).toBe('failed');
    expect(byId.get('t1')?.error).toBe('engine crashed');
    expect(byId.get('t2')?.error).toBe('skipped: dependency t1 failed');
    expect(result.deliverable.pullRequest).toBeDefined();
    expect(logLines.some((l) => l.level === 'error' && l.message.includes('engine crashed'))).toBe(true);
  });
});

describe('合成与交付', () => {
  it('合并冲突 → 记录冲突文件并继续其余成员分支;summary/PR 正文体现冲突,状态 partial', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({
      plan: makePlan([planTask('t1'), planTask('t2', [], '标题-t2')]),
      execute: async (ctx) =>
        completedFor(ctx.task.id, {
          changedFiles: [{ path: `${ctx.task.id}-out.txt`, action: 'add', content: 'ok' }],
        }),
    });
    git.conflicted.add('aiwf/t2');
    const platform = new FakePlatform();
    const { config } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    expect(git.merges.map((m) => m.branch)).toEqual(['aiwf/t1']);
    const summary = result.deliverable.summary;
    expect(summary).toContain('合并冲突');
    expect(summary).toContain('aiwf/t2-conflict.txt');
    expect(summary).toContain('**partial**');
    expect(summary).toContain('✔ completed'); // 成员任务本身不受冲突影响
    const pr = platform.payloads[0];
    expect(pr?.body).toContain('aiwf/t2-conflict.txt');
    // 成员工作树(2)+ 交付工作树(1)全部清理
    expect(git.removedWorktrees).toHaveLength(3);
    expect(result.deliverable.pullRequest).toBeDefined();
  });

  it('空计划:无成员任务 → 直接合成并创建 PR,summary 标注无成员任务', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({ plan: makePlan([]) });
    const platform = new FakePlatform();
    const { config, events } = buildHarness({ engine: fe.engine, git, platform });
    const result = await createWorkflowRunner(config).run(TASK);

    expect(fe.executeCalls).toEqual([]);
    expect(git.merges).toEqual([]);
    expect(platform.payloads).toHaveLength(1);
    expect(result.deliverable.summary).toContain('没有成员任务');
    expect(result.deliverable.pullRequest).toEqual({ number: 7, url: 'https://git.local/pr/7' });
    const deliverEvent = events.at(-1);
    expect(deliverEvent?.type).toBe('deliver');
  });
});

describe('事件与配置', () => {
  it('事件序列:首事件是 ingest stage;plan 事件夹在 stage(plan/dispatch)之间;dispatch 先于对应 task-result;末事件为 deliver', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({ plan: makePlan([planTask('t1'), planTask('t2', ['t1'])]) });
    const platform = new FakePlatform();
    const { config, events } = buildHarness({ engine: fe.engine, git, platform });
    await createWorkflowRunner(config).run(TASK);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('stage');
    expect(types[1]).toBe('log');
    expect(events[0]?.type === 'stage' && events[0].stage).toBe('ingest'); // 第一个必是 ingest
    const planIdx = types.indexOf('plan');
    const dispatchStageIdx = events.findIndex((e) => e.type === 'stage' && e.stage === 'dispatch');
    expect(planIdx).toBeGreaterThan(events.findIndex((e) => e.type === 'stage' && e.stage === 'plan'));
    expect(planIdx).toBeLessThan(dispatchStageIdx);

    for (const taskId of ['t1', 't2']) {
      const dIdx = events.findIndex((e) => e.type === 'task-dispatch' && e.taskId === taskId);
      const rIdx = events.findIndex((e) => e.type === 'task-result' && e.result.taskId === taskId);
      expect(dIdx).toBeGreaterThan(-1);
      expect(rIdx).toBeGreaterThan(dIdx);
    }
    const last = events.at(-1);
    expect(last?.type).toBe('deliver');
    if (last?.type === 'deliver') {
      expect(last.deliverable.pullRequest?.number).toBe(7);
      expect(last.deliverable.plan.tasks).toHaveLength(2);
    }
  });

  it('engineConfig 与默认值合并后传给 engine(kind 来自 engine 实例、默认 timeout 600s)', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({ plan: makePlan([planTask('t1')]) });
    const platform = new FakePlatform();
    const { config } = buildHarness({
      engine: fe.engine,
      git,
      platform,
      extra: { engineConfig: { model: 'test/model-x', extraArgs: ['--verbose'] } },
    });
    await createWorkflowRunner(config).run(TASK);

    const cfg = fe.configs[0];
    expect(cfg?.kind).toBe('mock');
    expect(cfg?.model).toBe('test/model-x');
    expect(cfg?.extraArgs).toEqual(['--verbose']);
    expect(cfg?.timeoutMs).toBe(600_000);
  });
});

describe('dry-run 与规划失败', () => {
  it('dry-run:不执行任务、不建工作树、不发 PR;branch 为空、summary 含 (dry-run)、stage 为 ingest/plan/deliver', async () => {
    const git = new FakeGitOps();
    const fe = makeEngine({ plan: makePlan([planTask('t1'), planTask('t2', ['t1'])]) });
    const platform = new FakePlatform();
    const { config, events } = buildHarness({ engine: fe.engine, git, platform, extra: { dryRun: true } });
    const result = await createWorkflowRunner(config).run(TASK);

    expect(fe.executeCalls).toEqual([]);
    expect(git.ops.some((op) => op.startsWith('ensureWorktree'))).toBe(false);
    expect(platform.payloads).toEqual([]);
    expect(result.deliverable.branch).toBe('');
    expect(result.deliverable.taskResults).toEqual([]);
    expect(result.deliverable.summary).toContain('(dry-run)');
    expect(result.stageHistory.map((h) => h.stage)).toEqual(['ingest', 'plan', 'deliver']);
    const deliverEvent = events.at(-1);
    expect(deliverEvent?.type).toBe('deliver');
    if (deliverEvent?.type === 'deliver') {
      expect(deliverEvent.deliverable.plan.tasks).toHaveLength(2);
      expect(deliverEvent.deliverable.pullRequest).toBeUndefined();
    }
  });

  it('计划校验失败:重复 ID / 缺失依赖 / 环 → 以中文错误抛出,并先发 error 日志事件', async () => {
    const cases: Array<{ plan: WorkflowPlan; message: string }> = [
      { plan: makePlan([planTask('t1'), planTask('t1', [], 'dup')]), message: '任务 id 重复' },
      { plan: makePlan([planTask('t2', ['ghost'])]), message: '依赖了不存在的任务:「ghost」' },
      { plan: makePlan([planTask('a', ['b']), planTask('b', ['a'])]), message: '存在环' },
    ];
    for (const c of cases) {
      const git = new FakeGitOps();
      const fe = makeEngine({ plan: c.plan });
      const platform = new FakePlatform();
      const { config, events } = buildHarness({ engine: fe.engine, git, platform });
      const runner = createWorkflowRunner(config);
      await expect(runner.run(TASK)).rejects.toThrow(c.message);
      expect(platform.payloads).toEqual([]);
      expect(events.some((e) => e.type === 'log' && e.level === 'error')).toBe(true);
    }
  });
});

// -------------------------------------------------------------- 文件快照工具

async function listFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await walk(dir, out);
  return out;
}

async function walk(dir: string, out: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else {
      out.set(p, await readFile(p, 'utf8'));
    }
  }
}

function sameFiles(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}
