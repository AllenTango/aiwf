/**
 * @aiwf/action — inputs 解析与 task_ref 校验(纯逻辑表驱动测试)。OWNER: M4.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ACTORS_ENV_FALLBACK,
  DAILY_RUN_LIMIT_ENV_FALLBACK,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_DAILY_RUN_LIMIT,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_MAX_TASKS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRIGGER_POLICY,
  ENGINE_CHOICES,
  MAX_PARALLEL_HARD_LIMIT,
  MAX_TASKS_ENV_FALLBACK,
  MAX_TASKS_HARD_LIMIT,
  MODEL_ENV_FALLBACK,
  parseActionInputs,
  TASK_REF_PATTERN,
  TIMEOUT_MS_ENV_FALLBACK,
  TIMEOUT_MS_MAX,
  TIMEOUT_MS_MIN,
  TRIGGER_POLICY_CHOICES,
  TRIGGER_POLICY_ENV_FALLBACK,
  validateTaskRef,
  type RawInputReader,
} from './inputs.js';

const VALID_REFS = ['my-org/my-repo#42', 'a_person.dev/repo-name_2#0', 'OWNER/Repo#999'] as const;
const INVALID_REFS = [
  '',
  '   ',
  'no-ref',
  'my-org/my-repo',
  'my-org/my-repo#abc',
  '#42',
  '/repo#42',
  'my-org/#42',
  'my-org/my-repo#',
  'my-org/my-repo#42/extra',
  // 按规格正则 ^[\w.-]+/[\w.-]+#\d+$,\w 为 ASCII 语义:非 ASCII(org 名带中文)不合法。
  'a_person蒋.dev/repo-name_2#0',
] as const;

describe('validateTaskRef(纯校验器)', () => {
  it.each(VALID_REFS)('合法引用:"%s" → null', (ref) => {
    expect(validateTaskRef(ref)).toBeNull();
  });

  it.each(INVALID_REFS)('非法引用:"%s" → 返回含 task_ref 的错误信息', (ref) => {
    expect(validateTaskRef(ref)).toContain('task_ref');
  });

  it('undefined/null 视为空字符串处理', () => {
    expect(validateTaskRef(undefined)).toContain('task_ref');
    expect(validateTaskRef(null)).toContain('task_ref');
  });

  it('首尾空白被容忍(trim 后校验)', () => {
    expect(validateTaskRef('  my-org/my-repo#42  ')).toBeNull();
  });

  it('正则确实要求分隔符 / 与 #(导出常量本身的行为)', () => {
    expect(TASK_REF_PATTERN.test('owner/repo#1')).toBe(true);
    expect(TASK_REF_PATTERN.test('owner#1')).toBe(false);
    expect(TASK_REF_PATTERN.test('owner/repo')).toBe(false);
  });
});

/** 近似 @actions/core 行为的最小读取桩:getBooleanInput 仅接受 true/false(大小写不敏感)。 */
function makeReader(
  values: Record<string, string> = {},
): RawInputReader {
  return {
    getInput: (name) => values[name] ?? '',
    getBooleanInput: (name) => {
      const raw = (values[name] ?? 'false').trim().toLowerCase();
      if (raw !== 'true' && raw !== 'false') {
        throw new Error(`getBooleanInput 拒绝取值:${name}="${raw}"`);
      }
      return raw === 'true';
    },
  };
}

describe('parseActionInputs(默认值)', () => {
  it('仅提供必填 task_ref 时,其余全部取默认值', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#7' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return; // narrowing
    expect(outcome.inputs).toEqual({
      taskRef: 'org/repo#7',
      engine: 'opencode',
      model: undefined,
      baseBranch: undefined,
      branchPrefix: 'aiwf/',
      maxParallel: 4,
      dryRun: false,
      triggerPolicy: 'trusted',
      allowedActors: [],
      dailyRunLimit: 0,
      maxTasks: 6,
      timeoutMs: 1200000,
      modelPool: {},
      guidelines: [],
      budgetUnits: 0,
      approve: false,
      idempotent: true,
    });
    expect(outcome.inputs.branchPrefix).toBe(DEFAULT_BRANCH_PREFIX);
    expect(outcome.inputs.maxParallel).toBe(DEFAULT_MAX_PARALLEL);
    expect(outcome.inputs.triggerPolicy).toBe(DEFAULT_TRIGGER_POLICY);
    expect(outcome.inputs.dailyRunLimit).toBe(DEFAULT_DAILY_RUN_LIMIT);
    expect(outcome.inputs.maxTasks).toBe(DEFAULT_MAX_TASKS);
    expect(outcome.inputs.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('缺失 task_ref → ok=false 且错误提及 task_ref 必填', () => {
    const outcome = parseActionInputs(makeReader({}));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((message) => message.includes('task_ref 必填'))).toBe(true);
  });

  it('task_ref 前后空白被裁剪', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: ' org/repo#1 ' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.taskRef).toBe('org/repo#1');
  });
});

