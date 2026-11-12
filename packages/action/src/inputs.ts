/**
 * @aiwf/action — 输入解析(纯逻辑,便于表驱动测试)。
 * OWNER: M4 / M3(新增触发准入与额度配额相关 inputs)。
 *
 * 与根目录 action.yml 的 inputs 一一对应:
 *   task_ref(必填) / engine / model / base_branch / branch_prefix / max_parallel / dry_run
 *   trigger_policy / allowed_actors / daily_run_limit / max_tasks / timeout_ms
 *
 * 约定:不直接 import @actions/core(由 main.ts 注入 RawInputReader),
 * 这样本文件可在 vitest 中零打桩验证所有默认值与校验行为。
 */
import type { EngineKind } from '@aiwf/core';
import type { TriggerPolicy } from './guard.js';

export type { TriggerPolicy };

/** task_ref 的唯一合法形态:`<owner>/<repo>#<issue number>`,如 `my-org/my-repo#42`。 */
export const TASK_REF_PATTERN = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** 支持的引擎取值(与 contracts 的 EngineKind 对齐)。 */
export const ENGINE_CHOICES: readonly EngineKind[] = ['opencode', 'mock'];

export const DEFAULT_ENGINE: EngineKind = 'opencode';
export const DEFAULT_BRANCH_PREFIX = 'aiwf/';
export const DEFAULT_MAX_PARALLEL = 4;

/** model 输入为空时回读的环境变量名(工作流中以 `vars.AIWF_MODEL` 注入)。 */
export const MODEL_ENV_FALLBACK = 'AIWF_MODEL';

// ---------------------------------------------------------------------------
// 触发准入 / 额度配额(M3)
// ---------------------------------------------------------------------------

/** trigger_policy 的合法取值。 */
export const TRIGGER_POLICY_CHOICES: readonly TriggerPolicy[] = ['trusted', 'anyone'];

/** 默认触发策略:仅信任 OWNER/MEMBER/COLLABORATOR 或白名单命中者。 */
export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = 'trusted';

/** 默认每日运行次数上限(0 = 不限)。 */
export const DEFAULT_DAILY_RUN_LIMIT = 0;

/** 默认单次运行最大成员任务数。 */
export const DEFAULT_MAX_TASKS = 6;

/** 默认引擎单步超时(ms)。 */
export const DEFAULT_TIMEOUT_MS = 1200000;

/** max_parallel 的硬上限(超过即报错,不静默截断)。 */
export const MAX_PARALLEL_HARD_LIMIT = 8;

/** max_tasks 的硬上限。 */
export const MAX_TASKS_HARD_LIMIT = 10;

/** timeout_ms 下界(ms)。 */
export const TIMEOUT_MS_MIN = 60000;

/** timeout_ms 上界(ms)。 */
export const TIMEOUT_MS_MAX = 3600000;

/** 新增 inputs 的环境变量回退名(与 AIWF_MODEL 风格一致)。 */
export const TRIGGER_POLICY_ENV_FALLBACK = 'AIWF_TRIGGER_POLICY';
export const ALLOWED_ACTORS_ENV_FALLBACK = 'AIWF_ALLOWED_ACTORS';
export const DAILY_RUN_LIMIT_ENV_FALLBACK = 'AIWF_DAILY_RUN_LIMIT';
export const MAX_TASKS_ENV_FALLBACK = 'AIWF_MAX_TASKS';
export const TIMEOUT_MS_ENV_FALLBACK = 'AIWF_TIMEOUT_MS';
export const MODELS_ENV_FALLBACK = 'AIWF_MODELS';
export const GUIDELINES_ENV_FALLBACK = 'AIWF_GUIDELINES';
export const BUDGET_ENV_FALLBACK = 'AIWF_BUDGET';

/** 默认相对成本预算上限(0 = 不限)。 */
export const DEFAULT_BUDGET_UNITS = 0;

