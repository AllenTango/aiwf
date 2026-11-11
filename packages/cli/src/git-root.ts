import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UsageError } from './errors.js';

const execFileP = promisify(execFile);

/**
 * Validate that `dir` lives inside a git repository and return the repo
 * toplevel (mirrors `git rev-parse --show-toplevel`).
 */
export async function resolveGitRoot(dir: string): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileP('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : String(error);
    throw new UsageError(
      `--dir "${dir}" 不是可用的 git 仓库(git rev-parse --show-toplevel 失败)。
${detail}
请先 git init / clone 目标仓库,或用 --dir <path> 指向一个 git 仓库根目录。`,
    );
  }
  const root = stdout.trim().split('\n')[0]?.trim() ?? '';
  if (root.length === 0) {
    throw new UsageError(`--dir "${dir}":git 未返回仓库根目录。`);
  }
  return root;
}