describe('parseActionInputs(model 回退 env AIWF_MODEL)', () => {
  it('输入为空 → 回读 env', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1' }),
      { [MODEL_ENV_FALLBACK]: ' opencode/glm-5.3-free ' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.model).toBe('opencode/glm-5.3-free');
  });

  it('显式输入优先于 env', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', model: 'mock/model-x' }),
      { [MODEL_ENV_FALLBACK]: 'opencode/glm-5.3-free' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.model).toBe('mock/model-x');
  });

  it('两处皆为空 → model undefined(引擎用默认模型)', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.model).toBeUndefined();
  });
});

describe('parseActionInputs(engine)', () => {
  it('engine=mock 被接受(全部合法取值)', () => {
    for (const choice of ENGINE_CHOICES) {
      const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', engine: choice }));
      expect(outcome.ok).toBe(true);
      if (outcome.ok === false) return;
      expect(outcome.inputs.engine).toBe(choice);
    }
  });

  it('engine=未知值 → ok=false 且列出可选值', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', engine: 'gpt5' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((message) => message.includes('opencode | mock'))).toBe(true);
  });
});

describe('parseActionInputs(max_parallel / dry_run / base_branch)', () => {
  it('max_parallel=2 生效', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', max_parallel: '2' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.maxParallel).toBe(2);
  });

  it.each(['0', '-1', '1.5', 'four'])('max_parallel=%s → ok=false', (badValue) => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', max_parallel: badValue }));
    expect(outcome.ok).toBe(false);
  });

  it('max_parallel=9 → ok=false 且提示硬上限 8', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', max_parallel: '9' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(
      outcome.errors.some(
        (message) => message.includes('max_parallel') && message.includes('8'),
      ),
    ).toBe(true);
  });

  it('max_parallel=8(硬上限)→ 接受', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', max_parallel: '8' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.maxParallel).toBe(MAX_PARALLEL_HARD_LIMIT);
  });

  it('dry_run=true 生效', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', dry_run: 'true' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.dryRun).toBe(true);
  });

  it('dry_run=非法布尔(getBooleanInput 抛错)→ ok=false 且归并到错误列表', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', dry_run: 'maybe' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((message) => message.includes('dry_run'))).toBe(true);
  });

  it('dry_run=非法时不阻断其他错误收集(多错误一次报全)', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'nope', max_parallel: '0', dry_run: 'maybe' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('base_branch 显式传入则保留', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', base_branch: 'develop' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.baseBranch).toBe('develop');
  });
});

// ---------------------------------------------------------------------------
// M3:触发准入 / 额度配额相关 inputs
// ---------------------------------------------------------------------------

describe('parseActionInputs(trigger_policy)', () => {
  it.each(TRIGGER_POLICY_CHOICES)('合法取值 %s → 生效', (policy) => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', trigger_policy: policy }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.triggerPolicy).toBe(policy);
  });

  it('trigger_policy=foo → ok=false 且错误提及 trigger_policy', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', trigger_policy: 'foo' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((message) => message.includes('trigger_policy'))).toBe(true);
  });

  it('input 为空 → 回退 env AIWF_TRIGGER_POLICY', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1' }),
      { [TRIGGER_POLICY_ENV_FALLBACK]: 'anyone' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.triggerPolicy).toBe('anyone');
  });

  it('显式 input 优先于 env', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', trigger_policy: 'trusted' }),
      { [TRIGGER_POLICY_ENV_FALLBACK]: 'anyone' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.triggerPolicy).toBe('trusted');
  });

  it('env 中的非法取值同样报错', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1' }),
      { [TRIGGER_POLICY_ENV_FALLBACK]: 'nope' },
    );
    expect(outcome.ok).toBe(false);
  });

  it('input 与 env 皆空 → 默认 trusted', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.triggerPolicy).toBe('trusted');
  });
});

