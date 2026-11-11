import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRepoContext, KEY_FILE_CANDIDATES } from './repo-context.js';

const TEST_TIMEOUT = 30_000;
const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

function runGit(dir: string | null, args: string[]): string {
  // 注意:git 的 -c 配置参数必须位于子命令之前,因此统一前置到 args 之前。
  const r = spawnSync('git', ['-C', dir ?? '.', ...GIT_ID, ...args], { encoding: 'utf8' });
  if ((r.status ?? -1) !== 0) throw new Error(`测试预置 git 失败: ${args.join(' ')}\n${r.stderr}`);
  return r.stdout ?? '';
}

describe('buildRepoContext(真实 git + 临时目录)', () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwf-repoctx-'));
  }, TEST_TIMEOUT);

  afterEach(async () => {
    if (workRoot) await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  const seedRepo = async (dir: string): Promise<void> => {
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.mkdir(path.join(dir, 'aiwf-work', 'wt'), { recursive: true });
    await fs.mkdir(path.join(dir, 'coverage'), { recursive: true });
    await fs.mkdir(path.join(dir, 'deep', 'nested', 'level4'), { recursive: true });
    await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(dir, README_FILE), '# 示例项目\n\n说明文字。\n', 'utf8');
    await fs.writeFile(path.join(dir, 'package.json'), '{\n  "name": "demo",\n  "version": "0.0.1"\n}\n', 'utf8');
    await fs.writeFile(path.join(dir, 'tsconfig.json'), '{ "extends": "./tsconfig.base.json" }\n', 'utf8');
    await fs.writeFile(path.join(dir, '.env.local'), 'SECRET=1\n', 'utf8');
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    await fs.writeFile(path.join(dir, 'node_modules', 'dep.js'), 'x', 'utf8');
    await fs.writeFile(path.join(dir, 'dist', 'out.js'), 'x', 'utf8');
    await fs.writeFile(path.join(dir, 'aiwf-work', 'wt', 'x.txt'), 'x', 'utf8');
    await fs.writeFile(path.join(dir, 'coverage', 'c.txt'), 'x', 'utf8');
    await fs.writeFile(path.join(dir, 'deep', 'nested', 'level4', 'leaf.txt'), '深层叶子\n', 'utf8');
    await fs.writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'on: [push]\n', 'utf8');
    // 前导 1KB 全为字母,后接 NUL:探测的是前 1KB,不应判为二进制
    await fs.writeFile(path.join(dir, 'textlike.dat'), `${'a'.repeat(1024)}\u0000zzz`, 'utf8');
    // 前 1KB 含 NUL:真二进制,候选匹配也必须跳过
    await fs.writeFile(path.join(dir, 'index.html'), `${'\u0000'.repeat(8)}<html></html>`, 'utf8');
    runGit(null, ['init', '-q', dir]);
    runGit(dir, ['config', 'core.autocrlf', 'false']);
    runGit(dir, ['add', '-A']);
    runGit(dir, ['commit', '-m', 'init']);
  };

  const README_FILE = 'README.md';

  it('branch/treePreview/keyFiles 三要素齐备;排除项不出现', async () => {
    const dir = path.join(workRoot, 'repo');
    await seedRepo(dir);

    const ctx = await buildRepoContext(dir);
    expect(ctx.rootDir).toBe(dir);
    const expectedBranch = runGit(dir, ['symbolic-ref', '--short', 'HEAD']).trim();
    expect(ctx.branch).toBe(expectedBranch);

    // 树可见项
    for (const wanted of ['README.md', 'package.json', 'tsconfig.json', '.github/', 'workflows/', 'ci.yml', 'index.html', 'textlike.dat']) {
      expect(ctx.treePreview).toContain(wanted);
    }
    // 排除项
    for (const banned of ['node_modules', 'dist/', 'aiwf-work', 'coverage', '.env.local', 'pnpm-lock']) {
      expect(ctx.treePreview).not.toContain(banned);
    }
    // 深度限 3:第三层目录名出现,第四层叶子不出现
    expect(ctx.treePreview).toContain('level4/');
    expect(ctx.treePreview).not.toContain('leaf.txt');

    // keyFiles
    const paths = ctx.keyFiles.map((f) => f.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('package.json');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('.github/workflows/ci.yml');
    const readme = ctx.keyFiles.find((f) => f.path === 'README.md')!;
    expect(readme.content).toContain('示例项目');
    expect((readme.tokens ?? 0)).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  it('超过 maxEntries 截断时在树尾注明', async () => {
    const dir = path.join(workRoot, 'repo-tiny');
    runGit(null, ['init', '-q', dir]);
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n', 'utf8');
    runGit(dir, ['add', '-A']);
    runGit(dir, ['commit', '-m', 'init']);

    const ctx = await buildRepoContext(dir, { maxEntries: 1 });
    expect(ctx.treePreview).toContain('# 文件树在 1 个条目处截断');
    expect(ctx.treePreview).toContain('a.txt');
  }, TEST_TIMEOUT);

  it('keyFiles 超出 token 预算时按序丢弃并把信息附在树尾', async () => {
    const dir = path.join(workRoot, 'repo-budget');
    runGit(null, ['init', '-q', dir]);
    await fs.writeFile(path.join(dir, 'README.md'), '# t\n内容较多的README一段内容一段内容\n', 'utf8');
    await fs.writeFile(path.join(dir, 'package.json'), '{ "name": "b" }\n', 'utf8');
    runGit(dir, ['add', '-A']);
    runGit(dir, ['commit', '-m', 'init']);

    const ctx = await buildRepoContext(dir, { keyFilesBudgetTokens: 8, keyFileMaxLines: 10 });
    const kept = ctx.keyFiles.map((f) => f.path);
    expect(kept).toEqual(['README.md']); // 第一份装得下
    expect(ctx.treePreview).toContain('# keyFiles 超出 token 预算');
    expect(ctx.treePreview).toContain('package.json');
  }, TEST_TIMEOUT);

  it('单文件超过行数上限时截断并标注', async () => {
    const dir = path.join(workRoot, 'repo-lines');
    runGit(null, ['init', '-q', dir]);
    const long = Array.from({ length: 200 }, (_, i) => `第 ${i} 行`).join('\n');
    await fs.writeFile(path.join(dir, 'README.md'), `${long}\n`, 'utf8');
    runGit(dir, ['add', '-A']);
    runGit(dir, ['commit', '-m', 'init']);

    const ctx = await buildRepoContext(dir);
    const readme = ctx.keyFiles.find((f) => f.path === 'README.md')!;
    expect(readme.content.split('\n').length).toBeLessThan(200);
    expect(readme.content).toContain('仅展示前 120 行');
  }, TEST_TIMEOUT);

  it('候选列表未变化(契约锚定)', () => {
    expect(KEY_FILE_CANDIDATES).toEqual([
      'README*',
      'package.json',
      'tsconfig*',
      'action.yml',
      'pnpm-workspace.yaml',
      '.github/workflows/*.yml',
      'LICENSE',
      'CONTRIBUTING*',
    ]);
  });
});
