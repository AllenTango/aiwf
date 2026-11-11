import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectChangedFiles, NodeGitOps, slugifyBranch } from './git-ops.js';

const TEST_TIMEOUT = 30_000;
const GIT_ID = ['-c', 'user.name=aiwf-test', '-c', 'user.email=test@example.com'];

/** 测试预置用的同步 git 调用(与被测的异步 NodeGitOps 互不干扰)。 */
function runGit(dir: string | null, args: string[], allowFail = false): { code: number; stdout: string; stderr: string } {
  // 注意:git 的 -c 配置参数必须位于子命令之前,因此统一前置到 args 之前。
  const r = spawnSync('git', ['-C', dir ?? '.', ...GIT_ID, ...args], { encoding: 'utf8' });
  const res = { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (!allowFail && res.code !== 0) {
    throw new Error(`测试预置 git 命令失败: git ${args.join(' ')}\n${res.stderr}`);
  }
  return res;
}

describe('slugifyBranch', () => {
  it('把分支名压成安全的目录名', () => {
    expect(slugifyBranch('aiwf/implement-core')).toBe('aiwf-implement-core');
    expect(slugifyBranch('feat/x<1>:bad*name')).toBe('feat-x-1-bad-name');
    expect(slugifyBranch('  ')).toBe('wt');
  });
});

describe('NodeGitOps(真实 git,临时目录)', () => {
  let workRoot: string;
  let ops: NodeGitOps;

  beforeEach(async () => {
    workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwf-gitops-'));
    ops = new NodeGitOps();
  }, TEST_TIMEOUT);

  afterEach(async () => {
    if (workRoot) await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  const initRepo = (dir: string): void => {
    runGit(null, ['init', '-q', dir]);
    runGit(null, ['-C', dir, 'config', 'core.autocrlf', 'false']);
  };

  it('currentBranch 返回当前分支(与 symbolic-ref 对照)', async () => {
    const dir = path.join(workRoot, 'repo1');
    initRepo(dir);
    runGit(dir, ['commit', '--allow-empty', '-m', 'init']);
    const expected = runGit(dir, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
    expect(await ops.currentBranch(dir)).toBe(expected);
  }, TEST_TIMEOUT);

  it('commitAll:有变更创建署名提交;空变更不再产生提交', async () => {
    const dir = path.join(workRoot, 'repo2');
    initRepo(dir);
    runGit(dir, ['commit', '--allow-empty', '-m', 'init']);

    await fs.writeFile(path.join(dir, 'a.txt'), 'hello', 'utf8');
    await ops.commitAll(dir, 'feat: add a.txt');
    expect(runGit(dir, ['status', '--porcelain']).stdout.trim()).toBe('');
    const log = runGit(dir, ['log', '-1', '--format=%an %s']).stdout.trim();
    expect(log).toBe('aiwf[bot] feat: add a.txt');

    const before = runGit(dir, ['rev-list', '--count', 'HEAD']).stdout.trim();
    await ops.commitAll(dir, '空提交不该产生');
    const after = runGit(dir, ['rev-list', '--count', 'HEAD']).stdout.trim();
    expect(after).toBe(before);
  }, TEST_TIMEOUT);

  it('ensureWorktree:创建/复用/移除 worktree', async () => {
    const dir = path.join(workRoot, 'repo3');
    initRepo(dir);
    runGit(dir, ['commit', '--allow-empty', '-m', 'init']);

    const wt = await ops.ensureWorktree(dir, 'aiwf/t1');
    expect(wt.toLowerCase()).toContain('aiwf-work');
    expect(wt.toLowerCase().endsWith(path.join('aiwf-work', 'aiwf-t1').toLowerCase())).toBe(true);
    expect(runGit(wt, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('aiwf/t1');

    // 复用:再次 ensure 返回同一路径,不抛错
    const again = await ops.ensureWorktree(dir, 'aiwf/t1');
    expect(path.resolve(again).toLowerCase()).toBe(path.resolve(wt).toLowerCase());

    await ops.removeWorktree(dir, wt);
    expect(await fs.access(wt).then(() => true, () => false)).toBe(false);
    expect(runGit(dir, ['worktree', 'list']).stdout).not.toContain('aiwf-work');
  }, TEST_TIMEOUT);

  it('diffStat 输出 --stat 文本', async () => {
    const dir = path.join(workRoot, 'repo4');
    initRepo(dir);
    await fs.writeFile(path.join(dir, 'f.txt'), 'one', 'utf8');
    await ops.commitAll(dir, 'c1');
    await fs.writeFile(path.join(dir, 'g.txt'), 'two', 'utf8');
    await ops.commitAll(dir, 'c2');
    const stat = await ops.diffStat(dir, 'HEAD~1', 'HEAD');
    expect(stat).toContain('g.txt');
  }, TEST_TIMEOUT);

  it('mergeBranch:无冲突成功;冲突时抛错带冲突清单并恢复干净', async () => {
    const dir = path.join(workRoot, 'repo5');
    initRepo(dir);
    await fs.writeFile(path.join(dir, 'shared.txt'), 'base', 'utf8');
    await ops.commitAll(dir, 'init');

    const wt = await ops.ensureWorktree(dir, 'feat-x');
    await fs.writeFile(path.join(wt, 'solo.txt'), 'new', 'utf8');
    await ops.commitAll(wt, 'feat solo');
    await ops.mergeBranch(dir, 'feat-x');
    expect(runGit(dir, ['log', '-1', '--format=%s']).stdout.trim()).toBe('merge: feat-x');

    // 冲突:双方都改 shared.txt(wt 基于 init 提交,root 已前移)
    await fs.writeFile(path.join(wt, 'shared.txt'), 'feat change', 'utf8');
    await ops.commitAll(wt, 'feat edit shared');
    await fs.writeFile(path.join(dir, 'shared.txt'), 'main change', 'utf8');
    await ops.commitAll(dir, 'main edit shared');

    await expect(ops.mergeBranch(dir, 'feat-x')).rejects.toThrow(/shared\.txt/);
    expect(runGit(dir, ['status', '--porcelain']).stdout.trim()).toBe(''); // abort 后回到干净
  }, TEST_TIMEOUT);

  it('pushBranch:无远端抛中文错误;本地 bare 远端可推', async () => {
    const dir = path.join(workRoot, 'repo6');
    initRepo(dir);
    await fs.writeFile(path.join(dir, 'x.txt'), 'x', 'utf8');
    await ops.commitAll(dir, 'init');

    await expect(ops.pushBranch(dir, 'release-1')).rejects.toThrow(/不存在远端/);

    const bare = path.join(workRoot, 'bare.git');
    runGit(null, ['init', '-q', '--bare', bare]);
    runGit(dir, ['remote', 'add', 'origin', bare]);
    await ops.pushBranch(dir, 'release-1');
    const refs = runGit(bare, ['for-each-ref', '--format=%(refname:short)']).stdout.trim();
    expect(refs).toContain('release-1');
  }, TEST_TIMEOUT);

  it('collectChangedFiles:新增/修改/删除、CJK 引号路径解码、大文件截断', async () => {
    const dir = path.join(workRoot, 'repo7');
    initRepo(dir);
    await fs.writeFile(path.join(dir, 'keep.txt'), 'v1', 'utf8');
    await fs.writeFile(path.join(dir, 'gone.txt'), 'old', 'utf8');
    await ops.commitAll(dir, 'init');

    await fs.writeFile(path.join(dir, 'keep.txt'), 'v2', 'utf8'); // modify
    await fs.rm(path.join(dir, 'gone.txt')); // delete
    await fs.writeFile(path.join(dir, '新 境 界.txt'), '你好', 'utf8'); // add(CJK+空格,porcelain 会引号转义)
    await fs.writeFile(path.join(dir, 'big.txt'), 'y'.repeat(700 * 1024), 'utf8'); // 超限截断

    const notes: string[] = [];
    const files = await collectChangedFiles(dir, { notes });
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.get('keep.txt')).toMatchObject({ action: 'modify', content: 'v2' });
    expect(byPath.get('gone.txt')).toMatchObject({ action: 'delete' });
    expect(claimNoContent(byPath.get('gone.txt'))).toBe(true);
    expect(byPath.get('新 境 界.txt')).toMatchObject({ action: 'add', content: '你好' });

    const big = byPath.get('big.txt');
    expect(big?.action).toBe('add');
    expect(big?.content?.length ?? 0).toBeLessThan(700 * 1024);
    expect(big?.content ?? '').toContain('截断');
    expect(notes.join('\n')).toContain('big.txt');
  }, TEST_TIMEOUT);

  function claimNoContent(f: { action: string; content?: string } | undefined): boolean {
    return f !== undefined && f.content === undefined;
  }
});
