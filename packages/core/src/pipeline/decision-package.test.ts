/**
 * pipeline/decision-package 单元测试:决策包的序列化与「批准信号」识别。
 */

import { describe, expect, it } from 'vitest';

import type { WorkflowPlan } from '../contracts/index.js';
import {
  APPROVE_SIGNAL,
  DECISION_MARKER,
  buildDecisionPackageComment,
  buildDecisionSummary,
  extractDecisionJson,
  findApprovedDecision,
  type IssueComment,
} from './decision-package.js';

const plan: WorkflowPlan = {
  verdict: 'proceed',
  summary: '两个任务的计划',
  rationale: '值得做',
  risks: [],
  tasks: [
    {
      id: 't1',
      title: '实现导出',
      role: 'implementer',
      instructions: '写实现',
      dependsOn: [],
      expectedOutputs: ['src/export.ts'],
      weight: 'medium',
      model: 'worker',
    },
  ],
  cost: { weight: 'medium', expectedCalls: 2, units: 3, reason: '常规实现' },
};

function comment(body: string, createdAt: string): IssueComment {
  return { author: 'someone', body, createdAt };
}

describe('extractDecisionJson', () => {
  it('从评论里抽出决策包 JSON', () => {
    const body = `前面的话\n${DECISION_MARKER}${JSON.stringify(plan)}`;
    const json = extractDecisionJson(body);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!)).toMatchObject({ summary: '两个任务的计划' });
  });

  it('决策包后跟人类补充说明时,只取到平衡的 JSON 为止', () => {
    const body = `${DECISION_MARKER}${JSON.stringify(plan)}\n\n补充:我觉得可以`;
    const json = extractDecisionJson(body);
    expect(json).not.toBeNull();
    expect(json).not.toContain('补充');
  });

  it('无标记 → null', () => {
    expect(extractDecisionJson('普通评论')).toBeNull();
  });
});

describe('findApprovedDecision', () => {
  it('有决策包且其后出现 @aiwf go → 返回该决策包', () => {
    const comments = [
      comment('随便聊聊', '2026-01-01T00:00:00Z'),
      comment(`${DECISION_MARKER}${JSON.stringify(plan)}`, '2026-01-01T00:01:00Z'),
      comment('@aiwf go', '2026-01-01T00:02:00Z'),
    ];
    const found = findApprovedDecision(comments);
    expect(found).not.toBeNull();
    expect(found?.tasks).toHaveLength(1);
  });

  it('有决策包但没有 @aiwf go → null(等人批准)', () => {
    const comments = [
      comment(`${DECISION_MARKER}${JSON.stringify(plan)}`, '2026-01-01T00:01:00Z'),
      comment('我再想想', '2026-01-01T00:02:00Z'),
    ];
    expect(findApprovedDecision(comments)).toBeNull();
  });

  it('@aiwf go 出现在决策包**之前**不算批准', () => {
    const comments = [
      comment('@aiwf go', '2026-01-01T00:00:00Z'),
      comment(`${DECISION_MARKER}${JSON.stringify(plan)}`, '2026-01-01T00:01:00Z'),
    ];
    expect(findApprovedDecision(comments)).toBeNull();
  });

  it('取最后一个决策包(旧的批准不适用于新决策包)', () => {
    const older = { ...plan, summary: '旧计划' };
    const newer = { ...plan, summary: '新计划' };
    const comments = [
      comment(`${DECISION_MARKER}${JSON.stringify(older)}`, '2026-01-01T00:01:00Z'),
      comment('@aiwf go', '2026-01-01T00:02:00Z'),
      comment(`${DECISION_MARKER}${JSON.stringify(newer)}`, '2026-01-01T00:03:00Z'),
    ];
    expect(findApprovedDecision(comments)).toBeNull();
  });

  it('空评论列表 → null', () => {
    expect(findApprovedDecision([])).toBeNull();
  });

  it('批准信号大小写不敏感', () => {
    expect(APPROVE_SIGNAL.test('@AIWF GO')).toBe(true);
    expect(APPROVE_SIGNAL.test('@aiwf go 执行')).toBe(true);
    expect(APPROVE_SIGNAL.test('@aiwf 走了')).toBe(false);
  });
});

describe('buildDecisionPackageComment', () => {
  it('含批准指引、编制明细与协议标记', () => {
    const body = buildDecisionPackageComment(plan);
    expect(body).toContain('@aiwf go');
    expect(body).toContain('t1');
    expect(body).toContain('模型 worker');
    expect(body).toContain('队员数:1');
    expect(body).toContain(DECISION_MARKER);
    // 决策包能被自己解析回来
    const json = extractDecisionJson(body);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!).tasks[0].id).toBe('t1');
  });
});

describe('buildDecisionSummary', () => {
  it('说明本轮未派发任何队员,并给出批准方式', () => {
    const summary = buildDecisionSummary(plan);
    expect(summary).toContain('决策包');
    expect(summary).toContain('未派发任何队员');
    expect(summary).toContain('@aiwf go');
    expect(summary).toContain('队员数:1');
  });
});
