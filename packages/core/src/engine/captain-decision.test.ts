/**
 * 队长的「决策权 + 成本视野」专项测试(裁决解析 / 预算回喂 / 分模型指派 / 准则注入)。
 *
 * 与 opencode.test.ts 分文件,避免该文件过长。
 */

import { describe, expect, it } from 'vitest';

import { buildPlanPrompt, buildTaskPrompt, parsePlanJson } from './opencode.js';
import type { MemberContext, PlanRequest } from '../contracts/index.js';

const repoContext = {
  rootDir: 'E:/demo',
  branch: 'main',
  treePreview: '# repo 文件树\nsrc/\n  index.ts',
  keyFiles: [],
};

function planRequest(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    task: {
      source: 'issue',
      ref: 'acme/app#42',
      title: '支持导出 CSV',
      body: '导出模块需要支持 CSV 格式。',
    },
    repo: repoContext,
    ...overrides,
  };
}

function memberContext(over: Partial<MemberContext> = {}): MemberContext {
  return {
    worktreeDir: 'E:/wt',
    branch: 'aiwf/t1',
    repo: repoContext,
    plan: { summary: '计划摘要', tasks: [], risks: [] },
    task: {
      id: 't1',
      title: '任务一',
      role: 'implementer',
      instructions: '写实现',
      dependsOn: [],
      expectedOutputs: [],
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 裁决解析
// ---------------------------------------------------------------------------

describe('parsePlanJson — 裁决', () => {
  it('缺省 verdict → proceed(兼容旧计划)', () => {
    const plan = parsePlanJson(
      JSON.stringify({
        summary: 's',
        tasks: [{ id: 't1', title: 't', instructions: 'i', dependsOn: [], expectedOutputs: [] }],
      }),
    );
    expect(plan.verdict).toBe('proceed');
  });

  it('verdict=reject 且 tasks 为空 → 合法(队长的裁决就是「不开工」)', () => {
    const plan = parsePlanJson(
      JSON.stringify({
        verdict: 'reject',
        rationale: '该需求与既有实现重复,不值得单开一次开发',
        summary: '不建议开发',
        tasks: [],
        risks: [],
      }),
    );
    expect(plan.verdict).toBe('reject');
    expect(plan.rationale).toContain('重复');
    expect(plan.tasks).toEqual([]);
  });

  it('verdict=need_clarification → clarifications 被解析', () => {
    const plan = parsePlanJson(
      JSON.stringify({
        verdict: 'need_clarification',
        rationale: '验收标准缺失',
        summary: '需要澄清',
        clarifications: ['CSV 字段顺序由谁决定?', '编码要支持 GBK 吗?'],
        tasks: [],
      }),
    );
    expect(plan.verdict).toBe('need_clarification');
    expect(plan.clarifications).toHaveLength(2);
  });

  it('verdict 非法 → 解析失败并给出中文错误', () => {
    expect(() =>
      parsePlanJson(JSON.stringify({ verdict: 'maybe', summary: 's', tasks: [] })),
    ).toThrow(/verdict/);
  });

  it('verdict=proceed 但 tasks 为空 → 报错并提示改用 reject/need_clarification', () => {
    expect(() => parsePlanJson(JSON.stringify({ verdict: 'proceed', summary: 's', tasks: [] }))).toThrow(
      /need_clarification/,
    );
  });

  it('analysis 与 cost 被解析', () => {
    const plan = parsePlanJson(
      JSON.stringify({
        summary: 's',
        tasks: [{ id: 't1', title: 't', instructions: 'i', dependsOn: [], expectedOutputs: [], weight: 'high' }],
        analysis: { understanding: '导出模块现状', affectedAreas: ['src/export'], risks: ['r1'] },
        cost: {
          weight: 'high',
          expectedCalls: 2,
          units: 8,
          reason: '跨模块重构',
          breakdown: [{ taskId: 't1', model: 'worker', weight: 'high', units: 8 }],
        },
      }),
    );
    expect(plan.analysis?.understanding).toBe('导出模块现状');
    expect(plan.analysis?.affectedAreas).toEqual(['src/export']);
    expect(plan.cost?.units).toBe(8);
    expect(plan.cost?.breakdown?.[0]?.model).toBe('worker');
    expect(plan.tasks[0]?.weight).toBe('high');
  });

  it('任务级 weight / model / guidelines 被解析;非法 weight 报错', () => {
    const plan = parsePlanJson(
      JSON.stringify({
        summary: 's',
        tasks: [
          {
            id: 't1',
            title: 't',
            instructions: 'i',
            dependsOn: [],
            expectedOutputs: [],
            weight: 'low',
            model: 'worker',
            guidelines: ['只改 src/'],
          },
        ],
      }),
    );
    expect(plan.tasks[0]?.weight).toBe('low');
    expect(plan.tasks[0]?.model).toBe('worker');
    expect(plan.tasks[0]?.guidelines).toEqual(['只改 src/']);

    expect(() =>
      parsePlanJson(
        JSON.stringify({
          summary: 's',
          tasks: [{ id: 't1', title: 't', instructions: 'i', dependsOn: [], expectedOutputs: [], weight: 'huge' }],
        }),
      ),
    ).toThrow(/weight/);
  });
});

// ---------------------------------------------------------------------------
// 预算回喂:队长必须看到预算,否则无从做成本权衡
// ---------------------------------------------------------------------------

describe('buildPlanPrompt — 预算与模型池', () => {
  it('无 budget → 不出现预算段落(老行为)', () => {
    const p = buildPlanPrompt(planRequest());
    expect(p).not.toContain('# 本次预算与编制约束');
  });

  it('有 budget → 出现编制上限、并行上限、墙钟预算、成本预算与成本口径', () => {
    const p = buildPlanPrompt(
      planRequest({
        budget: {
          maxTasks: 4,
          maxParallel: 2,
          wallClockBudgetMs: 900_000,
          budgetUnits: 12,
          remainingRuns: 7,
        },
      }),
    );
    expect(p).toContain('# 本次预算与编制约束');
    expect(p).toContain('编制人数上限:4');
    expect(p).toContain('并行上限:2');
    expect(p).toContain('900 秒');
    expect(p).toContain('今日剩余可运行次数:7');
    expect(p).toContain('成本预算上限:12 单位');
    expect(p).toContain('low=1 单位');
  });

  it('模型池 → 列出可指派的角色与模型', () => {
    const p = buildPlanPrompt(
      planRequest({
        budget: {
          maxTasks: 4,
          maxParallel: 2,
          modelPool: { worker: 'opencode/glm-5.3', reviewer: 'minimax/MiniMax-M3.1-Flash' },
        },
      }),
    );
    expect(p).toContain('worker → opencode/glm-5.3');
    expect(p).toContain('reviewer → minimax/MiniMax-M3.1-Flash');
  });

  it('含裁决准则:说明何时 reject / need_clarification,以及「不要无条件开工」', () => {
    const p = buildPlanPrompt(planRequest());
    expect(p).toContain('# 裁决准则');
    expect(p).toContain('不要无条件开工');
    expect(p).toContain('need_clarification');
    expect(p).toContain('"verdict"');
    expect(p).toContain('"weight"');
    expect(p).toContain('"model"');
  });
});

// ---------------------------------------------------------------------------
// 队员:施工前行为准则
// ---------------------------------------------------------------------------

describe('buildTaskPrompt — 行为准则', () => {
  it('无准则来源 → 仍出现内置默认准则', () => {
    const p = buildTaskPrompt(memberContext());
    expect(p).toContain('# 行为准则');
    expect(p).toContain('行为准则(内置默认)');
  });

  it('人类准则与队长按任务追加的准则都进入 prompt', () => {
    const p = buildTaskPrompt(
      memberContext({
        guidelines: ['提交前必须跑 pnpm test'],
        task: {
          id: 't1',
          title: 't',
          role: 'implementer',
          instructions: 'i',
          dependsOn: [],
          expectedOutputs: [],
          guidelines: ['只改 src/export/**'],
        },
      }),
    );
    expect(p).toContain('提交前必须跑 pnpm test');
    expect(p).toContain('只改 src/export/**');
    expect(p).toContain('行为准则(仓库配置,必须遵守)');
    expect(p).toContain('行为准则(本任务专项要求)');
  });
});
