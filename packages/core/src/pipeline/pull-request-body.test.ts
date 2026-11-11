/** PR 正文构建函数(纯函数)的专项测试:关键段落齐全、top10 截断、跳过过滤。 */

import { describe, expect, it } from 'vitest';
import type { PlanTask, TaskInput, TaskResult, WorkflowPlan } from '../contracts/index.js';
import { buildPullRequestBody } from './pull-request-body.js';

const task: TaskInput = {
  source: 'issue',
  ref: 'org/repo#42',
  title: '重构登录模块',
  body: '实现全新的登录流程,含单测。',
  comments: ['注意向后兼容'],
};

const plan: WorkflowPlan = {
  summary: '分三步走:实现 →  review  → 打包',
  tasks: [
    { id: 't1', title: '实现', role: 'implementer', instructions: 'x', dependsOn: [], expectedOutputs: [] },
    { id: 't2', title: '检查', role: 'reviewer', instructions: 'x', dependsOn: ['t1'], expectedOutputs: [] },
  ],
  risks: ['risk-one', 'risk-two'],
};

function taskPlan(id: string, dependsOn: string[] = []): PlanTask {
  return { id, title: id, role: 'implementer', instructions: 'x', dependsOn, expectedOutputs: [] };
}

const results: TaskResult[] = [
  {
    taskId: 't1',
    status: 'completed',
    summary: '完成实现',
    changedFiles: [
      { path: 'src/a.ts', action: 'add', content: 'a' },
      { path: 'src/b.ts', action: 'modify', content: 'b' },
    ],
    notes: ['精选备注甲', '精选备注甲', '精选备注乙'],
  },
  {
    taskId: 't2',
    status: 'partial',
    summary: 'review 部分完成',
    changedFiles: [],
    notes: ['建议补测试'],
  },
  {
    taskId: 't3',
    status: 'failed',
    summary: '依赖失败,本任务未执行',
    changedFiles: [],
    notes: ['按失败传播策略跳过'],
    error: 'skipped: dependency t2 failed',
  },
];

const deliverableSummary = '## 结项报告\n\n整体状态:**partial**\n\n### 冲突与跳过\n- 跳过:t3 — skipped: dependency t2 failed\n';

describe('buildPullRequestBody', () => {
  it('包含:原始诉求(标题/来源/摘要/补充)、计划概要、任务状态表、风险、备注、结项报告、生成声明', () => {
    const body = buildPullRequestBody(task, plan, results, deliverableSummary);
    expect(body).toContain(`# [aiwf] ${task.title}`);
    expect(body).toContain('## 原始诉求');
    expect(body).toContain('issue(`org/repo#42`)');
    expect(body).toContain('实现全新的登录流程');
    expect(body).toContain('> 注意向后兼容');
    expect(body).toContain('## 计划概要');
    expect(body).toContain(plan.summary);
    expect(body).toContain('## 任务状态');
    expect(body).toContain('| t1 | ✔ completed | 完成实现 |');
    expect(body).toContain('| t3 | ✘ failed | skipped: dependency t2 failed |');
    expect(body).toContain('## 变更文件');
    expect(body).toContain('- `src/a.ts`(add)');
    expect(body).toContain('- `src/b.ts`(modify)');
    expect(body).toContain('**共 2 个文件**');
    expect(body).toContain('## 风险');
    expect(body).toContain('- risk-one');
    expect(body).toContain('- risk-two');
    expect(body).toContain('## 成员备注精选');
    expect(body).toContain('- 精选备注乙');
    expect(body).toContain(deliverableSummary);
    expect(body).toContain('自动生成');
  });

  it('变更文件超过 10 个时:展示前 10 个,列出总数,其余折叠为省略行', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `change-${String(i + 1).padStart(2, '0')}.txt`,
      action: 'add' as const,
      content: 'x',
    }));
    const r: TaskResult[] = [
      { taskId: 't1', status: 'completed', summary: 's', changedFiles: files, notes: [] },
    ];
    const body = buildPullRequestBody(task, plan, r, deliverableSummary);
    expect(body).toContain('**共 12 个文件**');
    expect(body).toContain('- `change-10.txt`(add)');
    expect(body).toContain('……其余 2 个文件略');
    expect(body).not.toContain('change-11.txt');
    expect(body).not.toContain('change-12.txt');
  });

  it('失败(外溢到依赖跳过的)任务的 note 不进入成员备注,但失败事实保留在状态表中', () => {
    const body = buildPullRequestBody(task, plan, results, deliverableSummary);
    expect(body).not.toContain('按失败传播策略跳过:依赖 t2 失败');
    expect(body).toContain('| t3 | ✘ failed |');
  });

  it('空计划/空结果:标注无成员任务、无文件变更、无风险', () => {
    const emptyPlan: WorkflowPlan = { summary: '空', tasks: [], risks: [] };
    const body = buildPullRequestBody(task, emptyPlan, [], '(dry-run)');
    expect(body).toContain('本次运行没有成员任务。');
    expect(body).toContain('无文件变更。');
    expect(body).toContain('无已识别风险。');
    expect(body).toContain('无成员备注。');
    expect(body).toContain('(dry-run)');
  });

  it('表格单元格内的换行与竖线被安全化', () => {
    const r: TaskResult[] = [
      {
        taskId: 't1',
        status: 'completed',
        summary: '两行\n摘要 | 含竖线',
        changedFiles: [],
        notes: [],
      },
    ];
    const singlePlan: WorkflowPlan = {
      summary: 's',
      tasks: [taskPlan('t1')],
      risks: ['risk-one'],
    };
    const body = buildPullRequestBody(task, singlePlan, r, 'x');
    expect(body).toContain('| t1 | ✔ completed | 两行 摘要 \\| 含竖线 |');
  });
});
