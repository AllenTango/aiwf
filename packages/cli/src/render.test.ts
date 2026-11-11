import { describe, expect, it } from 'vitest';
import type {
  PipelineEvent,
  PipelineStage,
  RunResult,
  TaskResult,
  WorkflowPlan,
} from '@aiwf/core';
import { plainPalette } from './render.js';
import {
  PIPELINE_STAGES,
  depthOfTask,
  renderEvent,
  renderFinalReport,
  renderLogLine,
  renderPlan,
  renderStageBanner,
  renderTaskResult,
  summarizeStatus,
} from './render.js';
import { buildLocalHandoffBody } from './local-platform.js';

const P = plainPalette;
const plan: WorkflowPlan = {
  summary: '拆分为三步:实现 → 打磨 → 打包',
  tasks: [
    {
      id: 'T1',
      title: '实现登录页',
      role: 'implementer',
      instructions: 'do it',
      dependsOn: [],
      expectedOutputs: ['src/login.tsx'],
    },
    {
      id: 'T1b',
      title: '打磨样式',
      role: 'reviewer',
      instructions: 'polish',
      dependsOn: ['T1'],
      expectedOutputs: ['src/login.css'],
    },
    {
      id: 'T2',
      title: '打包 README',
      role: 'packager',
      instructions: 'package',
      dependsOn: ['T1', 'T1b'],
      expectedOutputs: ['README.md'],
    },
  ],
  risks: ['引擎超时可能截断打包任务'],
};

describe('plan tree (deps drive indentation)', () => {
  it('depths follow the DAG, cycle-safe', () => {
    expect(depthOfTask(plan, 'T1')).toBe(0);
    expect(depthOfTask(plan, 'T1b')).toBe(1);
    expect(depthOfTask(plan, 'T2')).toBe(2);
    expect(depthOfTask(plan, 'ghost')).toBe(0);
  });

  it('renders summary, roles, outputs, deps and risks', () => {
    const lines = renderPlan(plan, P);
    const text = lines.join('\n');
    expect(text).toContain('队长计划');
    expect(text).toContain(plan.summary);
    expect(text).toContain('● T1 · 实现登录页');
    expect(text).toContain('[role: reviewer]');
    expect(text).toContain('outputs: src/login.css');
    expect(text).not.toContain('依赖 ...(none)');
    expect(text).toContain('(依赖 T1)');
    expect(text).toContain('(依赖 T1, T1b)');
    expect(text).toContain('⚠ 队长风险提示');
    expect(text).toContain('引擎超时可能截断打包任务');
    // indentation: T2 line carries 2 levels (4 spaces) before its bullet
    const t2Line = lines.find((l) => l.includes('● T2')) as string;
    expect(t2Line.startsWith('    ●')).toBe(true);
    expect(text).toMatchSnapshot();
  });
});

describe('task result marks', () => {
  const mk = (over: Partial<TaskResult>): TaskResult => ({
    taskId: 'T1',
    status: 'completed',
    summary: 'all good',
    changedFiles: [],
    notes: [],
    ...over,
  });

  it('✔ green / △ yellow / ✘ red symbols', () => {
    expect(renderTaskResult(mk({ status: 'completed' }), P)).toContain('✔');
    expect(renderTaskResult(mk({ status: 'partial' }), P)).toContain('△');
    expect(renderTaskResult(mk({ status: 'failed', error: 'boom' }), P)).toContain('✘');
  });

  it('failed result carries its error text', () => {
    expect(
      renderTaskResult(mk({ status: 'failed', error: 'engine timeout' }), P),
    ).toContain('error: engine timeout');
  });
});

describe('stage banners', () => {
  it.each<[PipelineStage, string]>([
    ['ingest', '[1/5 ingest]'],
    ['plan', '[2/5 plan]'],
    ['dispatch', '[3/5 dispatch]'],
    ['synthesize', '[4/5 synthesize]'],
    ['deliver', '[5/5 deliver]'],
  ])('%s → numeric progress line', (stage, expected) => {
    expect(renderStageBanner(stage, P)).toBe(expected);
  });

  it('covers exactly the five contract stages', () => {
    expect(PIPELINE_STAGES).toHaveLength(5);
  });
});