export interface ActionInputs {
  taskRef: string;
  engine: EngineKind;
  /** 空 → 引擎使用自身默认模型。 */
  model?: string;
  /** 空 → 运行时取 checkout 的当前分支。 */
  baseBranch?: string;
  branchPrefix: string;
  maxParallel: number;
  dryRun: boolean;
  /** 触发准入策略。 */
  triggerPolicy: TriggerPolicy;
  /** 触发者白名单(保留原大小写;比较时忽略大小写)。 */
  allowedActors: string[];
  /** 本仓库单日最大运行次数(0 = 不限)。 */
  dailyRunLimit: number;
  /** 单次运行允许的最大成员任务数。 */
  maxTasks: number;
  /** 引擎单步超时(ms)。 */
  timeoutMs: number;
  /** 可指派的模型池(role → model);为空表示只能用默认模型。 */
  modelPool: Record<string, string>;
  /** 人类配置的行为准则(每行一条)。 */
  guidelines: string[];
  /** 相对成本预算上限(权重档位单位;0 = 不限)。 */
  budgetUnits: number;
  /**
   * 两段式审批:队长先出决策包,人回复 `@aiwf go` 后才派发队员。
   * 默认 false(一次触发直接执行)。
   */
  approve: boolean;
  /**
   * 幂等短路:任务内容与上次运行完全一致时,跳过本次运行(不调模型、不派队员)。
   * 默认 true;需要强制重跑时设为 false。
   */
  idempotent: boolean;
}

/** 最小读取接口,测试可纯打桩;生产侧在 main.ts 包一层 @actions/core。 */
export interface RawInputReader {
  getInput(name: string): string;
  getBooleanInput(name: string): boolean;
}

/** env 形状:测试传 Record;生产传 process.env。 */
export type EnvLike = Record<string, string | undefined>;

export type ParseInputsOutcome =
  | { ok: true; inputs: ActionInputs }
  | { ok: false; errors: string[] };

/**
 * 校验 task_ref 引用格式。
 * @returns 合法时返回 null;非法时返回一段可直接展示的错误信息(中文 + 期望格式)。
 */
export function validateTaskRef(value: string | undefined | null): string | null {
  const ref = (value ?? '').trim();
  if (ref === '') {
    return 'task_ref 必填:期望形如 `owner/repo#123` 的 Issue 引用。';
  }
  if (!TASK_REF_PATTERN.test(ref)) {
    return `task_ref 格式不合法:"${ref}"。期望形如 \`owner/repo#123\`(例如 \`my-org/my-repo#42\`)。`;
  }
  return null;
}

/**
 * 解析「逗号分隔的用户名白名单」:去空白、去空项、保留原大小写。
 */
export function parseAllowedActors(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 解析模型池:`role=model` 列表,逗号或换行分隔。
 *
 * 例:`worker=opencode/glm-5.3, reviewer=minimax/MiniMax-M3.1-Flash` 或多行写法。
 * 角色名 `default` 表示「未指派时的默认模型」。
 * 非法项(没有 `=`)直接忽略,不抛错(避免一条笔误毁掉整次运行)。
 */
export function parseModelPool(raw: string | undefined | null): Record<string, string> {
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

/**
 * 解析行为准则:多行文本,每行一条;去掉空行与行首的 `-`/`*` 列表符号。
 */
export function parseGuidelines(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*+]\s+/, '').trim())
    .filter((line) => line !== '');
}

/**
 * 解析全部 action inputs。
 *
 * 默认值:
 *   engine=opencode / model=空则取 env AIWF_MODEL / base_branch=空则运行时取当前分支 /
 *   branch_prefix=aiwf/ / max_parallel=4 / dry_run=false
 *   trigger_policy=trusted / allowed_actors=空 / daily_run_limit=0 / max_tasks=6 / timeout_ms=1200000
 *
 * 回退顺序(新增 inputs):input > 环境变量 > 默认值。
 */
