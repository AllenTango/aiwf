/**
 * @aiwf/action — 输入解析(纯逻辑,便于表驱动测试)。
 * OWNER: M4.
 *
 * 与根目录 action.yml 的 inputs 一一对应:
 *   task_ref(必填) / engine / model / base_branch / branch_prefix / max_parallel / dry_run
 *
 * 约定:不直接 import @actions/core(由 main.ts 注入 RawInputReader),
 * 这样本文件可在 vitest 中零打桩验证所有默认值与校验行为。
 */
import type { EngineKind } from '@aiwf/core';

/** task_ref 的唯一合法形态:`<owner>/<repo>#<issue number>`,如 `my-org/my-repo#42`。 */
export const TASK_REF_PATTERN = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** 支持的引擎取值(与 contracts 的 EngineKind 对齐)。 */
export const ENGINE_CHOICES: readonly EngineKind[] = ['opencode', 'mock'];

export const DEFAULT_ENGINE: EngineKind = 'opencode';
export const DEFAULT_BRANCH_PREFIX = 'aiwf/';
export const DEFAULT_MAX_PARALLEL = 4;

/** model 输入为空时回读的环境变量名(工作流中以 `vars.AIWF_MODEL` 注入)。 */
export const MODEL_ENV_FALLBACK = 'AIWF_MODEL';

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
 * 解析全部 action inputs。
 *
 * 默认值:
 *   engine=opencode / model=空则取 env AIWF_MODEL / base_branch=空则运行时取当前分支 /
 *   branch_prefix=aiwf/ / max_parallel=4 / dry_run=false
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

  // ---- max_parallel(默认 4,须为正整数) ----
  const rawMaxParallel = reader.getInput('max_parallel').trim();
  let maxParallel: number = DEFAULT_MAX_PARALLEL;
  if (rawMaxParallel !== '') {
    const parsed = Number(rawMaxParallel);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push(`max_parallel 必须是正整数,收到:"${rawMaxParallel}"。`);
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
    },
  };
}