describe('parseActionInputs(allowed_actors)', () => {
  it('逗号分隔 → 去空白去空项,保留原大小写', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', allowed_actors: ' Alice , bob ,, ,Carol ' }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.allowedActors).toEqual(['Alice', 'bob', 'Carol']);
  });

  it('空字符串 → 空数组', () => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', allowed_actors: '  ,  ' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.allowedActors).toEqual([]);
  });

  it('input 为空 → 回退 env AIWF_ALLOWED_ACTORS', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1' }),
      { [ALLOWED_ACTORS_ENV_FALLBACK]: 'zoe,yan' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.allowedActors).toEqual(['zoe', 'yan']);
  });

  it('显式 input 优先于 env', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', allowed_actors: 'alice' }),
      { [ALLOWED_ACTORS_ENV_FALLBACK]: 'zoe' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.allowedActors).toEqual(['alice']);
  });
});

describe('parseActionInputs(daily_run_limit)', () => {
  it('0 表示不限 → 接受', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', daily_run_limit: '0' }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.dailyRunLimit).toBe(0);
  });

  it('20 生效', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', daily_run_limit: '20' }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.dailyRunLimit).toBe(20);
  });

  it.each(['-1', '1.5', 'many'])('daily_run_limit=%s → ok=false', (badValue) => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', daily_run_limit: badValue }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((message) => message.includes('daily_run_limit'))).toBe(true);
  });

  it('input 为空 → 回退 env AIWF_DAILY_RUN_LIMIT', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1' }),
      { [DAILY_RUN_LIMIT_ENV_FALLBACK]: '7' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.dailyRunLimit).toBe(7);
  });

  it('显式 input 优先于 env', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', daily_run_limit: '3' }),
      { [DAILY_RUN_LIMIT_ENV_FALLBACK]: '9' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.dailyRunLimit).toBe(3);
  });
});

describe('parseActionInputs(max_tasks)', () => {
  it('边界 1 与 10 均接受', () => {
    for (const value of ['1', '10']) {
      const outcome = parseActionInputs(
        makeReader({ task_ref: 'org/repo#1', max_tasks: value }),
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok === false) return;
      expect(outcome.inputs.maxTasks).toBe(Number(value));
    }
  });

  it.each(['0', '-1', '11', '2.5', 'six'])('max_tasks=%s → ok=false', (badValue) => {
    const outcome = parseActionInputs(makeReader({ task_ref: 'org/repo#1', max_tasks: badValue }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((message) => message.includes('max_tasks'))).toBe(true);
  });

  it('input 为空 → 回退 env AIWF_MAX_TASKS', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1' }),
      { [MAX_TASKS_ENV_FALLBACK]: '4' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.maxTasks).toBe(4);
  });

  it('显式 input 优先于 env', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', max_tasks: '2' }),
      { [MAX_TASKS_ENV_FALLBACK]: '9' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.maxTasks).toBe(2);
  });

  it('硬上限常量为 10', () => {
    expect(MAX_TASKS_HARD_LIMIT).toBe(10);
  });
});

describe('parseActionInputs(timeout_ms)', () => {
  it('边界 60000 与 3600000 均接受', () => {
    for (const value of [String(TIMEOUT_MS_MIN), String(TIMEOUT_MS_MAX)]) {
      const outcome = parseActionInputs(
        makeReader({ task_ref: 'org/repo#1', timeout_ms: value }),
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok === false) return;
      expect(outcome.inputs.timeoutMs).toBe(Number(value));
    }
  });

  it.each(['59999', '3600001', '0', '-1', '1.5'])('timeout_ms=%s → ok=false', (badValue) => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', timeout_ms: badValue }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((message) => message.includes('timeout_ms'))).toBe(true);
  });

  it('input 为空 → 回退 env AIWF_TIMEOUT_MS', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1' }),
      { [TIMEOUT_MS_ENV_FALLBACK]: '900000' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.timeoutMs).toBe(900000);
  });

  it('显式 input 优先于 env', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#1', timeout_ms: '300000' }),
      { [TIMEOUT_MS_ENV_FALLBACK]: '900000' },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.timeoutMs).toBe(300000);
  });
});

