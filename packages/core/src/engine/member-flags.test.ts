/**
 * engine/member-flags:按角色解析成员执行姿态(纯函数)。
 */

import { describe, expect, it } from 'vitest';

import { READONLY_ROLES, isReadonlyRole, resolveMemberFlags } from './opencode.js';

describe('isReadonlyRole', () => {
  it('评审类角色 → 只读', () => {
    for (const role of READONLY_ROLES) {
      expect(isReadonlyRole(role), role).toBe(true);
    }
    expect(isReadonlyRole('Reviewer')).toBe(true);
    expect(isReadonlyRole('reviewer-lite')).toBe(true);
  });

  it('实现类/打包类角色 → 可写', () => {
    for (const role of ['implementer', 'packager', 'integrator', '']) {
      expect(isReadonlyRole(role), role).toBe(false);
    }
  });

  it('拿不准的评审类角色名按只读处理(更安全、更省;可用 extraArgs 覆盖)', () => {
    expect(isReadonlyRole('reviewer-helper')).toBe(true);
  });
});

describe('resolveMemberFlags', () => {
  it('只读评审 → 用内置只读 agent,且不放行写权限', () => {
    expect(resolveMemberFlags('reviewer')).toEqual(['--agent', 'plan']);
    expect(resolveMemberFlags('reviewer')).not.toContain('--auto');
  });

  it('实现类 → 放行权限(--auto)', () => {
    expect(resolveMemberFlags('implementer')).toEqual(['--auto']);
    expect(resolveMemberFlags('packager')).toEqual(['--auto']);
  });

  it('调用方显式给了 --agent → 不再追加只读 agent', () => {
    expect(resolveMemberFlags('reviewer', ['--agent', 'custom'])).toEqual([]);
  });

  it('调用方显式给了 --auto → 不再追加 --auto', () => {
    expect(resolveMemberFlags('implementer', ['--auto'])).toEqual([]);
  });

  it('只读角色 + 调用方显式 --auto → 尊重显式配置(不追加 agent)', () => {
    expect(resolveMemberFlags('reviewer', ['--auto'])).toEqual([]);
  });
});
