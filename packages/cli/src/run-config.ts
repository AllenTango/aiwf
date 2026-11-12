import type { EngineKind } from '@aiwf/core';
import { UsageError } from './errors.js';

export const DEFAULT_ENGINE: EngineKind = 'opencode';
export const DEFAULT_MAX_PARALLEL = 4;
export const DEFAULT_BRANCH_PREFIX = 'aiwf/';
/** opencode engine default per contract: 20 minutes. */
export const OPENCODE_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * 硬上限(与 Action 侧对齐):防止一次运行放大模型开销。
 * - 并行队员上限 8;
 * - 成员任务数上限 10;
 * - 单步超时 60s ~ 60min。
 */
export const MAX_PARALLEL_HARD_LIMIT = 8;
export const MAX_TASKS_HARD_LIMIT = 10;
export const TIMEOUT_MS_MIN = 60_000;
export const TIMEOUT_MS_MAX = 3_600_000;

/** 默认成员任务数上限(单次运行最多允许的模型任务数)。 */
export const DEFAULT_MAX_TASKS = 6;
/** 默认单步超时(opencode 与 mock 统一,便于行为一致)。 */
export const DEFAULT_TIMEOUT_MS = 1_200_000;

/** 默认相对成本预算上限(0 = 不限)。 */
export const DEFAULT_BUDGET_UNITS = 0;

/** 墙钟预算相对单步超时的放大系数(含调度/合成/交付余量)。 */
const WALL_CLOCK_FACTOR = 1.2;

const ENGINE_KINDS: readonly EngineKind[] = ['opencode', 'mock'];

export interface RunFlagValues {
  issue?: string;
  from?: string;
  inline?: string;
  dir?: string;
  engine?: string;
  model?: string;
  /** Raw string from commander; validated here (usage errors → exit 2). */
  timeoutMs?: string;
  maxParallel?: string;
  /** Raw string from commander; validated here (usage errors → exit 2). */
  maxTasks?: string;
  baseBranch?: string;
  branchPrefix?: string;
  dryRun?: boolean;
  json?: boolean;
  /** 模型池:`role=provider/model`,逗号或换行分隔。 */
  models?: string;
  /** 行为准则:每行一条。 */
  guidelines?: string;
  /** 相对成本预算上限(权重档位单位)。 */
  budget?: string;
}

/** Env-level fallbacks (flags always win). */
export interface RunEnv {
  AIWF_ENGINE?: string;
  AIWF_MODEL?: string;
  AIWF_TIMEOUT_MS?: string;
  AIWF_MAX_PARALLEL?: string;
  AIWF_MAX_TASKS?: string;
  AIWF_BASE_BRANCH?: string;
  AIWF_BRANCH_PREFIX?: string;
  AIWF_MODELS?: string;
  AIWF_GUIDELINES?: string;
  AIWF_BUDGET?: string;
}

/** 解析模型池:`role=model`,逗号或换行分隔(与 Action 侧同格式)。 */
export function parseModelPool(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of (raw ?? '').split(/[,\n]/)) {
    const line = piece.trim();
    if (line === '') continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const role = line.slice(0, idx).trim();
    const model = line.slice(idx + 1).trim();
    if (role === '' || model === '') continue;
    out[role] = model;
  }
  return out;
}

/** 解析行为准则:每行一条,去掉行首列表符号。 */
export function parseGuidelines(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*+]\s+/, '').trim())
    .filter((line) => line !== '');
}

export interface ResolvedCliConfig {
  engine: EngineKind;
  model?: string;
  /** 单步超时(ms);缺省 DEFAULT_TIMEOUT_MS(opencode/mock 一致)。 */
  timeoutMs: number;
  maxParallel: number;
  /** 单次运行允许的最大成员任务数(= 编制人数上限;超出按价值裁剪)。 */
  maxTasks: number;
  /** 本次运行的墙钟预算(ms),由 timeoutMs × 批次数 × 1.2 推导。 */
  wallClockBudgetMs: number;
  /** Hint only: local PR base branch (also handed to the local platform). */
  baseBranch?: string;
  branchPrefix: string;
  dryRun: boolean;
  json: boolean;
  /** Target repo dir hint; validated against `git rev-parse` by the shell. */
  repoDirHint: string;
  /** 可指派的模型池(role → model)。 */
  modelPool: Record<string, string>;
  /** 人类配置的行为准则(每行一条)。 */
  guidelines: string[];
  /** 相对成本预算上限(0 = 不限)。 */
  budgetUnits: number;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

const overrideString = (
  flag: string | undefined,
  envValue: string | undefined,
): string | undefined => clean(flag) ?? clean(envValue);

function parsePositiveInt(
  raw: string | undefined,
  label: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${label} 必须是正整数,收到:"${raw}"。`);
  }
  return value;
}

/**
 * 解析一个落在 [min, max] 闭区间内的整数。
 * 非整数 → UsageError(正整数);越界 → UsageError(区间说明)。
 */
function parseBoundedInt(
  raw: string | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${label} 必须是正整数,收到:"${raw}"。`);
  }
  if (value < min || value > max) {
    throw new UsageError(
      `${label} 必须在 ${min}~${max} 之间,收到:${value}。`,
    );
  }
  return value;
}

