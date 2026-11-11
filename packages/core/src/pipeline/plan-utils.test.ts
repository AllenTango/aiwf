/** 计划校验与拓扑分层工具的专项测试(纯函数)。 */

import { describe, expect, it } from 'vitest';
import type { PlanTask, WorkflowPlan } from '../contracts/index.js';
import { validatePlan, topoLayers, flattenTopo } from './plan-utils.js';

function t(id: string, dependsOn: string[] = []): PlanTask {
  return { id, title: id, role: 'implementer', instructions: 'x', dependsOn, expectedOutputs: [] };
}

const planOf = (tasks: PlanTask[]): WorkflowPlan => ({ summary: 's', tasks, risks: [] });

describe('validatePlan', () => {
  it('合法计划(含空计划)通过', () => {
    expect(() => validatePlan(planOf([]))).not.toThrow();
    expect(() => validatePlan(planOf([t('a'), t('b', ['a']), t('c', ['a', 'b'])]))).not.toThrow();
  });

  it('重复 id → 中文错误', () => {
    expect(() => validatePlan(planOf([t('a'), t('a')]))).toThrow('任务 id 重复:「a」');
  });

  it('缺失依赖 → 中文错误(含上下文)', () => {
    expect(() => validatePlan(planOf([t('b', ['ghost'])]))).toThrow(
      '任务「b」依赖了不存在的任务:「ghost」',
    );
  });

  it('自依赖即环 → 中文错误', () => {
    expect(() => validatePlan(planOf([t('a'), t('b', ['a', 'b'])]))).toThrow('存在环');
  });

  it('两节点环 → 给出环路径', () => {
    expect(() => validatePlan(planOf([t('a', ['b']), t('b', ['a'])]))).toThrow('存在环');
  });

  it('依赖引用不存在 + 环同时存在时:优先报缺失', () => {
    expect(() => validatePlan(planOf([t('a', ['b', 'ghost']), t('b', ['a'])]))).toThrow('ghost');
  });
});

describe('topoLayers / flattenTopo', () => {
  it('菱形依赖:t2/t3 同层,平铺顺序依赖在前', () => {
    const plan = planOf([t('t1'), t('t2', ['t1']), t('t3', ['t1']), t('t4', ['t2', 't3'])]);
    const layers = topoLayers(plan.tasks);
    expect(layers.map((layer) => layer.map((x) => x.id))).toEqual([
      ['t1'],
      ['t2', 't3'],
      ['t4'],
    ]);
    const flatIds = flattenTopo(plan.tasks).map((x) => x.id);
    expect(flatIds).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('多个无依赖任务在同一层,层内保持计划顺序', () => {
    const plan = planOf([t('c'), t('a'), t('b')]);
    const layers = topoLayers(plan.tasks);
    expect(layers.map((layer) => layer.map((x) => x.id))).toEqual([['c', 'a', 'b']]);
  });

  it('链式依赖:每层一个任务', () => {
    const plan = planOf([t('a'), t('b', ['a']), t('c', ['b'])]);
    const layers = topoLayers(plan.tasks);
    expect(layers.map((layer) => layer.map((x) => x.id))).toEqual([['a'], ['b'], ['c']]);
  });
});
