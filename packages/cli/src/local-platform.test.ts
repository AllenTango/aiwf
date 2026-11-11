import { describe, expect, it } from 'vitest';
import type { GitOps, Logger, PullRequestPayload, TaskResult } from '@aiwf/core';
import { mapExitCode } from './exit-code.js';
import {
  LocalPlatformClient,
  buildLocalHandoffBody,
  defaultGhRunner,
  describePushFailure,
  extractPullRequestUrl,
  type GhRunnerResult,
} from './local-platform.js';

const makeGit = (impl: Partial<GitOps> = {}): GitOps => ({
  currentBranch: async () => 'main',
  ensureWorktree: async () => '/tmp/worktree',
  commitAll: async () => undefined,
  diffStat: async () => '',
  mergeBranch: async () => undefined,
  removeWorktree: async () => undefined,
  pushBranch: async () => undefined,
  ...impl,
});

interface Captured {
  lines: { level: 'debug' | 'info' | 'warn' | 'error'; message: string }[];
}
const captureLogger = (captured: Captured): Logger => {
  const push =
    (level: Captured['lines'][number]['level']) => (message: string): void => {
      captured.lines.push({ level, message });
    };
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
};

const payload: PullRequestPayload = {
  title: 'feat: deliver team result',
  body: '## 结项报告\n- task done',
  headBranch: 'aiwf/t1',
  baseBranch: 'main',
};

describe('exit code mapping (pure function)', () => {
  const status = (t: TaskResult['status']): { status: TaskResult['status'] } => ({ status: t });

  it('exit 0 when every member completed (or none ran)', () => {
    expect(mapExitCode([])).toBe(0);
    expect(mapExitCode([status('completed'), status('completed')])).toBe(0);
  });

  it('exit 1 when any failed/partial member exists (partial delivery)', () => {
    expect(mapExitCode([status('completed'), status('partial')])).toBe(1);
    expect(mapExitCode([status('completed'), status('failed')])).toBe(1);
    expect(mapExitCode([status('failed')])).toBe(1);
  });
});

describe('push failure classification', () => {
  it('no configured remote → friendly no-remote reason', () => {
    expect(
      describePushFailure(new Error('fatal: no configured push destination.')),
    ).toBe('no-remote');
  });
  it('other failures keep push-failed', () => {
    expect(describePushFailure(new Error('Auth error: handshake failed'))).toBe('push-failed');
  });
});

describe('local delivery handoff (no remote configured)', () => {
  it('returns local handle {number:-1,url:""}; prints handoff report; notes local-delivery', async () => {
    const captured: Captured = { lines: [] };
    const notes: string[] = [];
    const platform = new LocalPlatformClient({
      git: makeGit({
        pushBranch: async () => {
          throw new Error('fatal: no configured push destination.');
        },
      }),
      repoDir: 'E:/repo',
      baseBranch: 'main',
      logger: captureLogger(captured),
      notes,
    });

    const handle = await platform.createPullRequest(payload);
    expect(handle).toEqual({ number: -1, url: '' });
    expect(notes).toContain('local-delivery');
    expect(notes).toContain('delivery-reason:no-remote');

    const warns = captured.lines.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('📦 本地交付完成');
    expect(warns[0]).toContain('git push -u origin aiwf/t1');
    expect(warns[0]).toContain('gh pr create --head aiwf/t1 --base main');
    expect(warns[0]).toContain('GitHub Action');
  });

  it('handoff body text snapshot', () => {
    const body = buildLocalHandoffBody({
      branch: 'aiwf/issue-1-fix-login',
      base: 'main',
      reason: 'no-remote',
    });
    expect(body).toMatchSnapshot();
  });
});