/**
 * 推导墙钟预算:每批最多 maxParallel 个成员,共 ceil(maxTasks / maxParallel) 批,
 * 每批至多 timeoutMs,再乘 1.2 余量系数,最后对齐到整秒(1000 的倍数)。
 */
function computeWallClockBudgetMs(
  timeoutMs: number,
  maxTasks: number,
  maxParallel: number,
): number {
  const batches = Math.ceil(maxTasks / maxParallel);
  const raw = timeoutMs * batches * WALL_CLOCK_FACTOR;
  const aligned = Math.floor(raw / 1000) * 1000;
  return Math.max(aligned, Math.ceil(timeoutMs / 1000) * 1000);
}

/** Resolve every knob with CLI-flag > environment > default priority. */
export function resolveRunConfig(
  flags: RunFlagValues,
  env: RunEnv = {},
): ResolvedCliConfig {
  const engineRaw = overrideString(flags.engine, env.AIWF_ENGINE) ?? DEFAULT_ENGINE;
  if (!ENGINE_KINDS.includes(engineRaw as EngineKind)) {
    throw new UsageError(
      `--engine 仅支持 ${ENGINE_KINDS.join(' | ')},收到:"${engineRaw}"。`,
    );
  }
  const engine = engineRaw as EngineKind;

  const model = overrideString(flags.model, env.AIWF_MODEL);

  const timeoutMs =
    parseBoundedInt(
      clean(flags.timeoutMs) ?? clean(env.AIWF_TIMEOUT_MS),
      '--timeout-ms',
      TIMEOUT_MS_MIN,
      TIMEOUT_MS_MAX,
    ) ?? DEFAULT_TIMEOUT_MS;

  const maxParallel =
    parseBoundedInt(
      clean(flags.maxParallel) ?? clean(env.AIWF_MAX_PARALLEL),
      '--max-parallel',
      1,
      MAX_PARALLEL_HARD_LIMIT,
    ) ?? DEFAULT_MAX_PARALLEL;

  const maxTasks =
    parseBoundedInt(
      clean(flags.maxTasks) ?? clean(env.AIWF_MAX_TASKS),
      '--max-tasks',
      1,
      MAX_TASKS_HARD_LIMIT,
    ) ?? DEFAULT_MAX_TASKS;

  const wallClockBudgetMs = computeWallClockBudgetMs(timeoutMs, maxTasks, maxParallel);

  const baseBranch = overrideString(flags.baseBranch, env.AIWF_BASE_BRANCH);

  const branchPrefixRaw = overrideString(flags.branchPrefix, env.AIWF_BRANCH_PREFIX);
  let branchPrefix = branchPrefixRaw ?? DEFAULT_BRANCH_PREFIX;
  if (!branchPrefix.endsWith('/')) branchPrefix = `${branchPrefix}/`;

  const modelPool = parseModelPool(overrideString(flags.models, env.AIWF_MODELS) ?? '');
  const guidelines = parseGuidelines(overrideString(flags.guidelines, env.AIWF_GUIDELINES) ?? '');
  const budgetUnits =
    parseBoundedInt(
      clean(flags.budget) ?? clean(env.AIWF_BUDGET),
      '--budget',
      1,
      Number.MAX_SAFE_INTEGER,
    ) ?? DEFAULT_BUDGET_UNITS;

  return {
    engine,
    ...(model !== undefined ? { model } : {}),
    timeoutMs,
    maxParallel,
    maxTasks,
    wallClockBudgetMs,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    branchPrefix,
    dryRun: flags.dryRun === true,
    json: flags.json === true,
    repoDirHint: clean(flags.dir) ?? '.',
    modelPool,
    guidelines,
    budgetUnits,
  };
}
