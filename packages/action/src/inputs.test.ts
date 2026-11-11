/**
 * @aiwf/action — inputs 解析与 task_ref 校验(纯逻辑表驱动测试)。OWNER: M4.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_MAX_PARALLEL,
  ENGINE_CHOICES,
  MODEL_ENV_FALLBACK,
  parseActionInputs,
  TASK_REF_PATTERN,
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
    });
    expect(outcome.inputs.branchPrefix).toBe(DEFAULT_BRANCH_PREFIX);
    expect(outcome.inputs.maxParallel).toBe(DEFAULT_MAX_PARALLEL);
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
