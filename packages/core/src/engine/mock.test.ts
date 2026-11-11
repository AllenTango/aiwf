import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MockEngine } from './mock.js';
import type { EngineConfig, MemberContext, PlanRequest, WorkflowPlan } from '../contracts/index.js';

const cfg: EngineConfig = { kind: 'mock' };

const reqBase = (body: string, extra?: Partial<PlanRequest>): PlanRequest => ({
  task: {
    source: 'inline',
    title: '演示需求',
    body,
  },
  repo: { rootDir: 'E:/demo', branch: 'main', treePreview: 'a/\n  b.txt', keyFiles: [] },
  ...extra,
});

/** 构造最小 MemberContext:真实 tmpdir 作为 worktreeDir。 */
async function memberCtxOf(taskId: string, instructions: string, worktreeDir?: string): Promise<{ ctx: MemberContext; dir: string }> {
  const dir = worktreeDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'aiwf-mock-')));
  const req = reqBase('背景');
  const task = {
    id: taskId,
    title: `任务 ${taskId}`,
    role: 'implementer',
    instructions,
    dependsOn: [],
    expectedOutputs: [`mock/${taskId}.md`],
  };
  const ctx: MemberContext = {
    worktreeDir: dir,
    branch: 'aiwf/' + taskId,
    repo: req.repo,
    plan: { summary: 'mock 计划', tasks: [task], risks: [] },
    task,
  };
  return { ctx, dir };
}

describe('MockEngine.plan', () => {
  it('默认产出 t1、t2 两个任务,t2 依赖 t1', async () => {
    const engine = new MockEngine();
    const plan = await engine.plan(reqBase('普通需求'), cfg);
    expect(plan.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(plan.tasks[1]!.dependsOn).toEqual(['t1']);
    expect(plan.tasks[0]!.role).toBe('implementer');
    expect(plan.tasks.every((t) => t.instructions.trim().length > 0)).toBe(true);
    expect(plan.risks.length).toBeGreaterThan(0);
  });

  it('画布含 T3 关键词时产出平行任务 t3(依赖 t1)', async () => {
    const engine = new MockEngine();
    const plan = await engine.plan(reqBase('需求较大,请安排 t3 分支处理'), cfg);
    const ids = plan.tasks.map((x) => x.id);
    expect(ids.sort()).toEqual(['t1', 't2', 't3']);
    const t3 = plan.tasks.find((x) => x.id === 't3')!;
    expect(t3.dependsOn).toEqual(['t1']);
    expect(plan.tasks.find((x) => x.id === 't2')!.dependsOn).toEqual(['t1']);
  });

  it('全局 FAIL 关键词落到 t2 指令;CONFLICT 关键词落到全部任务(含 shared 产出)', async () => {
    const engine = new MockEngine();
    const plan = await engine.plan(reqBase('请给出 2 个任务,注意 FAIL 演练和 CONFLICT 演练'), cfg);
    const t1 = plan.tasks.find((x) => x.id === 't1')!;
    const t2 = plan.tasks.find((x) => x.id === 't2')!;
    expect(t1.instructions).toContain('FAIL');
    expect(t2.instructions).toContain('FAIL');
    expect(t1.instructions).toContain('CONFLICT');
    expect(t2.instructions).toContain('CONFLICT');
    expect(t2.expectedOutputs).toContain('shared/decision.txt');
  });

  it('逐行绑定:t2 提到 PARTIAL 时只影响 t2', async () => {
    const engine = new MockEngine();
    const plan = await engine.plan(reqBase('任务示例:\nt1: 正常实现\nt2: 放开 PARTIAL 演练'), cfg);
    const t1 = plan.tasks.find((x) => x.id === 't1')!;
    const t2 = plan.tasks.find((x) => x.id === 't2')!;
    expect(t1.instructions).not.toContain('PARTIAL');
    expect(t2.instructions).toContain('PARTIAL');
  });

  it('summary 为中文一行', async () => {
    const engine = new MockEngine();
    const plan = await engine.plan(reqBase('无关键词'), cfg);
    expect(plan.summary).toMatch(/mock 计划/);
  });
});

describe('MockEngine.executeTask', () => {
  it('写出 mock/<id>.md(含指令文本),changedFiles 记 add,状态 completed', async () => {
    const { ctx, dir } = await memberCtxOf('t1', '认真实现模块 A');
    const engine = new MockEngine();
    const r = await engine.executeTask(ctx, cfg);
    expect(r.taskId).toBe('t1');
    expect(r.status).toBe('completed');
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain('mock 完成 t1');
    const md = await fs.readFile(path.join(dir, 'mock', 't1.md'), 'utf8');
    expect(md).toContain('认真实现模块 A');
    expect(r.changedFiles).toHaveLength(1);
    expect(r.changedFiles[0]).toMatchObject({ path: 'mock/t1.md', action: 'add' });
    expect(r.changedFiles[0]!.content).toContain('认真实现模块 A');
  });

  it('含 CONFLICT 时额外写 shared/decision.txt', async () => {
    const { ctx, dir } = await memberCtxOf('t2', '按 CONFLICT 语义演练');
    const r = await new MockEngine().executeTask(ctx, cfg);
    expect(r.status).toBe('completed');
    const decision = await fs.readFile(path.join(dir, 'shared', 'decision.txt'), 'utf8');
    expect(decision).toContain('t2');
    expect(r.changedFiles.map((f) => f.path).sort()).toEqual(['mock/t2.md', 'shared/decision.txt']);
  });

  it('失败:指令含 FAIL → status failed + error,changedFiles 不上交', async () => {
    const { ctx, dir } = await memberCtxOf('t1', '这条指令包含 FAIL 关键词');
    const r = await new MockEngine().executeTask(ctx, cfg);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('FAIL');
    expect(r.changedFiles).toEqual([]);
    const md = await fs.readFile(path.join(dir, 'mock', 't1.md'), 'utf8'); // 现场仍在,便于排查
    expect(md).toContain('FAIL');
  });

  it('部分:指令含 PARTIAL → partial', async () => {
    const { ctx } = await memberCtxOf('t3', '完成一半就算 PARTIAL');
    const r = await new MockEngine().executeTask(ctx, cfg);
    expect(r.status).toBe('partial');
    expect(r.error).toBeUndefined();
  });

  it('worktree 路径下被文件占据 → failed(TaskResult 表达,不抛异常)', async () => {
    // 用"文件路径"冒充 worktreeDir:mkdir recursive 会在该处失败(ENOENT/非目录)。
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwf-mock-bad-'));
    const blocker = path.join(base, 'occupied-by-file');
    await fs.writeFile(blocker, 'not a dir', 'utf8');
    const { ctx } = await memberCtxOf('t9', '常规指令', path.join(blocker, 'sub'));
    const r = await new MockEngine().executeTask(ctx, cfg);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('失败');
  });
});
