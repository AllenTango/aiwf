/**
 * pipeline/plan-economics — 队长的成本核算与「价值感知」裁剪(纯逻辑)。
 *
 * 为什么需要它:
 * - 队长被告知预算后自行编制,但**必须有一道运行时兜底**:计划超预算时,
 *   砍掉的应该是**价值最低**的任务,而不是拓扑序靠前的那个。
 *   旧实现按拓扑序盲裁,可能把最有价值(也最贵)的任务裁掉、把低价值的留下。
 * - 裁剪必须保持**依赖闭合**:砍掉一个任务,它的所有后继也必须一起砍,
 *   否则会出现"依赖了不存在的任务"的破图。
 *
 * 成本口径:权重档位(zero-config 可用)
 *   low=1 单位 / medium=3 单位 / high=8 单位(1 单位 ≈ 1 次模型调用的相对量级)。
 *   人类若提供价格表,可在**绝对金额**维度再核算(见 plan-cost 的价格换算)。
 */

import type { PlanTask, TaskWeight } from '../contracts/index.js';

/** 权重 → 相对成本单位(默认口径)。 */
export const DEFAULT_WEIGHT_UNITS: Record<TaskWeight, number> = {
  low: 1,
  medium: 3,
  high: 8,
};

/** 权重 → 价值序(数字越大越贵、越值得保留)。 */
export const WEIGHT_RANK: Record<TaskWeight, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

/** 归一化权重(缺省按 medium 处理)。 */
export function normalizeWeight(weight: TaskWeight | undefined): TaskWeight {
  return weight === 'low' || weight === 'high' ? weight : 'medium';
}

/** 单个任务的相对成本单位。 */
export function unitsOf(task: Pick<PlanTask, 'weight'>, table: Record<TaskWeight, number> = DEFAULT_WEIGHT_UNITS): number {
  return table[normalizeWeight(task.weight)];
}

/** 一组任务的成本估算。 */
export interface CostEstimate {
  /** 相对成本单位合计。 */
  units: number;
  /** 预计模型调用次数(1 次/任务 + 队长本次 1 次)。 */
  expectedCalls: number;
  /** 整体成本量级(取最高单任务权重)。 */
  weight: TaskWeight;
}

/** 估算一组任务的成本。 */
export function estimateCost(
  tasks: readonly PlanTask[],
  table: Record<TaskWeight, number> = DEFAULT_WEIGHT_UNITS,
): CostEstimate {
  let units = 0;
  let maxRank = 0;
  for (const task of tasks) {
    units += unitsOf(task, table);
    maxRank = Math.max(maxRank, WEIGHT_RANK[normalizeWeight(task.weight)]);
  }
  const weight: TaskWeight = maxRank >= 3 ? 'high' : maxRank === 2 ? 'medium' : 'low';
  return { units, expectedCalls: tasks.length + 1, weight };
}

/** 裁剪结果。 */
export interface TrimOutcome {
  /** 保留的任务(依赖闭合)。 */
  kept: PlanTask[];
  /** 被裁掉的任务(含因依赖断裂而连带裁掉的)。 */
  dropped: PlanTask[];
  /** 保留部分的相对成本单位。 */
  units: number;
  /** 裁剪是否发生过。 */
  trimmed: boolean;
}

export interface TrimOptions {
  /** 编制人数上限(= maxTasks)。 */
  maxTasks?: number;
  /** 相对成本预算上限。 */
  budgetUnits?: number;
  /** 权重 → 单位 对照表。 */
  table?: Record<TaskWeight, number>;
}

