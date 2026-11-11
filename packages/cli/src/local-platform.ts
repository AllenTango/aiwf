import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitOps,
  Logger,
  PlatformClient,
  PullRequestHandle,
  PullRequestPayload,
  TaskInput,
} from '@aiwf/core';
import { UsageError } from './errors.js';
import { TASK_GUIDE, parseInlineTask, parseTaskFromFile, readUtf8 } from './task-input.js';

const execFileP = promisify(execFile);

/** URL shape `gh pr create` prints on success. */
export const GH_PULL_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;

export type GhRunnerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** executable not found on PATH */
  notFound: boolean;
};

export type GhRunner = (args: string[], cwd: string) => Promise<GhRunnerResult>;

/** Real runner (spawn `gh`). Injectable in tests — never executed by vitest. */
export function defaultGhRunner(bin = 'gh'): GhRunner {
  return async (args, cwd) => {
    try {
      const { stdout, stderr } = await execFileP(bin, args, { cwd, windowsHide: true });
      return { code: 0, stdout, stderr, notFound: false };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        code?: string | number;
        stdout?: string;
        stderr?: string;
      };
      if (err.code === 'ENOENT') {
        return { code: null, stdout: err.stdout ?? '', stderr: err.stderr ?? '', notFound: true };
      }
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr || err.message || 'gh pr create 失败',
        notFound: false,
      };
    }
  };
}

export type LocalDeliveryReason = 'no-remote' | 'push-failed' | 'gh-missing' | 'gh-failed';

const NO_REMOTE_PATTERNS = [
  'no configured push destination',
  'does not appear to be a git repository',
  'no upstream branch',
  'could not find remote',
  'no remote',
] as const;

/** Classify a push failure: absence of a configured remote is the common
 *  local-CLI case and gets a friendlier handoff message. */
export function describePushFailure(error: unknown): 'no-remote' | 'push-failed' {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return NO_REMOTE_PATTERNS.some((pattern) => message.includes(pattern))
    ? 'no-remote'
    : 'push-failed';
}

/** Human handoff printed when the run can only be delivered locally
 *  (no remote configured, or `gh` missing/failed). */
export function buildLocalHandoffBody(input: {
  branch: string;
  base: string;
  reason: LocalDeliveryReason;
  detail?: string;
}): string {
  const why =
    input.reason === 'no-remote'
      ? '仓库尚未配置远端 remote,分支无法推送。'
      : input.reason === 'push-failed'
        ? '分支推送失败(远端可达性 / 凭证 / 权限)。'
        : input.reason === 'gh-missing'
          ? '未检测到 GitHub CLI(gh),无法自动创建 PR。'
          : 'GitHub CLI 创建 PR 失败,可按以下命令手动重试。';
  const detail = input.detail ? `\n  • 详情:${input.detail}` : '';
  return [
    '📦 本地交付完成 — 团队产物已保留在本地分支',
    `  • 分支:${input.branch}(基线:${input.base})`,
    `  • 原因:${why}${detail}`,
    '',
    '  上 GitHub 步骤:',
    `    git push -u origin ${input.branch}`,
    `    # 已安装 gh 时:gh pr create --head ${input.branch} --base ${input.base} --fill`,
    '',
    '  建议后续:',
    '    - 完整 issue→PR 闭环请使用 aiwf GitHub Action(issue 触发自动化);',
    `    - 或将分支 ${input.branch} 推送后在 GitHub 手动发起 Pull Request。`,
  ].join('\n');
}

export interface LocalPlatformOptions {
  git: GitOps;
  repoDir: string;
  /** PR base branch hint (defaults to the repo's current branch). */
  baseBranch: string;
  logger?: Logger;
  /** Shared collector surfaced in the final report's 备注 section. */
  notes: string[];
  /** Injectable `gh` executor; defaults to spawning the real binary. */
  ghRunner?: GhRunner;
}

