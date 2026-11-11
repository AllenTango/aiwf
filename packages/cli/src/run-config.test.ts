import { describe, expect, it } from 'vitest';
import { UsageError } from './errors.js';
import {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_ENGINE,
  DEFAULT_MAX_PARALLEL,
  OPENCODE_DEFAULT_TIMEOUT_MS,
  resolveRunConfig,
} from './run-config.js';
import type { RunFlagValues } from './run-config.js';

describe('defaults (no flags, no env)', () => {
  it('opencode + 20min timeout + 4 parallel + aiwf/ prefix', () => {
    const config = resolveRunConfig({}, {});
    expect(config.engine).toBe(DEFAULT_ENGINE);
    expect(config.engine).toBe('opencode');
    expect(config.model).toBeUndefined();
    expect(config.timeoutMs).toBe(OPENCODE_DEFAULT_TIMEOUT_MS);
    expect(config.timeoutMs).toBe(1_200_000);
    expect(config.maxParallel).toBe(DEFAULT_MAX_PARALLEL);
    expect(config.maxParallel).toBe(4);
    expect(config.branchPrefix).toBe(DEFAULT_BRANCH_PREFIX);
    expect(config.branchPrefix).toBe('aiwf/');
    expect(config.dryRun).toBe(false);
    expect(config.json).toBe(false);
    expect(config.repoDirHint).toBe('.');
    expect(config.baseBranch).toBeUndefined();
  });
});

describe('env level', () => {
  it('AIWF_ENGINE / AIWF_MODEL fill from environment', () => {
    const config = resolveRunConfig(
      {},
      { AIWF_ENGINE: 'mock', AIWF_MODEL: 'env/model' },
    );
    expect(config.engine).toBe('mock');
    expect(config.model).toBe('env/model');
    // mock has no per-engine timeout default
    expect(config.timeoutMs).toBeUndefined();
  });

  it('AIWF_TIMEOUT_MS / AIWF_MAX_PARALLEL / AIWF_BASE_BRANCH / AIWF_BRANCH_PREFIX', () => {
    const config = resolveRunConfig(
      {},
      {
        AIWF_TIMEOUT_MS: '98765',
        AIWF_MAX_PARALLEL: '2',
        AIWF_BASE_BRANCH: 'develop',
        AIWF_BRANCH_PREFIX: 'teamx',
      },
    );
    expect(config.timeoutMs).toBe(98765);
    expect(config.maxParallel).toBe(2);
    expect(config.baseBranch).toBe('develop');
    expect(config.branchPrefix).toBe('teamx/'); // normalized trailing '/'
  });

  it('blank env values fall back to defaults', () => {
    const config = resolveRunConfig(
      {},
      { AIWF_ENGINE: '  ', AIWF_MODEL: '', AIWF_TIMEOUT_MS: ' ' },
    );
    expect(config.engine).toBe('opencode');
    expect(config.model).toBeUndefined();
    expect(config.timeoutMs).toBe(1_200_000);
  });
});

describe('flags beat env', () => {
  const env = {
    AIWF_ENGINE: 'mock',
    AIWF_MODEL: 'env/m',
    AIWF_TIMEOUT_MS: '111',
    AIWF_MAX_PARALLEL: '2',
    AIWF_BASE_BRANCH: 'env-b',
    AIWF_BRANCH_PREFIX: 'env-p',
  };

  it('engine / model / timeout / max-parallel', () => {
    const config = resolveRunConfig(
      {
        engine: 'opencode',
        model: 'flag/m',
        timeoutMs: '999999',
        maxParallel: '3',
      },
      env,
    );
    expect(config.engine).toBe('opencode');
    expect(config.model).toBe('flag/m');
    expect(config.timeoutMs).toBe(999999);
    expect(config.maxParallel).toBe(3);
  });

  it('base-branch / branch-prefix / repo dir', () => {
    const config = resolveRunConfig(
      {
        baseBranch: 'flag-b',
        branchPrefix: 'flag-p',
        dir: 'some/repo',
      },
      env,
    );
    expect(config.baseBranch).toBe('flag-b');
    expect(config.branchPrefix).toBe('flag-p/');
    expect(config.repoDirHint).toBe('some/repo');
  });

  it('dry-run & json boolean flags', () => {
    const config = resolveRunConfig({ dryRun: true, json: true }, {});
    expect(config.dryRun).toBe(true);
    expect(config.json).toBe(true);
  });
});

describe('validation failures (usage → exit 2)', () => {
  it('unknown engine kind', () => {
    expect(() => resolveRunConfig({ engine: 'sky' }, {})).toThrowError(UsageError);
    expect(() => resolveRunConfig({}, { AIWF_ENGINE: 'sky' })).toThrowError(/仅支持/);
  });

  it('max-parallel must be a positive integer (flag & env)', () => {
    expect(() => resolveRunConfig({ maxParallel: '0' }, {})).toThrowError(/正整数/);
    expect(() => resolveRunConfig({ maxParallel: 'abc' }, {})).toThrowError(UsageError);
    expect(() => resolveRunConfig({ maxParallel: '2.5' }, {})).toThrowError(UsageError);
    expect(() => resolveRunConfig({}, { AIWF_MAX_PARALLEL: '-3' })).toThrowError(
      UsageError,
    );
  });

  it('timeout-ms must be a positive integer', () => {
    expect(() => resolveRunConfig({ timeoutMs: '-1' }, {})).toThrowError(UsageError);
    expect(() => resolveRunConfig({ timeoutMs: 'xyz' }, {})).toThrowError(/正整数/);
    expect(() => resolveRunConfig({}, { AIWF_TIMEOUT_MS: '0' })).toThrowError(
      UsageError,
    );
  });
});
