/**
 * @aiwf/action — PlatformClient 的 GitHub 实现(契约见 packages/core/src/contracts/index.ts)。
 * OWNER: M4.
 *
 * - fetchTask:`owner/repo#N` → rest.issues.get + rest.issues.listComments(前 maxComments 条拼接)。
 * - createPullRequest:rest.pulls.create;422(如 PR already exists)→ 回查同 head 的
 *   既存 open PR 并更新标题/正文复用之;reportComment 非空时以评论补充结项报告。
 * - 其他错误统一抛带 HTTP status + GitHub message 的描述性错误。
 */
import * as github from '@actions/github';
import type {
  IssueComment,
  PlatformClient,
  PullRequestHandle,
  PullRequestPayload,
  TaskInput,
} from '@aiwf/core';
import { TASK_REF_PATTERN } from './inputs.js';

export interface GitHubPlatformClientOptions {
  /** 步骤 env 注入的 token(通常 `${{ github.token }}`,或具备相应写权限的 PAT)。 */
  token: string;
  /** payload.baseBranch 为空时的兜底 base 分支(通常为 checkout 的当前分支)。 */
  baseBranchFallback?: string;
  /** 写入 TaskInput.comments 的评论上限(默认 10)。 */
  maxComments?: number;
  /** 非致命问题的旁路(如评论读取/追加失败未中断流程),action 侧接 core.warning。 */
  onNotice?: (message: string) => void;
}

export interface ParsedTaskRef {
  owner: string;
  repo: string;
  number: number;
}

/** 纯函数:`owner/repo#123` → { owner, repo, number };不匹配返回 null。 */
export function parseTaskRef(ref: string): ParsedTaskRef | null {
  const match = TASK_REF_PATTERN.exec(ref.trim());
  if (match === null) {
    return null;
  }
  const [, owner, repo, digits] = match;
  if (owner === undefined || repo === undefined || digits === undefined) {
    return null;
  }
  return { owner, repo, number: Number(digits) };
}

/** 把 Octokit/RequestError 拼成一条可读描述(HTTP status + message)。 */
export function describeGitHubError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const shaped = error as { status?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof shaped.status === 'number' && shaped.status > 0) {
      parts.push(`HTTP ${shaped.status}`);
    }
    if (typeof shaped.message === 'string' && shaped.message !== '') {
      parts.push(shaped.message);
    }
    if (parts.length > 0) {
      return parts.join(' · ');
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** 安全读取 RequestError 的 status(可能是任意形状)。 */
export function getHttpStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
}

export class GitHubPlatformClient implements PlatformClient {
  private readonly octokit: ReturnType<typeof github.getOctokit>;
  readonly owner: string;
  readonly repo: string;
  private readonly baseBranchFallback: string | undefined;
  private readonly maxComments: number;
  private readonly onNotice?: (message: string) => void;

  constructor(options: GitHubPlatformClientOptions) {
    if (options.token === undefined || options.token === '') {
      throw new Error('GitHubPlatformClient 需要非空 token(步骤 env 中注入 GITHUB_TOKEN)。');
    }
    this.octokit = github.getOctokit(options.token);
    this.owner = github.context.repo.owner;
    this.repo = github.context.repo.repo;
    this.baseBranchFallback = options.baseBranchFallback;
    this.maxComments = options.maxComments ?? 10;
    this.onNotice = options.onNotice;
  }

