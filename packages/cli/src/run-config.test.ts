import { describe, expect, it } from 'vitest';
import { UsageError } from './errors.js';
import {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_ENGINE,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_MAX_TASKS,
  DEFAULT_TIMEOUT_MS,
  MAX_PARALLEL_HARD_LIMIT,
  MAX_TASKS_HARD_LIMIT,
  OPENCODE_DEFAULT_TIMEOUT_MS,
  TIMEOUT_MS_MAX,
  TIMEOUT_MS_MIN,
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
    expect(config.maxTasks).toBe(DEFAULT_MAX_TASKS);
    expect(config.maxTasks).toBe(6);
    expect(config.branchPrefix).toBe(DEFAULT_BRANCH_PREFIX);
    expect(config.branchPrefix).toBe('aiwf/');
    expect(config.dryRun).toBe(false);
    expect(config.json).toBe(false);
    expect(config.repoDirHint).toBe('.');
    expect(config.baseBranch).toBeUndefined();
  });

  it('mock engine shares the same timeout default (行为一致)', () => {
    const config = resolveRunConfig({ engine: 'mock' }, {});
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.timeoutMs).toBe(1_200_000);
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
    // mock 与 opencode 共用同一超时缺省
    expect(config.timeoutMs).toBe(1_200_000);
  });

  it('AIWF_TIMEOUT_MS / AIWF_MAX_PARALLEL / AIWF_MAX_TASKS / AIWF_BASE_BRANCH / AIWF_BRANCH_PREFIX', () => {
    const config = resolveRunConfig(
      {},
      {
        AIWF_TIMEOUT_MS: '98765',
        AIWF_MAX_PARALLEL: '2',
        AIWF_MAX_TASKS: '5',
        AIWF_BASE_BRANCH: 'develop',
        AIWF_BRANCH_PREFIX: 'teamx',
      },
    );
    expect(config.timeoutMs).toBe(98765);
    expect(config.maxParallel).toBe(2);
    expect(config.maxTasks).toBe(5);
    expect(config.baseBranch).toBe('develop');
    expect(config.branchPrefix).toBe('teamx/'); // normalized trailing '/'
  });

  it('AIWF_MAX_TASKS falls back to the default when blank', () => {
    const config = resolveRunConfig({}, { AIWF_MAX_TASKS: '  ' });
    expect(config.maxTasks).toBe(DEFAULT_MAX_TASKS);
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
    AIWF_TIMEOUT_MS: '60000',
    AIWF_MAX_PARALLEL: '2',
    AIWF_MAX_TASKS: '5',
    AIWF_BASE_BRANCH: 'env-b',
    AIWF_BRANCH_PREFIX: 'env-p',
  };

  it('engine / model / timeout / max-parallel / max-tasks', () => {
    const config = resolveRunConfig(
      {
        engine: 'opencode',
        model: 'flag/m',
        timeoutMs: '999999',
        maxParallel: '3',
        maxTasks: '7',
      },
      env,
    );
    expect(config.engine).toBe('opencode');
    expect(config.model).toBe('flag/m');
    expect(config.timeoutMs).toBe(999999);
    expect(config.maxParallel).toBe(3);
    expect(config.maxTasks).toBe(7);
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

describe('上限边界(--max-parallel / --max-tasks / --timeout-ms)', () => {
  const cases: {
    title: string;
    flags: RunFlagValues;
    env?: Record<string, string>;
    expect?: (config: ReturnType<typeof resolveRunConfig>) => void;
    throws?: RegExp;
  }[] = [
    { title: '--max-parallel 9 越界', flags: { maxParallel: '9' }, throws: /1~8/ },
    { title: '--max-parallel 0 非法', flags: { maxParallel: '0' }, throws: /正整数/ },
    { title: '--max-parallel 4 合法', flags: { maxParallel: '4' } },
    { title: '--max-parallel 8 上界合法', flags: { maxParallel: '8' } },
    {
      title: 'AIWF_MAX_PARALLEL 9 越界',
      flags: {},
      env: { AIWF_MAX_PARALLEL: '9' },
      throws: /1~8/,
    },
    { title: '--max-tasks 11 越界', flags: { maxTasks: '11' }, throws: /1~10/ },
    { title: '--max-tasks 0 非法', flags: { maxTasks: '0' }, throws: /正整数/ },
    { title: '--max-tasks 3 合法', flags: { maxTasks: '3' } },
    { title: '--max-tasks 10 上界合法', flags: { maxTasks: '10' } },
    {
      title: 'AIWF_MAX_TASKS 11 越界',
      flags: {},
      env: { AIWF_MAX_TASKS: '11' },
      throws: /1~10/,
    },
    { title: '--timeout-ms 59999 低于下界', flags: { timeoutMs: '59999' }, throws: /60000~3600000/ },
    { title: '--timeout-ms 3600001 高于上界', flags: { timeoutMs: '3600001' }, throws: /60000~3600000/ },
    { title: '--timeout-ms 900000 合法', flags: { timeoutMs: '900000' } },
    { title: '--timeout-ms 60000 下界合法', flags: { timeoutMs: '60000' } },
    { title: '--timeout-ms 3600000 上界合法', flags: { timeoutMs: '3600000' } },
    {
      title: 'AIWF_TIMEOUT_MS 59999 低于下界',
      flags: {},
      env: { AIWF_TIMEOUT_MS: '59999' },
      throws: /60000~3600000/,
    },
  ];

  for (const item of cases) {
    it(item.title, () => {
      if (item.throws) {
        expect(() => resolveRunConfig(item.flags, item.env ?? {})).toThrowError(
          UsageError,
        );
        expect(() => resolveRunConfig(item.flags, item.env ?? {})).toThrowError(
          item.throws,
        );
        return;
      }
      const config = resolveRunConfig(item.flags, item.env ?? {});
      item.expect?.(config);
    });
  }

  it('硬上限常量与说明一致', () => {
    expect(MAX_PARALLEL_HARD_LIMIT).toBe(8);
    expect(MAX_TASKS_HARD_LIMIT).toBe(10);
    expect(TIMEOUT_MS_MIN).toBe(60_000);
    expect(TIMEOUT_MS_MAX).toBe(3_600_000);
  });
});

describe('wallClockBudgetMs(墙钟预算推导)', () => {
  it('是正整数且 ≥ timeoutMs', () => {
    const configs = [
      resolveRunConfig({}, {}),
      resolveRunConfig({ maxTasks: '3', maxParallel: '1' }, {}),
      resolveRunConfig({ maxTasks: '10', maxParallel: '8' }, {}),
      resolveRunConfig({ timeoutMs: '60000', maxTasks: '1' }, {}),
      resolveRunConfig({ timeoutMs: '3600000', maxTasks: '10', maxParallel: '1' }, {}),
    ];
    for (const config of configs) {
      expect(Number.isInteger(config.wallClockBudgetMs)).toBe(true);
      expect(config.wallClockBudgetMs).toBeGreaterThan(0);
      expect(config.wallClockBudgetMs).toBeGreaterThanOrEqual(config.timeoutMs);
      // 对齐到整秒(1000 的倍数)
      expect(config.wallClockBudgetMs % 1000).toBe(0);
    }
  });

  it('批次数越多预算越大(ceil(maxTasks/maxParallel) × 1.2)', () => {
    const one = resolveRunConfig({ maxTasks: '4', maxParallel: '4' }, {});
    const two = resolveRunConfig({ maxTasks: '5', maxParallel: '4' }, {});
    expect(one.wallClockBudgetMs).toBeLessThan(two.wallClockBudgetMs);
    // 4 任务 / 4 并行 → 1 批:1_200_000 × 1 × 1.2 = 1_440_000
    expect(one.wallClockBudgetMs).toBe(1_440_000);
    // 5 任务 / 4 并行 → 2 批:1_200_000 × 2 × 1.2 = 2_880_000
    expect(two.wallClockBudgetMs).toBe(2_880_000);
  });
});

describe('模型池 / 行为准则 / 成本预算(--models / --guidelines / --budget)', () => {
  it('默认值:空模型池、空准则、预算不限', () => {
    const config = resolveRunConfig({}, {});
    expect(config.modelPool).toEqual({});
    expect(config.guidelines).toEqual([]);
    expect(config.budgetUnits).toBe(0);
  });

  it('flag 优先于环境变量', () => {
    const config = resolveRunConfig(
      { models: 'worker=flag/model', guidelines: 'flag 准则', budget: '5' },
      {
        AIWF_MODELS: 'worker=env/model',
        AIWF_GUIDELINES: 'env 准则',
        AIWF_BUDGET: '99',
      },
    );
    expect(config.modelPool['worker']).toBe('flag/model');
    expect(config.guidelines).toEqual(['flag 准则']);
    expect(config.budgetUnits).toBe(5);
  });

  it('环境变量回退生效', () => {
    const config = resolveRunConfig(
      {},
      { AIWF_MODELS: 'worker=env/model', AIWF_GUIDELINES: '跑测试', AIWF_BUDGET: '20' },
    );
    expect(config.modelPool['worker']).toBe('env/model');
    expect(config.guidelines).toEqual(['跑测试']);
    expect(config.budgetUnits).toBe(20);
  });

  it('多行模型池与多行准则都能解析;列表符号被剥掉', () => {
    const config = resolveRunConfig(
      { models: 'worker=a/b\nreviewer=c/d', guidelines: '- 第一条\n第二条' },
      {},
    );
    expect(Object.keys(config.modelPool)).toEqual(['worker', 'reviewer']);
    expect(config.guidelines).toEqual(['第一条', '第二条']);
  });

  it('budget 非法 → UsageError', () => {
    expect(() => resolveRunConfig({ budget: '-1' }, {})).toThrowError(UsageError);
    expect(() => resolveRunConfig({ budget: 'abc' }, {})).toThrowError(UsageError);
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

  it('max-tasks must be a positive integer (flag & env)', () => {
    expect(() => resolveRunConfig({ maxTasks: 'abc' }, {})).toThrowError(/正整数/);
    expect(() => resolveRunConfig({ maxTasks: '1.5' }, {})).toThrowError(UsageError);
    expect(() => resolveRunConfig({}, { AIWF_MAX_TASKS: '-2' })).toThrowError(
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
