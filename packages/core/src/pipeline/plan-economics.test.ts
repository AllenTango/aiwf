/**
 * pipeline/plan-economics 单元测试:成本核算 / 价值感知裁剪 / 模型解析。
 */

import { describe, expect, it } from 'vitest';

import type { PlanTask, TaskWeight } from '../contracts/index.js';
import {
  DEFAULT_WEIGHT_UNITS,
  WEIGHT_RANK,
  estimateCost,
  normalizeWeight,
  resolveTaskModel,
  trimToBudget,
  unitsOf,
} from './plan-economics.js';

function task(
  id: string,
  weight?: TaskWeight,
  dependsOn: string[] = [],
  outputs: string[] = [],
): PlanTask {
  return {
    id,
    title: `任务-${id}`,
    role: 'implementer',
    instructions: `执行 ${id}`,
    dependsOn,
    expectedOutputs: outputs,
    ...(weight !== undefined ? { weight } : {}),
  };
}

describe('权重与单位', () => {
  it('缺省权重按 medium 处理', () => {
    expect(normalizeWeight(undefined)).toBe('medium');
    expect(normalizeWeight('low')).toBe('low');
    expect(normalizeWeight('high')).toBe('high');
  });

  it('单位映射:low=1 / medium=3 / high=8', () => {
    expect(DEFAULT_WEIGHT_UNITS.low).toBe(1);
    expect(DEFAULT_WEIGHT_UNITS.medium).toBe(3);
    expect(DEFAULT_WEIGHT_UNITS.high).toBe(8);
    expect(unitsOf(task('t', 'low'))).toBe(1);
    expect(unitsOf(task('t', 'high'))).toBe(8);
    expect(unitsOf(task('t'))).toBe(3);
  });

  it('价值序:high > medium > low', () => {
    expect(WEIGHT_RANK.high).toBeGreaterThan(WEIGHT_RANK.medium);
    expect(WEIGHT_RANK.medium).toBeGreaterThan(WEIGHT_RANK.low);
  });
});

describe('estimateCost', () => {
  it('单位合计 + 调用次数(含队长本次)+ 整体量级取最高单任务权重', () => {
    const est = estimateCost([task('t1', 'low'), task('t2', 'high'), task('t3', 'medium')]);
    expect(est.units).toBe(1 + 8 + 3);
    expect(est.expectedCalls).toBe(4);
    expect(est.weight).toBe('high');
  });

  it('空计划 → 0 单位,1 次调用(只有队长)', () => {
    const est = estimateCost([]);
    expect(est.units).toBe(0);
    expect(est.expectedCalls).toBe(1);
  });
});

describe('trimToBudget', () => {
  it('人数超限 → 砍掉价值最低的任务', () => {
    const result = trimToBudget([task('t1', 'high'), task('t2', 'low'), task('t3', 'medium')], {
      maxTasks: 2,
    });
    expect(result.trimmed).toBe(true);
    expect(result.kept.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(result.dropped.map((t) => t.id)).toEqual(['t2']);
  });

  it('成本预算超限 → 同样按价值从低到高砍', () => {
    // high=8 + medium=3 = 11 > 预算 8 → 砍掉 medium(3)后剩 high=8
    const result = trimToBudget([task('t1', 'high'), task('t2', 'medium')], { budgetUnits: 8 });
    expect(result.kept.map((t) => t.id)).toEqual(['t1']);
    expect(result.units).toBe(8);
  });

  it('链式依赖:保留部分依赖闭合,且优先保住装得下的高价值任务', () => {
    // t1(low) → t2(low) → t3(high);上限 2。
    // t3 需要带上 t1+t2(共 3 个)装不下 → 跳过;装 t1、t2 → 砍掉 t3。
    const result = trimToBudget(
      [task('t1', 'low'), task('t2', 'low', ['t1']), task('t3', 'high', ['t2'])],
      { maxTasks: 2 },
    );
    expect(result.kept.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(result.dropped.map((t) => t.id)).toEqual(['t3']);
    // 保留部分的依赖都在保留部分里(依赖闭合)
    for (const kept of result.kept) {
      for (const dep of kept.dependsOn) {
        expect(result.kept.map((t) => t.id)).toContain(dep);
      }
    }
  });

  it('独立任务:优先保住高价值任务,砍掉低价值的', () => {
    const result = trimToBudget([task('t1', 'low'), task('t2', 'high')], { maxTasks: 1 });
    expect(result.kept.map((t) => t.id)).toEqual(['t2']);
    expect(result.dropped.map((t) => t.id)).toEqual(['t1']);
  });

  it('在预算内 → 不裁剪', () => {
    const result = trimToBudget([task('t1', 'low'), task('t2', 'low')], { maxTasks: 4, budgetUnits: 100 });
    expect(result.trimmed).toBe(false);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it('无上限(两者都不给)→ 原样返回', () => {
    const result = trimToBudget([task('t1', 'high'), task('t2', 'high')]);
    expect(result.trimmed).toBe(false);
    expect(result.kept).toHaveLength(2);
  });
});

describe('resolveTaskModel', () => {
  const pool = { worker: 'opencode/glm-5.3', reviewer: 'minimax/MiniMax-M3.1-Flash', default: 'opencode/free' };

  it('任务写池里的角色名 → 解析成真实 model id', () => {
    expect(resolveTaskModel('worker', pool, 'fallback')).toBe('opencode/glm-5.3');
    expect(resolveTaskModel('reviewer', pool, 'fallback')).toBe('minimax/MiniMax-M3.1-Flash');
  });

  it('任务写完整 model id(不在池里)→ 原样使用', () => {
    expect(resolveTaskModel('deepseek/deepseek-chat', pool, 'fallback')).toBe('deepseek/deepseek-chat');
  });

  it('任务未指派 → 用池里的 default;池无 default → 用兜底', () => {
    expect(resolveTaskModel(undefined, pool, 'fallback')).toBe('opencode/free');
    expect(resolveTaskModel(undefined, { worker: 'a/b' }, 'fallback')).toBe('fallback');
    expect(resolveTaskModel(undefined, undefined, 'fallback')).toBe('fallback');
    expect(resolveTaskModel(undefined, undefined, undefined)).toBeUndefined();
  });
});
