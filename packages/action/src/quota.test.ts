/**
 * @aiwf/action — 每日运行配额(纯逻辑表驱动测试)。OWNER: M3.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  countRunsTodaySince,
  enforceDailyQuota,
  evaluateDailyQuota,
  parseWorkflowFileName,
  startOfUtcDayIso,
  type RunCounter,
} from './quota.js';

describe('evaluateDailyQuota', () => {
  it('limit=0 → 放行(不限)', () => {
    const decision = evaluateDailyQuota({ limit: 0, used: 9999 });
    expect(decision.allowed).toBe(true);
  });

  it('limit<0 → 放行(不限)', () => {
    const decision = evaluateDailyQuota({ limit: -1, used: 10 });
    expect(decision.allowed).toBe(true);
  });

  it('used=limit → 拒绝(limit=20 时第 21 次被拒)', () => {
    const decision = evaluateDailyQuota({ limit: 20, used: 20 });
    expect(decision.allowed).toBe(false);
    expect(decision.used).toBe(20);
    expect(decision.limit).toBe(20);
  });

  it('used=limit-1 → 放行', () => {
    const decision = evaluateDailyQuota({ limit: 20, used: 19 });
    expect(decision.allowed).toBe(true);
  });

  it('used=0,limit=1 → 放行', () => {
    const decision = evaluateDailyQuota({ limit: 1, used: 0 });
    expect(decision.allowed).toBe(true);
  });
});

describe('parseWorkflowFileName', () => {
  it('owner/repo/.github/workflows/aiwf.yml@main → aiwf.yml', () => {
    expect(parseWorkflowFileName('owner/repo/.github/workflows/aiwf.yml@main')).toBe('aiwf.yml');
  });

  it('无 @ref 后缀也能取到文件名', () => {
    expect(parseWorkflowFileName('owner/repo/.github/workflows/aiwf.yml')).toBe('aiwf.yml');
  });

  it('无扩展名也返回原名', () => {
    expect(parseWorkflowFileName('owner/repo/.github/workflows/ci@main')).toBe('ci');
  });

  it('空/未定义 → undefined', () => {
    expect(parseWorkflowFileName('')).toBeUndefined();
    expect(parseWorkflowFileName(undefined)).toBeUndefined();
    expect(parseWorkflowFileName('   ')).toBeUndefined();
  });
});

describe('startOfUtcDayIso', () => {
  it('归一到 UTC 当日零点', () => {
    expect(startOfUtcDayIso(new Date('2026-11-12T13:45:59.123Z'))).toBe('2026-11-12T00:00:00Z');
  });

  it('跨日输入取其自身的 UTC 日期', () => {
    expect(startOfUtcDayIso(new Date('2026-01-01T00:00:01Z'))).toBe('2026-01-01T00:00:00Z');
  });

  it('缺省参数取当前时间(不抛错)', () => {
    expect(startOfUtcDayIso()).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  });
});

describe('countRunsTodaySince', () => {
  it('默认 since = 当日零点,并把参数透传给计数器', async () => {
    const counter = vi.fn<RunCounter>(async () => 3);
    const count = await countRunsTodaySince({
      counter,
      owner: 'acme',
      repo: 'team',
      workflowId: 'aiwf.yml',
    });
    expect(count).toBe(3);
    expect(counter).toHaveBeenCalledTimes(1);
    const arg = counter.mock.calls[0]?.[0];
    expect(arg?.owner).toBe('acme');
    expect(arg?.repo).toBe('team');
    expect(arg?.workflowId).toBe('aiwf.yml');
    expect(arg?.since).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  });

  it('显式 since 优先', async () => {
    const counter = vi.fn<RunCounter>(async () => 0);
    await countRunsTodaySince({
      counter,
      owner: 'a',
      repo: 'b',
      workflowId: 'w.yml',
      since: '2026-01-01T00:00:00Z',
    });
    expect(counter.mock.calls[0]?.[0]?.since).toBe('2026-01-01T00:00:00Z');
  });

  it('计数器抛错时向上抛(由 enforceDailyQuota 决定 fail-open)', async () => {
    const counter: RunCounter = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      countRunsTodaySince({ counter, owner: 'a', repo: 'b', workflowId: 'w.yml' }),
    ).rejects.toThrow('boom');
  });
});

describe('enforceDailyQuota', () => {
  it('limit=0 → 放行且不调用计数器', async () => {
    const counter: RunCounter = vi.fn(async () => 0);
    const decision = await enforceDailyQuota({
      limit: 0,
      counter,
      owner: 'a',
      repo: 'b',
      workflowId: 'w.yml',
    });
    expect(decision.allowed).toBe(true);
    expect(counter).not.toHaveBeenCalled();
  });

  it('已用次数达到上限 → 拒绝', async () => {
    const counter: RunCounter = vi.fn(async () => 5);
    const decision = await enforceDailyQuota({
      limit: 5,
      counter,
      owner: 'a',
      repo: 'b',
      workflowId: 'w.yml',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.used).toBe(5);
    expect(decision.limit).toBe(5);
  });

  it('未达上限 → 放行', async () => {
    const counter: RunCounter = vi.fn(async () => 4);
    const decision = await enforceDailyQuota({
      limit: 5,
      counter,
      owner: 'a',
      repo: 'b',
      workflowId: 'w.yml',
    });
    expect(decision.allowed).toBe(true);
  });

  it('计数器抛错 → 失败开放(fail-open)放行,reason 含「配额统计失败」', async () => {
    const counter: RunCounter = vi.fn(async () => {
      throw new Error('Resource not accessible by integration');
    });
    const decision = await enforceDailyQuota({
      limit: 5,
      counter,
      owner: 'a',
      repo: 'b',
      workflowId: 'w.yml',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('配额统计失败');
    expect(decision.reason).toContain('Resource not accessible by integration');
  });

  it('计数器返回非数字 → 视为 0 并放行', async () => {
    const counter: RunCounter = vi.fn(async () => Number.NaN);
    const decision = await enforceDailyQuota({
      limit: 5,
      counter,
      owner: 'a',
      repo: 'b',
      workflowId: 'w.yml',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.used).toBe(0);
  });
});
