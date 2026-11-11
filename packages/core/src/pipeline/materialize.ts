/** TaskResult.changedFiles 物化:把成员产出逐条落到工作树。 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ChangedFile } from '../contracts/index.js';

export interface MaterializeSkip {
  path: string;
  reason: string;
}

export interface MaterializeOutcome {
  /** 成功写入(add/modify)的相对路径。 */
  written: string[];
  /** 成功删除(delete)的相对路径。 */
  removed: string[];
  /** 被跳过的条目(路径越界 / 缺 content / IO 失败)。 */
  skipped: MaterializeSkip[];
}

/**
 * 把 changedFiles 逐条落到 worktreeDir:
 * - add/modify:确保父目录存在后写入 content;
 * - delete:删除文件(目标不存在视为已删除);
 * - 路径越界(绝对路径指向工作树之外、`..` 逃逸、空路径)→ 记入 skipped,不中断。
 *
 * 单成员级别失败绝不抛出:任何问题都体现在 skipped 列表里。
 */
export async function materializeChangedFiles(
  worktreeDir: string,
  files: readonly ChangedFile[],
): Promise<MaterializeOutcome> {
  const outcome: MaterializeOutcome = { written: [], removed: [], skipped: [] };
  for (const file of files) {
    try {
      const rel = typeof file.path === 'string' ? file.path : '';
      const abs = resolveInside(worktreeDir, rel);
      if (abs === null) {
        outcome.skipped.push({
          path: rel === '' ? '(空路径)' : rel,
          reason: '路径越界或为空,拒绝写入',
        });
        continue;
      }
      if (file.action === 'delete') {
        await rm(abs, { force: true });
        outcome.removed.push(file.path);
        continue;
      }
      if (typeof file.content !== 'string') {
        outcome.skipped.push({ path: file.path, reason: 'add/modify 缺少 content,拒绝写入' });
        continue;
      }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, file.content, 'utf8');
      outcome.written.push(file.path);
    } catch (err) {
      outcome.skipped.push({
        path: file.path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcome;
}

/** 解析 rel 到 rootDir 之内的绝对路径;越界/为空返回 null。 */
export function resolveInside(rootDir: string, rel: string): string | null {
  if (rel === '' || rel.includes('\0')) return null;
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, rel);
  if (abs === root) return null;
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}