  /** `owner/repo#N` → TaskInput;owner/repo 以 ref 中解析者为准(与 dogfood 场景一致)。 */
  async fetchTask(ref: string): Promise<TaskInput> {
    const parsed = parseTaskRef(ref);
    if (parsed === null) {
      throw new Error(`无法解析 task_ref:"${ref}"(期望形如 \`owner/repo#123\`)。`);
    }
    const { owner, repo, number } = parsed;

    const issueResponse = await this.request(
      () => this.octokit.rest.issues.get({ owner, repo, issue_number: number }),
      `读取 Issue ${owner}/${repo}#${number}`,
    );
    const issue = issueResponse.data;

    // 评论列表读取失败不阻塞整个 run:降级为无评论并旁路提示。
    let rawComments: Array<{ user?: { login?: string | null } | null; body?: string | null }> = [];
    try {
      const commentsResponse = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: number,
        per_page: this.maxComments,
      });
      rawComments = commentsResponse.data ?? [];
    } catch (error) {
      this.notice(`读取 Issue 评论列表失败(降级为无评论继续):${describeGitHubError(error)}`);
    }

    const comments = rawComments
      .slice(0, this.maxComments)
      .map((comment) => `${comment.user?.login ?? 'unknown'}: ${comment.body ?? ''}`.trim())
      .filter((text) => text.length > 0);

    return {
      source: 'issue',
      ref,
      title: issue.title ?? '',
      body: issue.body ?? '',
      comments,
      metadata: {
        issueUrl: issue.html_url,
        issueAuthor: issue.user?.login ?? 'unknown',
      },
    };
  }

  /**
   * 读取任务源(Issue)的评论列表(按时间正序)。
   *
   * 用途:两段式审批 —— 找出队长的决策包评论,以及其后是否出现 `@aiwf go` 批准信号。
   */
  async listIssueComments(ref: string): Promise<IssueComment[]> {
    const parsed = parseTaskRef(ref);
    if (parsed === null) {
      throw new Error(`无法解析任务引用以读取评论:"${ref}"(期望形如 \`owner/repo#123\`)。`);
    }
    const { owner, repo, number } = parsed;
    const response = await this.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });
    return (response.data ?? []).map((comment) => ({
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.created_at ?? '',
    }));
  }

  /**
   * 在任务源(Issue)上留一条评论。
   *
   * 用途:队长裁决为 reject / need_clarification 时,把「为什么不开工 / 要澄清什么」
   * 送回人类眼前 —— 否则裁决只躺在日志里,人类看不到。
   */
  async postComment(ref: string, body: string): Promise<void> {
    const parsed = parseTaskRef(ref);
    if (parsed === null) {
      throw new Error(`无法解析任务引用以回帖:"${ref}"(期望形如 \`owner/repo#123\`)。`);
    }
    const { owner, repo, number } = parsed;
    await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body,
    });
  }

  /** 创建 PR;422(已存在等)→ 复用同 head 的既存 open PR 并更新标题/正文。 */
  async createPullRequest(payload: PullRequestPayload): Promise<PullRequestHandle> {
    const { owner, repo } = this;
    const baseBranch = payload.baseBranch !== '' ? payload.baseBranch : this.baseBranchFallback;
    if (baseBranch === undefined || baseBranch === '') {
      throw new Error(
        `创建 PR 需要 base 分支:payload.baseBranch 与 baseBranchFallback 均为空(head:${payload.headBranch})。请显式设置 base_branch 输入。`,
      );
    }

    try {
      const response = await this.octokit.rest.pulls.create({
        owner,
        repo,
        head: payload.headBranch,
        base: baseBranch,
        title: payload.title,
        body: payload.body,
      });
      const created = response.data;
      await this.attachReportComment(created.number, payload.reportComment);
      return { number: created.number, url: created.html_url };
    } catch (error) {
      if (getHttpStatusCode(error) !== 422) {
        throw new Error(
          `创建 PR(head:${payload.headBranch} → base:${baseBranch})失败:${describeGitHubError(error)}`,
        );
      }
      return this.reuseExistingPullRequest(payload, error);
    }
  }

  /** 422(如 "PR already exists")→ 查同 head 既存 open PR,更新标题/正文后返回其 handle。 */
  private async reuseExistingPullRequest(
    payload: PullRequestPayload,
    createError: unknown,
  ): Promise<PullRequestHandle> {
    const { owner, repo } = this;
    let open: Array<{ number: number; html_url: string; head: { ref: string } }>;
    try {
      const response = await this.octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${payload.headBranch}`,
        state: 'open',
      });
      open = response.data;
    } catch (error) {
      throw new Error(
        `创建 PR 失败(422,可能已存在:${describeGitHubError(createError)}),且回查既存 PR 也失败:${describeGitHubError(error)}`,
      );
    }

    const existing = open.find((pull) => pull.head.ref === payload.headBranch) ?? open[0];
    if (existing === undefined) {
      throw new Error(
        `创建 PR 失败(422:${describeGitHubError(createError)}),且未找到 head 为 ${owner}:${payload.headBranch} 的既存 open PR。`,
      );
    }

    try {
      await this.octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: existing.number,
        title: payload.title,
        body: payload.body,
      });
      await this.attachReportComment(existing.number, payload.reportComment);
      return { number: existing.number, url: existing.html_url };
    } catch (error) {
      throw new Error(`更新既存 PR #${existing.number} 失败:${describeGitHubError(error)}`);
    }
  }

  /** 结项报告非空时以评论补充;失败仅旁路告警,不影响 PR 本体。 */
  private async attachReportComment(prNumber: number, reportComment?: string): Promise<void> {
    const body = (reportComment ?? '').trim();
    if (body === '') {
      return;
    }
    try {
      await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: prNumber,
        body,
      });
    } catch (error) {
      this.notice(`补充 PR 结项报告评论(#${prNumber})失败(不影响 PR 本体):${describeGitHubError(error)}`);
    }
  }

  private async request<T>(operation: () => Promise<T>, what: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new Error(`${what} 失败:${describeGitHubError(error)}`);
    }
  }

  private notice(message: string): void {
    this.onNotice?.(message);
  }
}
