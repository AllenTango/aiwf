/**
 * @aiwf/action — github-platform 内纯函数(parseTaskRef / 错误描述)测试。
 * OWNER: M4. 不实例化客户端(Octokit 构造需要真实 context),网络层路径由联调覆盖。
 */
import { describe, expect, it } from 'vitest';
import { describeGitHubError, getHttpStatusCode, parseTaskRef } from './github-platform.js';

describe('parseTaskRef(纯函数)', () => {
  it('合法引用 → 精确拆出 owner/repo/number', () => {
    expect(parseTaskRef('my-org/my-repo#42')).toEqual({ owner: 'my-org', repo: 'my-repo', number: 42 });
    expect(parseTaskRef('a.dev_x/y-2#0')).toEqual({ owner: 'a.dev_x', repo: 'y-2', number: 0 });
  });

  it('(trim)容忍首尾空白', () => {
    expect(parseTaskRef(' my-org/my-repo#7 ')).toEqual({ owner: 'my-org', repo: 'my-repo', number: 7 });
  });

  it('非法引用 → null', () => {
    expect(parseTaskRef('my-org/my-repo')).toBeNull();
    expect(parseTaskRef('my-org#7')).toBeNull();
    expect(parseTaskRef('my-org/my-repo#abc')).toBeNull();
    expect(parseTaskRef('')).toBeNull();
  });
});

describe('describeGitHubError(错误描述)', () => {
  it('RequestError 形状(status + message)→ "HTTP 404 · Not Found"', () => {
    expect(describeGitHubError({ status: 404, message: 'Not Found' })).toBe('HTTP 404 · Not Found');
  });

  it('普通 Error → message', () => {
    expect(describeGitHubError(new Error('plain'))).toBe('plain');
  });

  it('字符串/undefined 兜底', () => {
    expect(describeGitHubError('oops')).toBe('oops');
    expect(describeGitHubError(undefined)).toBe('undefined');
  });

  it('对象但不可读字段 → String(error)', () => {
    expect(describeGitHubError({ status: 'bad' })).toContain('[object Object]');
  });
});

describe('getHttpStatusCode', () => {
  it('数值 status 透出', () => {
    expect(getHttpStatusCode({ status: 422 })).toBe(422);
  });

  it('非数值 / 缺失 → undefined', () => {
    expect(getHttpStatusCode({ status: '422' })).toBeUndefined();
    expect(getHttpStatusCode(new Error('no status'))).toBeUndefined();
  });
});