export function parseActionInputs(reader: RawInputReader, env: EnvLike = {}): ParseInputsOutcome {
  const errors: string[] = [];

  // ---- task_ref(必填) ----
  const rawTaskRef = reader.getInput('task_ref');
  const taskRefError = validateTaskRef(rawTaskRef);
  if (taskRefError !== null) {
    errors.push(taskRefError);
  }

  // ---- engine(默认 opencode) ----
  const rawEngine = reader.getInput('engine').trim();
  let engine: EngineKind = DEFAULT_ENGINE;
  if (rawEngine !== '') {
    if ((ENGINE_CHOICES as readonly string[]).includes(rawEngine)) {
      engine = rawEngine as EngineKind;
    } else {
      errors.push(`engine 取值不支持:"${rawEngine}"(可选:${ENGINE_CHOICES.join(' | ')})。`);
    }
  }

  // ---- model(输入优先;空则回退 env AIWF_MODEL) ----
  let model = reader.getInput('model').trim();
  if (model === '') {
    model = (env[MODEL_ENV_FALLBACK] ?? '').trim();
  }

  // ---- base_branch(空 → 运行时取当前分支) ----
  const baseBranch = reader.getInput('base_branch').trim();

  // ---- branch_prefix(默认 aiwf/) ----
  const branchPrefix = reader.getInput('branch_prefix').trim() || DEFAULT_BRANCH_PREFIX;

  // ---- max_parallel(默认 4,须为 1~8 的整数) ----
  const rawMaxParallel = reader.getInput('max_parallel').trim();
  let maxParallel: number = DEFAULT_MAX_PARALLEL;
  if (rawMaxParallel !== '') {
    const parsed = Number(rawMaxParallel);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push(`max_parallel 必须是正整数,收到:"${rawMaxParallel}"。`);
    } else if (parsed > MAX_PARALLEL_HARD_LIMIT) {
      errors.push(
        `max_parallel 超出硬上限 ${MAX_PARALLEL_HARD_LIMIT},收到:"${rawMaxParallel}"(允许 1~${MAX_PARALLEL_HARD_LIMIT})。`,
      );
    } else {
      maxParallel = parsed;
    }
  }

  // ---- dry_run(默认 false;@actions/core 的 getBooleanInput 对合法值之外会抛错) ----
  let dryRun = false;
  try {
    dryRun = reader.getBooleanInput('dry_run');
  } catch (error) {
    errors.push(`dry_run 仅接受 true/false:"${error instanceof Error ? error.message : String(error)}"。`);
  }

  // ---- trigger_policy(默认 trusted) ----
  const rawTriggerPolicy = firstNonEmpty(
    reader.getInput('trigger_policy').trim(),
    (env[TRIGGER_POLICY_ENV_FALLBACK] ?? '').trim(),
  );
  let triggerPolicy: TriggerPolicy = DEFAULT_TRIGGER_POLICY;
  if (rawTriggerPolicy !== '') {
    if ((TRIGGER_POLICY_CHOICES as readonly string[]).includes(rawTriggerPolicy)) {
      triggerPolicy = rawTriggerPolicy as TriggerPolicy;
    } else {
      errors.push(
        `trigger_policy 取值不支持:"${rawTriggerPolicy}"(可选:${TRIGGER_POLICY_CHOICES.join(' | ')})。`,
      );
    }
  }

  // ---- allowed_actors(逗号分隔;去空白与空项,保留原大小写) ----
  const rawAllowedActors = firstNonEmpty(
    reader.getInput('allowed_actors').trim(),
    (env[ALLOWED_ACTORS_ENV_FALLBACK] ?? '').trim(),
  );
  const allowedActors = parseAllowedActors(rawAllowedActors);

  // ---- daily_run_limit(默认 0 = 不限;须为 ≥0 的整数) ----
  const rawDailyRunLimit = firstNonEmpty(
    reader.getInput('daily_run_limit').trim(),
    (env[DAILY_RUN_LIMIT_ENV_FALLBACK] ?? '').trim(),
  );
  let dailyRunLimit: number = DEFAULT_DAILY_RUN_LIMIT;
  if (rawDailyRunLimit !== '') {
    const parsed = Number(rawDailyRunLimit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      errors.push(`daily_run_limit 必须是 ≥0 的整数,收到:"${rawDailyRunLimit}"(0 表示不限)。`);
    } else {
      dailyRunLimit = parsed;
    }
  }

  // ---- max_tasks(默认 6;须为 1~10 的整数) ----
  const rawMaxTasks = firstNonEmpty(
    reader.getInput('max_tasks').trim(),
    (env[MAX_TASKS_ENV_FALLBACK] ?? '').trim(),
  );
  let maxTasks: number = DEFAULT_MAX_TASKS;
  if (rawMaxTasks !== '') {
    const parsed = Number(rawMaxTasks);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TASKS_HARD_LIMIT) {
      errors.push(
        `max_tasks 必须是 1~${MAX_TASKS_HARD_LIMIT} 的整数,收到:"${rawMaxTasks}"。`,
      );
    } else {
      maxTasks = parsed;
    }
  }

  // ---- timeout_ms(默认 1200000;须为 60000~3600000 的整数) ----
  const rawTimeoutMs = firstNonEmpty(
    reader.getInput('timeout_ms').trim(),
    (env[TIMEOUT_MS_ENV_FALLBACK] ?? '').trim(),
  );
  let timeoutMs: number = DEFAULT_TIMEOUT_MS;
  if (rawTimeoutMs !== '') {
    const parsed = Number(rawTimeoutMs);
    if (!Number.isInteger(parsed) || parsed < TIMEOUT_MS_MIN || parsed > TIMEOUT_MS_MAX) {
      errors.push(
        `timeout_ms 必须是 ${TIMEOUT_MS_MIN}~${TIMEOUT_MS_MAX} 的整数,收到:"${rawTimeoutMs}"。`,
      );
    } else {
      timeoutMs = parsed;
    }
  }

  // ---- models(模型池:role=model,逗号或换行分隔;可空) ----
  const rawModels = firstNonEmpty(
    reader.getInput('models').trim(),
    (env[MODELS_ENV_FALLBACK] ?? '').trim(),
  );
  const modelPool = parseModelPool(rawModels);
  for (const [role, model] of Object.entries(modelPool)) {
    if (!/^[A-Za-z0-9._-]+$/.test(role)) {
      errors.push(`models 里的角色名非法:"${role}"(只允许字母/数字/点/下划线/短横线)。`);
    }
    if (!/^[^\s]+$/.test(model)) {
      errors.push(`models 里的模型取值非法(角色 ${role}):"${model}"。`);
    }
  }

  // ---- guidelines(行为准则:多行文本,每行一条) ----
  const rawGuidelines = firstNonEmpty(
    reader.getInput('guidelines').trim(),
    (env[GUIDELINES_ENV_FALLBACK] ?? '').trim(),
  );
  const guidelines = parseGuidelines(rawGuidelines);

  // ---- budget(相对成本预算上限;0 = 不限) ----
  const rawBudget = firstNonEmpty(
    reader.getInput('budget').trim(),
    (env[BUDGET_ENV_FALLBACK] ?? '').trim(),
  );
  let budgetUnits: number = DEFAULT_BUDGET_UNITS;
  if (rawBudget !== '') {
    const parsed = Number(rawBudget);
    if (!Number.isInteger(parsed) || parsed < 0) {
      errors.push(`budget 必须是 ≥0 的整数(相对成本单位),收到:"${rawBudget}"(0 表示不限)。`);
    } else {
      budgetUnits = parsed;
    }
  }

  // ---- approve(两段式审批;默认 false) ----
  let approve = false;
  try {
    approve = reader.getBooleanInput('approve');
  } catch (error) {
    errors.push(`approve 仅接受 true/false:"${error instanceof Error ? error.message : String(error)}"。`);
  }

  // ---- idempotent(幂等短路;默认 true) ----
  let idempotent = true;
  try {
    const raw = reader.getInput('idempotent').trim();
    if (raw !== '') idempotent = reader.getBooleanInput('idempotent');
  } catch (error) {
    errors.push(`idempotent 仅接受 true/false:"${error instanceof Error ? error.message : String(error)}"。`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    inputs: {
      taskRef: rawTaskRef.trim(),
      engine,
      model: model === '' ? undefined : model,
      baseBranch: baseBranch === '' ? undefined : baseBranch,
      branchPrefix,
      maxParallel,
      dryRun,
      triggerPolicy,
      allowedActors,
      dailyRunLimit,
      maxTasks,
      timeoutMs,
      modelPool,
      guidelines,
      budgetUnits,
      approve,
      idempotent,
    },
  };
}

/** 取第一个非空字符串(用于 input > env 的回退顺序)。 */
function firstNonEmpty(...candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate !== '') {
      return candidate;
    }
  }
  return '';
}
