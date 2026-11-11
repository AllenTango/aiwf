/** 变更物化的专项测试:落盘、删除、路径越界拒绝、缺 content 跳过。 */

import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangedFile } from '../contracts/index.js';
import { materializeChangedFiles, resolveInside } from './materialize.js';

let worktree = '';

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), 'aiwf-mat-'));
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

describe('materializeChangedFiles', () => {
  it('add/modify 创建父目录并写入内容;delete 删除已存在文件', async () => {
    await mkdir(path.join(worktree, 'legacy'), { recursive: true });
    await writeFile(path.join(worktree, 'legacy', 'old.txt'), 'old', 'utf8');

    const files: ChangedFile[] = [
      { path: 'src/nested/a.ts', action: 'add', content: 'export {};\n' },
      { path: 'src/nested/a.ts', action: 'modify', content: 'export const A = 1;\n' },
      { path: 'legacy/old.txt', action: 'delete' },
    ];
    const out = await materializeChangedFiles(worktree, files);
    expect(out.skipped).toEqual([]);
    expect(out.written).toEqual(['src/nested/a.ts', 'src/nested/a.ts']);
    expect(out.removed).toEqual(['legacy/old.txt']);
    expect(await readFile(path.join(worktree, 'src/nested/a.ts'), 'utf8')).toBe('export const A = 1;\n');
    await expect(readFile(path.join(worktree, 'legacy/old.txt'), 'utf8')).rejects.toThrow();
  });

  it('delete 目标不存在也不报错(记为 removed)', async () => {
    const out = await materializeChangedFiles(worktree, [{ path: 'ghost.txt', action: 'delete' }]);
    expect(out.removed).toEqual(['ghost.txt']);
    expect(out.skipped).toEqual([]);
  });

  it('路径越界(/^.. 与绝对路径外部)被拒绝,不写出工作树', async () => {
    const external = await mkdtemp(path.join(tmpdir(), 'aiwf-out-'));
    try {
      const files: ChangedFile[] = [
        { path: '../escape.ts', action: 'add', content: 'nope' },
        { path: path.join(external, 'hacked.txt'), action: 'modify', content: 'nope' },
      ];
      const out = await materializeChangedFiles(worktree, files);
      expect(out.written).toEqual([]);
      expect(out.skipped).toHaveLength(2);
      expect(out.skipped.every((s) => s.reason.includes('越界'))).toBe(true);
      await expect(readFile(path.join(external, 'hacked.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it('add/modify 缺少 content → skip,不中断其余文件', async () => {
    const files: ChangedFile[] = [
      { path: 'bad.ts', action: 'add' },
      { path: 'good.ts', action: 'add', content: 'ok' },
    ];
    const out = await materializeChangedFiles(worktree, files);
    expect(out.skipped.map((s) => s.path)).toEqual(['bad.ts']);
    expect(await readFile(path.join(worktree, 'good.ts'), 'utf8')).toBe('ok');
  });
});

describe('resolveInside', () => {
  it('根内相对路径合法,根自身 / 越界 / 空路径非法', () => {
    expect(resolveInside(worktree, 'src/a.ts')).not.toBeNull();
    expect(resolveInside(worktree, './src/a.ts')).not.toBeNull();
    expect(resolveInside(worktree, '.')).toBeNull();
    expect(resolveInside(worktree, '')).toBeNull();
    expect(resolveInside(worktree, '../x')).toBeNull();
    expect(resolveInside(worktree, 'a/../../x')).toBeNull();
  });
});
