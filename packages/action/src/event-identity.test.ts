/**
 * @aiwf/action — 事件身份解析单测(纯函数,无需打桩 @actions/github)。
 */

import { describe, expect, it } from 'vitest';

import { resolveActor, resolveAuthorAssociation } from './event-identity.js';

describe('resolveActor', () => {
  it('优先使用 context.actor', () => {
    expect(resolveActor('repo-owner', { sender: { login: 'someone-else' } })).toBe('repo-owner');
  });

  it('context.actor 为空时回退到 sender.login', () => {
    expect(resolveActor('', { sender: { login: 'random-outsider' } })).toBe('random-outsider');
    expect(resolveActor(undefined, { sender: { login: 'random-outsider' } })).toBe('random-outsider');
    expect(resolveActor('   ', { sender: { login: ' random-outsider ' } })).toBe('random-outsider');
  });

  it('两者都没有时返回空串(调用方按「不可信」处理)', () => {
    expect(resolveActor(undefined, {})).toBe('');
    expect(resolveActor(undefined, undefined)).toBe('');
    expect(resolveActor('', { sender: { login: 123 } })).toBe('');
  });
});

describe('resolveAuthorAssociation', () => {
  it('评论事件取 comment.author_association(评论者,而非 Issue 作者)', () => {
    const payload = {
      comment: { author_association: 'COLLABORATOR' },
      issue: { author_association: 'NONE' },
    };
    expect(resolveAuthorAssociation(payload)).toBe('COLLABORATOR');
  });

  it('无评论时取 issue.author_association', () => {
    expect(resolveAuthorAssociation({ issue: { author_association: 'OWNER' } })).toBe('OWNER');
  });

  it('取不到时返回空串', () => {
    expect(resolveAuthorAssociation({})).toBe('');
    expect(resolveAuthorAssociation(undefined)).toBe('');
    expect(resolveAuthorAssociation({ issue: { author_association: '' } })).toBe('');
    expect(resolveAuthorAssociation({ issue: { author_association: 42 } })).toBe('');
  });
});