describe('push success then gh attempts', () => {
  const makePlatform = (runnerResult: GhRunnerResult): { platform: LocalPlatformClient; notes: string[]; captured: Captured } => {
    const captured: Captured = { lines: [] };
    const notes: string[] = [];
    const platform = new LocalPlatformClient({
      git: makeGit(),
      repoDir: 'E:/repo',
      baseBranch: 'main',
      logger: captureLogger(captured),
      notes,
      ghRunner: async () => runnerResult,
    });
    return { platform, notes, captured };
  };

  it('gh pr create success with a parseable URL → real PR handle', async () => {
    const { platform, notes } = makePlatform({
      code: 0,
      stdout: 'Creating pull request for aiwf/t1:\nhttps://github.com/owner/repo/pull/42\n',
      stderr: '',
      notFound: false,
    });
    const handle = await platform.createPullRequest(payload);
    expect(handle).toEqual({ number: 42, url: 'https://github.com/owner/repo/pull/42' });
    expect(notes.join('\n')).toContain('pr-created:');
    expect(notes).not.toContain('local-delivery');
  });

  it('gh missing (not installed) → local delivery with install guidance', async () => {
    const { platform, notes, captured } = makePlatform({
      code: null,
      stdout: '',
      stderr: '',
      notFound: true,
    });
    const handle = await platform.createPullRequest(payload);
    expect(handle).toEqual({ number: -1, url: '' });
    expect(notes).toContain('local-delivery');
    expect(notes).toContain('delivery-reason:gh-missing');
    expect(captured.lines.some((l) => l.message.includes('未检测到 GitHub CLI(gh)'))).toBe(true);
  });

  it('gh failed (non-zero exit) → local delivery with stderr detail', async () => {
    const { platform, notes, captured } = makePlatform({
      code: 1,
      stdout: '',
      stderr: 'gh: auth failure please run gh auth login',
      notFound: false,
    });
    const handle = await platform.createPullRequest(payload);
    expect(handle).toEqual({ number: -1, url: '' });
    expect(notes).toContain('local-delivery');
    expect(notes).toContain('delivery-reason:gh-failed');
    const warn = captured.lines.find((l) => l.level === 'warn');
    expect(warn?.message).toContain('gh auth login');
  });

  it('gh ok but no URL in stdout → degrade to local delivery', async () => {
    const { platform, notes } = makePlatform({ code: 0, stdout: 'done?', stderr: '', notFound: false });
    const handle = await platform.createPullRequest(payload);
    expect(handle).toEqual({ number: -1, url: '' });
    expect(notes).toContain('local-delivery');
  });
});

describe('fetchTask: file/inline only', () => {
  const makePlatform = (): LocalPlatformClient =>
    new LocalPlatformClient({
      git: makeGit(),
      repoDir: '.',
      baseBranch: 'main',
      notes: [],
      ghRunner: async () => ({ code: null, stdout: '', stderr: '', notFound: true }),
    });

  it('inline:<text> resolves into a TaskInput', async () => {
    const task = await makePlatform().fetchTask('inline:给 README 加 Quick Start');
    expect(task.source).toBe('inline');
    expect(task.title).toBe('给 README 加 Quick Start');
  });

  it('file:<path> resolves through the md/json parser', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'aiwf-cli-test-'));
    const filePath = join(dir, 'demo.md');
    try {
      await writeFile(filePath, '# Demo title\n\n-demo body', 'utf8');
      const task = await makePlatform().fetchTask(`file:${filePath}`);
      expect(task.source).toBe('file');
      expect(task.ref).toBe(filePath);
      expect(task.title).toBe('Demo title');
      expect(task.body).toContain('-demo body');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('owner/repo#n is rejected with GitHub Action guidance', async () => {
    await expect(makePlatform().fetchTask('owner/repo#123')).rejects.toThrowError(
      /GitHub Action/,
    );
  });

  it('unknown ref shape is rejected descriptively', async () => {
    await expect(makePlatform().fetchTask('not-a-ref')).rejects.toThrowError(/仅支持/);
  });
});

describe('gh helpers', () => {
  it('extractPullRequestUrl parses gh output', () => {
    expect(
      extractPullRequestUrl('see https://github.com/a/b/pull/7 done'),
    ).toEqual({ number: 7, url: 'https://github.com/a/b/pull/7' });
    expect(extractPullRequestUrl('no url here')).toBeUndefined();
  });

  it('default gh runner degrades ENOENT into notFound (no real gh spawn in tests)', async () => {
    // run the real runner against a binary path that cannot exist to assert
    // the ENOENT branch maps to notFound=true (fails only if gh EXISTS).
    const runner = defaultGhRunner('aiwf-no-such-gh-binary-<sentinel>');
    const result = await runner(['pr', 'create'], '.');
    expect(result.notFound).toBe(true);
  });
});
