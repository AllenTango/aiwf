/**
 * infra/repo-context 增强项测试:关键词抽取 + 近期提交 + 需求相关文件纳入。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildRepoContext, extractKeywords } from './repo-context.js';

describe('extractKeywords', () => {
  it('抽出路径片段、标识符与英文词', () => {
    const kws = extractKeywords(
      '请修改 packages/core/src/contracts/index.ts 里的 parsePlanJson,并补充 test 相关用例',
    );
    expect(kws).toContain('packages');
    expect(kws).toContain('contracts');
    expect(kws).toContain('parseplanjson');
    expect(kws).toContain('test');
  });

  it('英文停用词被剔除', () => {
    const kws = extractKeywords('this is the plan for the implementation');
    expect(kws).not.toContain('this');
    expect(kws).not.toContain('the');
    expect(kws).not.toContain('with');
    expect(kws).toContain('implementation');
  });

  it('中文片段可被抽出', () => {
    expect(extractKeywords('登录接口需要补充错误处理')).toContain('登录接口');
  });

  it('去重且有长度上限', () => {
    const kws = extractKeywords('alpha alpha beta gamma delta epsilon zeta eta theta iota kappa');
    expect(new Set(kws).size).toBe(kws.length);
    expect(kws.length).toBeLessThanOrEqual(24);
  });

  it('空输入不抛错', () => {
    expect(extractKeywords('')).toEqual([]);
  });
});

describe('buildRepoContext 增强项(真实 git + 临时目录)', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aiwf-snapshot-'));
    const { execFileSync } = await import('node:child_process');
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    run('init');
    run('config', 'user.email', 'a@b.c');
    run('config', 'user.name', 'tester');
    await mkdir(path.join(root, 'packages', 'core', 'src'), { recursive: true });
    await writeFile(path.join(root, 'README.md'), '# demo\n', 'utf8');
    await writeFile(path.join(root, 'packages', 'core', 'src', 'contracts.ts'), 'export const A = 1;\n', 'utf8');
    run('add', '-A');
    run('commit', '-m', 'feat: 初始化契约文件');
    await writeFile(path.join(root, 'packages', 'core', 'src', 'contracts.ts'), 'export const A = 2;\n', 'utf8');
    run('add', '-A');
    run('commit', '-m', 'fix: 调整契约常量');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recentCommits 带回最近提交摘要', async () => {
    const ctx = await buildRepoContext(root);
    expect(ctx.recentCommits?.length).toBeGreaterThanOrEqual(2);
    expect(ctx.recentCommits?.join('\n')).toContain('调整契约常量');
  });

  it('recentCommits=0 → 不读取该信息', async () => {
    const ctx = await buildRepoContext(root, { recentCommits: 0 });
    expect(ctx.recentCommits).toBeUndefined();
  });

  it('按关键词把需求相关的文件纳入 keyFiles', async () => {
    const ctx = await buildRepoContext(root, { keywords: ['contracts'] });
    expect(ctx.keyFiles.some((f) => f.path.includes('contracts'))).toBe(true);
  });

  it('无关键词 → 不额外纳入文件', async () => {
    const ctx = await buildRepoContext(root, { keywords: [] });
    expect(ctx.keyFiles.some((f) => f.path.includes('contracts.ts'))).toBe(false);
  });
});
