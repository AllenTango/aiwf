/** 分支命名工具的专项测试(纯函数)。 */

import { describe, expect, it } from 'vitest';
import {
  normalizeTaskId,
  slugify,
  taskBranchName,
  deliverBranchName,
  uniqueBranchName,
} from './branch-name.js';

describe('normalizeTaskId / slugify', () => {
  it('小写 + 连字符归一化', () => {
    expect(normalizeTaskId('Fix_Bug 42!')).toBe('fix-bug-42');
    expect(normalizeTaskId('T 1')).toBe('t-1');
    expect(normalizeTaskId('  --a--b--  ')).toBe('a-b');
  });

  it('全 CJK 输入退回兜底 "task"', () => {
    expect(normalizeTaskId('实现核心功能')).toBe('task');
  });

  it('纯非法字符退回兜底 "task"', () => {
    expect(normalizeTaskId('###')).toBe('task');
  });
});

describe('taskBranchName / deliverBranchName', () => {
  it('任务分支 = prefix + normalized(id)', () => {
    expect(taskBranchName('Fix_Bug 42', 'aiwf/')).toBe('aiwf/fix-bug-42');
    expect(taskBranchName('t1', 'custom-')).toBe('custom-t1');
  });

  it('交付分支 = prefix + deliver- + slug(title)', () => {
    expect(deliverBranchName('Refactor Login', 'aiwf/')).toBe('aiwf/deliver-refactor-login');
    expect(deliverBranchName('中文标题', 'aiwf/')).toBe('aiwf/deliver-task');
  });

  it('slugify 直接调用', () => {
    expect(slugify('ABC def')).toBe('abc-def');
  });
});

describe('uniqueBranchName', () => {
  it('未占用→原样;占用→追加序号', () => {
    expect(uniqueBranchName('aiwf/t1', new Set())).toBe('aiwf/t1');
    expect(uniqueBranchName('aiwf/t1', new Set(['aiwf/t1']))).toBe('aiwf/t1-2');
    expect(uniqueBranchName('aiwf/t1', new Set(['aiwf/t1', 'aiwf/t1-2']))).toBe('aiwf/t1-3');
  });
});
