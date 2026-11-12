/**
 * @aiwf/action — 触发准入判定(纯函数表驱动测试)。OWNER: M3.
 */
import { describe, expect, it } from 'vitest';
import { evaluateTrigger, TRUSTED_ASSOCIATIONS } from './guard.js';

describe('常量', () => {
  it('TRUSTED_ASSOCIATIONS = OWNER/MEMBER/COLLABORATOR', () => {
    expect([...TRUSTED_ASSOCIATIONS]).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
  });
});

describe('evaluateTrigger(policy=anyone)', () => {
  it('一律放行并带「未限制触发者」提醒', () => {
    const decision = evaluateTrigger({
      policy: 'anyone',
      allowedActors: [],
      actor: 'random-outsider',
      authorAssociation: 'NONE',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('未限制触发者');
    expect(decision.reason).toContain('anyone');
  });

  it('actor 为空同样放行', () => {
    const decision = evaluateTrigger({ policy: 'anyone', allowedActors: [] });
    expect(decision.allowed).toBe(true);
  });
});

describe('evaluateTrigger(policy=trusted,按 author_association)', () => {
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('%s → 放行', (association) => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: [],
      actor: 'someone',
      authorAssociation: association,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('信任名单');
  });

  it.each(['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN'])(
    '%s → 拒绝',
    (association) => {
      const decision = evaluateTrigger({
        policy: 'trusted',
        allowedActors: [],
        actor: 'someone',
        authorAssociation: association,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('不在信任名单内');
    },
  );

  it('拒绝文案写明触发者与权限等级', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: [],
      actor: 'evil-bot',
      authorAssociation: 'NONE',
    });
    expect(decision.reason).toContain('evil-bot');
    expect(decision.reason).toContain('NONE');
  });

  it('actor 与 association 皆缺失 → 拒绝', () => {
    const decision = evaluateTrigger({ policy: 'trusted', allowedActors: [] });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('未知触发者');
  });

  it('association 大小写不敏感(小写 owner 也放行)', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: [],
      actor: 'someone',
      authorAssociation: 'owner',
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('evaluateTrigger(policy=trusted,白名单)', () => {
  it('actor 命中白名单 → 放行', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: ['alice'],
      actor: 'alice',
      authorAssociation: 'NONE',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('白名单');
  });

  it('白名单命中但 association=NONE → 仍放行(白名单优先)', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: ['bob'],
      actor: 'bob',
      authorAssociation: 'NONE',
    });
    expect(decision.allowed).toBe(true);
  });

  it('actor 大小写不敏感(白名单 alice vs 触发者 ALICE)', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: ['alice'],
      actor: 'ALICE',
      authorAssociation: 'NONE',
    });
    expect(decision.allowed).toBe(true);
  });

  it('白名单为空 → 仅依赖 association', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: [],
      actor: 'carol',
      authorAssociation: 'NONE',
    });
    expect(decision.allowed).toBe(false);
  });

  it('白名单未命中且 association=NONE → 拒绝', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: ['alice'],
      actor: 'mallory',
      authorAssociation: 'NONE',
    });
    expect(decision.allowed).toBe(false);
  });

  it('白名单中的空串/空白项不视为命中', () => {
    const decision = evaluateTrigger({
      policy: 'trusted',
      allowedActors: ['', '   '],
      actor: 'alice',
      authorAssociation: 'NONE',
    });
    expect(decision.allowed).toBe(false);
  });
});
