/** 计划校验与拓扑工具(纯函数,抛出"规划失败"类中文错误——由 runner 顶层承接)。 */

import type { PlanTask, WorkflowPlan } from '../contracts/index.js';

/**
 * 结构校验:
 * - `plan.tasks` 必须是数组;
 * - 任务 id 唯一;
 * - `dependsOn` 引用的 id 必须存在(自依赖即环);
 * - DAG 无环。
 *
 * 失败 → 抛 `计划校验失败:…`(规划失败 ≠ 成员失败,允许抛出)。
 */
export function validatePlan(plan: WorkflowPlan): void {
  if (!Array.isArray(plan.tasks)) {
    throw new Error('计划校验失败:任务列表 tasks 非法(应为数组)');
  }
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (typeof t.id !== 'string' || t.id === '') {
      throw new Error('计划校验失败:存在缺少有效 id 的任务');
    }
    if (ids.has(t.id)) {
      throw new Error(`计划校验失败:任务 id 重复:「${t.id}」`);
    }
    ids.add(t.id);
  }
  for (const t of plan.tasks) {
    if (!Array.isArray(t.dependsOn)) {
      throw new Error(`计划校验失败:任务「${t.id}」的 dependsOn 非法(应为数组)`);
    }
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`计划校验失败:任务「${t.id}」依赖了不存在的任务:「${dep}」`);
      }
    }
  }
  assertAcyclic(plan.tasks);
}

/** DFS 找环,命中即抛(给出一条环路径)。 */
function assertAcyclic(tasks: readonly PlanTask[]): void {
  const byId = new Map<string, PlanTask>();
  for (const t of tasks) byId.set(t.id, t);
  const state = new Map<string, 'unvisited' | 'instack' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const seen = state.get(id) ?? 'unvisited';
    if (seen === 'instack') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (seen === 'done') return null;
    state.set(id, 'instack');
    stack.push(id);
    const task = byId.get(id);
    if (task !== undefined) {
      for (const dep of task.dependsOn) {
        const cycle = visit(dep);
        if (cycle !== null) return cycle;
      }
    }
    state.set(id, 'done');
    stack.pop();
    return null;
  };
  for (const t of tasks) {
    const cycle = visit(t.id);
    if (cycle !== null) {
      throw new Error(`计划校验失败:任务依赖存在环:${cycle.join(' → ')}`);
    }
  }
}

/** Kahn 分层拓扑:同层任务可并行(层内顺序保持计划顺序)。 */
export function topoLayers(tasks: readonly PlanTask[]): PlanTask[][] {
  const byId = new Map<string, PlanTask>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    byId.set(t.id, t);
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(dep)?.push(t.id);
    }
  }
  const layers: PlanTask[][] = [];
  const placed = new Set<string>();
  let frontier = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0);
  while (frontier.length > 0) {
    layers.push(frontier);
    for (const t of frontier) placed.add(t.id);
    const nextIds: string[] = [];
    for (const t of frontier) {
      for (const dep of dependents.get(t.id) ?? []) {
        const next = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, next);
        if (next === 0) nextIds.push(dep);
      }
    }
    frontier = nextIds
      .map((id) => byId.get(id))
      .filter((t): t is PlanTask => t !== undefined);
  }
  if (placed.size < byId.size) {
    throw new Error('计划校验失败:任务依赖存在环(DAG 校验未通过)');
  }
  return layers;
}

/** 拓扑序扁平化(依赖在前,后继在后)。 */
export function flattenTopo(tasks: readonly PlanTask[]): PlanTask[] {
  return topoLayers(tasks).flat();
}
