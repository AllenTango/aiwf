/**
 * engine/guidelines 单元测试:三层行为准则叠加。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MEMBER_GUIDELINES, buildGuidelinesBlock } from './guidelines.js';

describe('buildGuidelinesBlock', () => {
  it('默认准则总是出现', () => {
    const block = buildGuidelinesBlock();
    expect(block).toContain('行为准则(内置默认)');
    expect(block).toContain(DEFAULT_MEMBER_GUIDELINES[0]!);
  });

  it('人类准则与任务准则分层出现,顺序为 默认 → 人类 → 任务', () => {
    const block = buildGuidelinesBlock({
      human: ['提交前必须跑 pnpm test'],
      task: ['只改 packages/core/src/contracts'],
    });
    const iDefault = block.indexOf('行为准则(内置默认)');
    const iHuman = block.indexOf('行为准则(仓库配置,必须遵守)');
    const iTask = block.indexOf('行为准则(本任务专项要求)');
    expect(iDefault).toBeGreaterThanOrEqual(0);
    expect(iHuman).toBeGreaterThan(iDefault);
    expect(iTask).toBeGreaterThan(iHuman);
    expect(block).toContain('提交前必须跑 pnpm test');
    expect(block).toContain('只改 packages/core/src/contracts');
  });

  it('空白项被丢弃;列表符号被剥掉', () => {
    const block = buildGuidelinesBlock({ human: ['  ', '- 用 pnpm 而不是 npm', ''], task: [] });
    expect(block).toContain('用 pnpm 而不是 npm');
    expect(block).not.toContain('行为准则(本任务专项要求)');
  });

  it('默认准则里包含「开工前先通读」与「自检」这两条关键项', () => {
    expect(DEFAULT_MEMBER_GUIDELINES.some((g) => g.includes('开工前'))).toBe(true);
    expect(DEFAULT_MEMBER_GUIDELINES.some((g) => g.includes('自检'))).toBe(true);
    expect(DEFAULT_MEMBER_GUIDELINES.some((g) => g.includes('.git'))).toBe(true);
  });
});
