import type { EngineKind } from '@aiwf/core';
import { UsageError } from './errors.js';

export const DEFAULT_ENGINE: EngineKind = 'opencode';
export const DEFAULT_MAX_PARALLEL = 4;
export const DEFAULT_BRANCH_PREFIX = 'aiwf/';
/** opencode engine default per contract: 20 minutes. */
export const OPENCODE_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

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
  baseBranch?: string;
  branchPrefix?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** Env-level fallbacks (flags always win). */
export interface RunEnv {
  AIWF_ENGINE?: string;
  AIWF_MODEL?: string;
  AIWF_TIMEOUT_MS?: string;
  AIWF_MAX_PARALLEL?: string;
  AIWF_BASE_BRANCH?: string;
  AIWF_BRANCH_PREFIX?: string;
}

export interface ResolvedCliConfig {
  engine: EngineKind;
  model?: string;
  timeoutMs?: number;
  maxParallel: number;
  /** Hint only: local PR base branch (also handed to the local platform). */
  baseBranch?: string;
  branchPrefix: string;
  dryRun: boolean;
  json: boolean;
  /** Target repo dir hint; validated against `git rev-parse` by the shell. */
  repoDirHint: string;
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
    parsePositiveInt(
      clean(flags.timeoutMs) ?? clean(env.AIWF_TIMEOUT_MS),
      '--timeout-ms',
    ) ?? (engine === 'opencode' ? OPENCODE_DEFAULT_TIMEOUT_MS : undefined);

  const maxParallel =
    parsePositiveInt(
      clean(flags.maxParallel) ?? clean(env.AIWF_MAX_PARALLEL),
      '--max-parallel',
    ) ?? DEFAULT_MAX_PARALLEL;

  const baseBranch = overrideString(flags.baseBranch, env.AIWF_BASE_BRANCH);

  const branchPrefixRaw = overrideString(flags.branchPrefix, env.AIWF_BRANCH_PREFIX);
  let branchPrefix = branchPrefixRaw ?? DEFAULT_BRANCH_PREFIX;
  if (!branchPrefix.endsWith('/')) branchPrefix = `${branchPrefix}/`;

  return {
    engine,
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    maxParallel,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    branchPrefix,
    dryRun: flags.dryRun === true,
    json: flags.json === true,
    repoDirHint: clean(flags.dir) ?? '.',
  };
}