/**
 * Local PlatformClient for the CLI shell.
 * - fetchTask: only `file:<path>` / `inline:<text>` refs are supported;
 *   `owner/repo#N` is rejected with guidance toward the GitHub Action.
 * - createPullRequest: push the deliverable branch first; on failure (or when
 *   `gh pr create` cannot produce a real PR) degrade to a local-delivery
 *   handoff and return { number: -1, url: '' } with a `local-delivery` note.
 */
export class LocalPlatformClient implements PlatformClient {
  private readonly options: LocalPlatformOptions;
  private readonly collectedNotes: string[];

  constructor(options: LocalPlatformOptions) {
    this.options = options;
    this.collectedNotes = options.notes;
  }

  get notes(): readonly string[] {
    return this.collectedNotes;
  }

  private note(message: string): void {
    this.collectedNotes.push(message);
  }

  async fetchTask(ref: string): Promise<TaskInput> {
    if (ref.startsWith('inline:')) {
      return { source: 'inline', ...parseInlineTask(ref.slice('inline:'.length)) };
    }
    if (ref.startsWith('file:')) {
      const filePath = ref.slice('file:'.length).trim();
      const parsed = await parseTaskFromFile(filePath, readUtf8);
      return { source: 'file', ref: filePath, ...parsed };
    }
    if (ref.includes('#')) {
      throw new UsageError(
        `本地 PlatformClient 无法拉取远程 issue("${ref}")。\n${TASK_GUIDE}`,
      );
    }
    throw new UsageError(
      `本地 PlatformClient 仅支持 file:<path> 或 inline:<text> 任务引用,收到:"${ref}"。`,
    );
  }

  async createPullRequest(payload: PullRequestPayload): Promise<PullRequestHandle> {
    const { git, repoDir, logger } = this.options;
    const head = payload.headBranch;
    const base = payload.baseBranch || this.options.baseBranch;

    // 1) Push the deliverable branch; any failure degrades to local delivery.
    try {
      await git.pushBranch(repoDir, head);
      this.note(`pushed:${head}`);
    } catch (error) {
      const reason = describePushFailure(error);
      const detail = error instanceof Error ? error.message.trim() : String(error);
      const body = buildLocalHandoffBody({ branch: head, base, reason, detail });
      logger?.warn(body);
      this.note('local-delivery');
      this.note(`delivery-reason:${reason}`);
      return { number: -1, url: '' };
    }

    // 2) Try the GitHub CLI for a real PR.
    const runGh = this.options.ghRunner ?? defaultGhRunner();
    let result: GhRunnerResult;
    try {
      result = await runGh(
        ['pr', 'create', '--head', head, '--base', base, '--title', payload.title, '--body', payload.body],
        repoDir,
      );
    } catch (error) {
      result = {
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        notFound: false,
      };
    }

    if (result.code === 0) {
      const pull = extractPullRequestUrl(result.stdout);
      if (pull) {
        this.note(`pr-created:${pull.url}`);
        return { number: pull.number, url: pull.url };
      }
      const body = buildLocalHandoffBody({
        branch: head,
        base,
        reason: 'gh-failed',
        detail: 'gh 输出未包含 PR URL',
      });
      logger?.warn(body);
      this.note('local-delivery');
      this.note('delivery-reason:gh-no-url');
      return { number: -1, url: '' };
    }

    const reason: LocalDeliveryReason = result.notFound ? 'gh-missing' : 'gh-failed';
    const detail = result.stderr.trim().length > 0 ? result.stderr.trim() : undefined;
    const body = buildLocalHandoffBody({ branch: head, base, reason, detail });
    logger?.warn(body);
    this.note('local-delivery');
    this.note(`delivery-reason:${reason}`);
    return { number: -1, url: '' };
  }
}

/** Parse a `…/pull/<n>` URL out of tool output; undefined when absent. */
export function extractPullRequestUrl(
  text: string,
): { number: number; url: string } | undefined {
  const match = GH_PULL_URL_RE.exec(text);
  if (!match) return undefined;
  const numberToken = match[1];
  const number = numberToken === undefined ? Number.NaN : Number(numberToken);
  if (!Number.isInteger(number)) return undefined;
  return { number, url: match[0] };
}