/**
 * 把任务集合裁剪到「人数上限 + 成本预算」之内,**按价值从高到低装**。
 *
 * 算法(贪心 + 依赖闭包):
 * 1. 按价值序从高到低遍历任务(high → medium → low,同价值按原顺序);
 * 2. 尝试装入某个任务时,**自动带上它的全部(传递)前置依赖**;
 * 3. 装入后若人数或成本超限 → **跳过**这个任务(而不是连带砍掉别人);
 * 4. 被跳过的任务若被后续任务依赖,那些任务同样装不下(依赖会把它拉回来,超限则跳过)。
 *
 * 关键性质:
 * - **保留部分始终依赖闭合**:kept 里每个任务的依赖都在 kept 里;
 * - **最大化保留价值**:优先保住高价值任务,而不是按拓扑序盲裁。
 *
 * 例:链式 t1(low) → t2(low) → t3(high),上限 2 →
 * t3 需带上 t1+t2(3 个)装不下 → 跳过;装 t1(1 个)✅;再装 t2(2 个)✅ →
 * 保留 {t1,t2},砍掉 {t3}(此时 t3 是唯一能砍掉且仍满足约束的叶子)。
 */
export function trimToBudget(tasks: readonly PlanTask[], options: TrimOptions = {}): TrimOutcome {
  const table = options.table ?? DEFAULT_WEIGHT_UNITS;
  const maxTasks = options.maxTasks !== undefined && options.maxTasks > 0 ? options.maxTasks : undefined;
  const budgetUnits = options.budgetUnits !== undefined && options.budgetUnits > 0 ? options.budgetUnits : undefined;

  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const keptIds = new Set<string>();
  let keptUnits = 0;

  /** task 及其全部(传递)前置依赖。 */
  const closureOf = (id: string): Set<string> => {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || out.has(current)) continue;
      const task = byId.get(current);
      if (task === undefined) continue;
      out.add(current);
      for (const dep of task.dependsOn) stack.push(dep);
    }
    return out;
  };

  const order = [...tasks].sort((a, b) => {
    const ra = WEIGHT_RANK[normalizeWeight(a.weight)];
    const rb = WEIGHT_RANK[normalizeWeight(b.weight)];
    if (ra !== rb) return rb - ra; // 价值高的先装
    return tasks.findIndex((t) => t.id === a.id) - tasks.findIndex((t) => t.id === b.id);
  });

  for (const candidate of order) {
    const closure = closureOf(candidate.id);
    const fresh = [...closure].filter((id) => !keptIds.has(id));
    if (fresh.length === 0) continue;

    let freshUnits = 0;
    for (const id of fresh) {
      const task = byId.get(id);
      if (task !== undefined) freshUnits += unitsOf(task, table);
    }
    if (maxTasks !== undefined && keptIds.size + fresh.length > maxTasks) continue;
    if (budgetUnits !== undefined && keptUnits + freshUnits > budgetUnits) continue;

    for (const id of fresh) keptIds.add(id);
    keptUnits += freshUnits;
  }

  const kept = tasks.filter((t) => keptIds.has(t.id));
  const dropped = tasks.filter((t) => !keptIds.has(t.id));
  return {
    kept,
    dropped,
    units: keptUnits,
    trimmed: dropped.length > 0,
  };
}

/**
 * 解析任务实际应使用的模型。
 *
 * 优先级:任务显式指派 > 模型池角色映射 > 引擎默认模型。
 * 任务写 `worker`(池里的角色名)或直接写 `provider/model` 都支持。
 */
export function resolveTaskModel(
  taskModel: string | undefined,
  pool: Record<string, string> | undefined,
  fallback: string | undefined,
): string | undefined {
  const raw = (taskModel ?? '').trim();
  if (raw !== '') {
    if (pool !== undefined) {
      const mapped = pool[raw];
      if (mapped !== undefined && mapped.trim() !== '') return mapped.trim();
    }
    // 池里没有同名角色:当作完整 model id 使用(形如 provider/model)
    return raw;
  }
  if (pool !== undefined) {
    const defaultModel = pool['default'];
    if (defaultModel !== undefined && defaultModel.trim() !== '') return defaultModel.trim();
  }
  return fallback;
}