describe('parseActionInputs(models / guidelines / budget)', () => {
  it('models:逗号分隔的 role=model → 模型池', () => {
    const outcome = parseActionInputs(
      makeReader({
        task_ref: 'org/repo#7',
        models: 'worker=opencode/glm-5.3, reviewer=minimax/MiniMax-M3.1-Flash',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.modelPool).toEqual({
      worker: 'opencode/glm-5.3',
      reviewer: 'minimax/MiniMax-M3.1-Flash',
    });
  });

  it('models:多行写法同样可解析;非法项被忽略', () => {
    const outcome = parseActionInputs(
      makeReader({
        task_ref: 'org/repo#7',
        models: 'worker=opencode/glm-5.3\nreviewer=minimax/x\n这一行没有等号',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(Object.keys(outcome.inputs.modelPool)).toEqual(['worker', 'reviewer']);
  });

  it('models:角色名非法 → 报错', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#7', models: 'bad role=opencode/glm-5.3' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.some((m) => m.includes('角色名非法'))).toBe(true);
  });

  it('guidelines:多行 → 每行一条,列表符号被剥掉', () => {
    const outcome = parseActionInputs(
      makeReader({
        task_ref: 'org/repo#7',
        guidelines: '提交前必须跑 pnpm test\n- 不允许改动 contracts/\n\n',
      }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.guidelines).toEqual(['提交前必须跑 pnpm test', '不允许改动 contracts/']);
  });

  it('budget:正整数 → 相对成本预算上限;非法 → 报错', () => {
    const ok = parseActionInputs(makeReader({ task_ref: 'org/repo#7', budget: '12' }));
    expect(ok.ok).toBe(true);
    if (ok.ok === false) return;
    expect(ok.inputs.budgetUnits).toBe(12);

    const bad = parseActionInputs(makeReader({ task_ref: 'org/repo#7', budget: '-3' }));
    expect(bad.ok).toBe(false);
    if (bad.ok === true) return;
    expect(bad.errors.some((m) => m.includes('budget 必须是'))).toBe(true);
  });

  it('approve:默认 false;显式 true → 开启两段式审批', () => {
    const off = parseActionInputs(makeReader({ task_ref: 'org/repo#7' }));
    expect(off.ok).toBe(true);
    if (off.ok === false) return;
    expect(off.inputs.approve).toBe(false);

    const on = parseActionInputs(makeReader({ task_ref: 'org/repo#7', approve: 'true' }));
    expect(on.ok).toBe(true);
    if (on.ok === false) return;
    expect(on.inputs.approve).toBe(true);
  });

  it('idempotent:默认 true;显式 false → 关闭幂等短路', () => {
    const on = parseActionInputs(makeReader({ task_ref: 'org/repo#7' }));
    expect(on.ok).toBe(true);
    if (on.ok === false) return;
    expect(on.inputs.idempotent).toBe(true);

    const off = parseActionInputs(makeReader({ task_ref: 'org/repo#7', idempotent: 'false' }));
    expect(off.ok).toBe(true);
    if (off.ok === false) return;
    expect(off.inputs.idempotent).toBe(false);
  });

  it('环境变量回退:AIWF_MODELS / AIWF_GUIDELINES / AIWF_BUDGET', () => {
    const outcome = parseActionInputs(
      makeReader({ task_ref: 'org/repo#7' }),
      {
        AIWF_MODELS: 'worker=opencode/glm-5.3',
        AIWF_GUIDELINES: '跑测试',
        AIWF_BUDGET: '20',
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.inputs.modelPool['worker']).toBe('opencode/glm-5.3');
    expect(outcome.inputs.guidelines).toEqual(['跑测试']);
    expect(outcome.inputs.budgetUnits).toBe(20);
  });
});

describe('parseActionInputs(多错误一次报全)', () => {
  it('5 个新 input 同时非法 → errors 至少 5 条', () => {
    const outcome = parseActionInputs(
      makeReader({
        task_ref: 'org/repo#1',
        trigger_policy: 'foo',
        daily_run_limit: '-1',
        max_tasks: '11',
        timeout_ms: '59999',
        max_parallel: '9',
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.errors.length).toBeGreaterThanOrEqual(5);
  });
});