describe('event-driven renderer (all contract event kinds)', () => {
  const at = 0;
  const events: PipelineEvent[] = [
    { type: 'stage', stage: 'ingest', at },
    { type: 'stage', stage: 'plan', at },
    { type: 'plan', plan, at },
    { type: 'task-dispatch', taskId: 'T1', branch: 'aiwf/T1', at },
    { type: 'log', level: 'warn', message: 'careful', at },
    {
      type: 'task-result',
      result: { taskId: 'T1', status: 'completed', summary: 'ok', changedFiles: [], notes: [] },
      at,
    },
    {
      type: 'deliver',
      deliverable: {
        branch: 'aiwf/main-integration',
        summary: 'done',
        plan,
        taskResults: [],
        pullRequest: { number: 3, url: 'https://github.com/o/r/pull/3' },
      },
      at,
    },
  ];

  it('every event type renders at least one line (blank separators allowed)', () => {
    for (const event of events) {
      const lines = renderEvent(event, P);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((line) => typeof line === 'string')).toBe(true);
    }
  });

  it('specific content assertions', () => {
    const dispatch = renderEvent(events[3] as PipelineEvent, P).join('\n');
    expect(dispatch).toContain('分派 T1');
    expect(dispatch).toContain('aiwf/T1');

    const logLine = renderLogLine('warn', 'careful', P);
    expect(logLine).toContain('[warn]');

    const deliver = renderEvent(events[6] as PipelineEvent, P).join('\n');
    expect(deliver).toContain('交付 aiwf/main-integration');
    expect(deliver).toContain('PR #3');
  });
});

describe('closing report box (结项报告)', () => {
  const base: RunResult = {
    deliverable: {
      branch: 'aiwf/issue-1',
      summary: 'team done',
      plan,
      taskResults: [],
      pullRequest: undefined,
    },
    stageHistory: [
      { stage: 'ingest', at: 1 },
      { stage: 'plan', at: 2 },
    ],
    durationMs: 2500,
  };
  const tr = (status: TaskResult['status']): TaskResult => ({
    taskId: `T-${status}`,
    status,
    summary: `member ${status}`,
    changedFiles: [],
    notes: [],
  });

  it('✅ success with a real PR', () => {
    const run: RunResult = {
      ...base,
      deliverable: {
        ...base.deliverable,
        taskResults: [tr('completed'), tr('completed')],
        pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12' },
      },
    };
    expect(summarizeStatus(run.deliverable.taskResults)).toEqual({
      icon: '✅',
      label: '成功(全部成员完成)',
    });
    const text = renderFinalReport(run, {}, P);
    expect(text).toContain('✅');
    expect(text).toContain('PR #12');
    expect(text).toContain('https://github.com/o/r/pull/12');
    expect(text).toContain('2.5s');
    expect(text).toContain('ingest → plan');
    expect(text).toMatchSnapshot();
  });

  it('⚠️ partial when mixed statuses, with notes rendered', () => {
    const run: RunResult = {
      ...base,
      deliverable: {
        ...base.deliverable,
        taskResults: [tr('completed'), tr('partial')],
      },
    };
    expect(summarizeStatus(run.deliverable.taskResults).icon).toBe('⚠️');
    const text = renderFinalReport(run, { notes: ['local-delivery'] }, P);
    expect(text).toContain('⚠️');
    expect(text).toContain('备注');
    expect(text).toContain('local-delivery');
    expect(text).toContain('本地交付');
  });

  it('❌ when every member failed', () => {
    const run: RunResult = {
      ...base,
      deliverable: { ...base.deliverable, taskResults: [tr('failed')] },
    };
    expect(summarizeStatus(run.deliverable.taskResults).icon).toBe('❌');
    expect(renderFinalReport(run, {}, P)).toContain('❌');
  });

  it('dry-run (no member results) is labelled explicitly', () => {
    const text = renderFinalReport(base, {}, P);
    expect(text).toContain('dry-run · 仅产出计划');
    expect(text).toContain('无 — dry-run 或计划为空');
  });

  it('local delivery (PR number -1) shows the local-delivery hint', () => {
    const run: RunResult = {
      ...base,
      deliverable: {
        ...base.deliverable,
        taskResults: [tr('completed')],
        pullRequest: { number: -1, url: '' },
      },
    };
    expect(renderFinalReport(run, {}, P)).toContain('本地交付');
  });
});

describe('local handoff body snapshot', () => {
  it('branch push instructions + manual manifest hints', () => {
    const text = buildLocalHandoffBody({
      branch: 'aiwf/quick-fix',
      base: 'develop',
      reason: 'push-failed',
    });
    expect(text).toContain('aiwf/quick-fix');
    expect(text).toContain('git push -u origin aiwf/quick-fix');
    expect(text).toContain('gh pr create --head aiwf/quick-fix --base develop');
    expect(text).toMatchSnapshot();
  });
});
