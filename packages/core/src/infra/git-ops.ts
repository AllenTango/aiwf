/**
 * infra/git-ops — GitOps 的 Node 实现(node:child_process 驱动真实 git)。
 *
 * 约定:
 * - 所有 argv 走参数数组,不拼接 shell 字符串;子进程 env 默认继承 process.env。
 * - 基础设施层(git/文件)失败一律 throw,错误信息使用描述性中文并附 git 输出尾部。
 * - async 方法内部使用 spawn() 并以 Promise 等待(非 spawnSync),便于进程级注入。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChangedFile, GitOps } from '../contracts/index.js';

/** 子进程执行结果(stdout/stderr 已按 utf8 解码)。 */
export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 可注入的 spawn 形状:与 node:child_process.spawn 相同的调用方式。
 * 返回值通常是 ChildProcess;注入方可以换成测试替身。
 */
export type SpawnGitLike = (
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
) => ChildProcess;

export interface NodeGitOpsOptions {
  /** git 可执行文件,默认 AIWF_GIT_BIN ?? 'git'。 */
  gitBin?: string;
  /** 注入的 spawn 实现(测试替身用)。 */
  spawnImpl?: SpawnGitLike;
  /** 需要合并进子进程 env 的额外变量(默认继承 process.env)。 */
  extraEnv?: Record<string, string>;
}

/** git 强制署名(成员提交统一由 bot 负责,避免依赖本机全局 git 配置)。 */
export const AIWF_GIT_AUTHOR_ARGS = [
  '-c', 'user.name=aiwf[bot]',
  '-c', 'user.email=aiwf[bot]@users.noreply.github.com',
] as const;

/** changedFiles 读取文件内容的字节上限;超出截断并写 note。 */
export const MAX_CHANGED_FILE_BYTES = 500 * 1024;

const OUTPUT_TAIL_CHARS = 600;

function tail(text: string, max = OUTPUT_TAIL_CHARS): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

/** 把 git 参数拼成便于阅读(仅供错误信息展示,不用于真实执行)的命令行文本。 */
function argsForDisplay(args: readonly string[]): string {
  return args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
}

/** worktree 目录名安全 slug:把分支名压成 Windows 合法且可读的目录名。 */
export function slugifyBranch(branch: string): string {
  const slug = branch
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_]+|[.\-_]+$/g, '');
  if (!slug || slug === '.' || slug === '..') return 'wt';
  return slug;
}

export class NodeGitOps implements GitOps {
  private readonly gitBin: string;
  private readonly spawnImpl: SpawnGitLike;
  private readonly extraEnv?: Record<string, string>;

  constructor(options: NodeGitOpsOptions = {}) {
    this.gitBin = options.gitBin ?? process.env.AIWF_GIT_BIN ?? 'git';
    this.spawnImpl = options.spawnImpl ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.extraEnv = options.extraEnv;
  }

  // -------------------------------------------------------------------------
  // 内部:spawn 同步等待
  // -------------------------------------------------------------------------

  /** 在 dir(可空)下执行 git;等待进程结束,返回 code/stdout/stderr。 */
  public async runGit(
    dir: string | null,
    args: readonly string[],
    envOverrides?: Record<string, string>,
  ): Promise<GitRunResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.extraEnv ?? {}), ...(envOverrides ?? {}) };
    const child = this.spawnImpl(this.gitBin, [...args], {
      cwd: dir ?? undefined,
      env,
      windowsHide: true,
    });
    return new Promise<GitRunResult>((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.on('error', (e: NodeJS.ErrnoException) => {
        reject(new Error(`AIWF(git): 无法启动 git 进程(命令: git ${argsForDisplay(args)},cwd: ${dir ?? '.'}): ${e.code ?? ''} ${e.message}`));
      });
      child.stdout?.on('data', (c: Buffer) => out.push(c));
      child.stderr?.on('data', (c: Buffer) => err.push(c));
      child.on('close', (code: number | null) => {
        resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
    });
  }

  /** runGit + 失败即抛错(附 git 输出尾部与中文说明)。 */
  private async must(dir: string | null, args: readonly string[], what: string, envOverrides?: Record<string, string>): Promise<string> {
    const r = await this.runGit(dir, args, envOverrides);
    if (r.code !== 0) {
      throw new Error(
        `AIWF(git): ${what}失败(git ${argsForDisplay(args)},退出码 ${r.code});` +
        `stderr 尾部: ${tail(r.stderr) || '(空)'};stdout 尾部: ${tail(r.stdout) || '(空)'}`,
      );
    }
    return r.stdout;
  }

  // -------------------------------------------------------------------------
  // GitOps 契约实现
  // -------------------------------------------------------------------------

  async currentBranch(dir: string): Promise<string> {
    // 空仓库(尚未有提交)时 rev-parse HEAD 会失败,退回 symbolic-ref。
    const r = await this.runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (r.code === 0) return r.stdout.trim();
    const r2 = await this.runGit(dir, ['symbolic-ref', '--short', 'HEAD']);
    if (r2.code === 0) return r2.stdout.trim();
    throw new Error(
      `AIWF(git): 无法获取当前分支(${dir});两步探测均失败: ` +
      `rev-parse: ${tail(r.stderr)};symbolic-ref: ${tail(r2.stderr)}`,
    );
  }

  async ensureWorktree(rootDir: string, branch: string): Promise<string> {
    if (!branch || !branch.trim()) throw new Error('AIWF(git): ensureWorktree 缺少分支名');
    const slug = slugifyBranch(branch);
    const wtDir = path.join(rootDir, 'aiwf-work', slug);
    await fs.mkdir(path.dirname(wtDir), { recursive: true }); // 确保父目录存在

    // 已注册的同路径 worktree:直接复用(比较同时容错大小写/分隔符/短长路径形态,
    // 仅按本仓库 worktree 清单比对,不会误伤其他仓库)。
    const list = await this.must(rootDir, ['worktree', 'list', '--porcelain'], '列出 worktree');
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const targetSuffix = `/aiwf-work/${slug.toLowerCase()}`;
    const registered = list
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .some((l) => {
        const np = norm(l.slice('worktree '.length).trim());
        return np === norm(wtDir) || np.endsWith(targetSuffix);
      });
    if (registered) return wtDir;

    // 目录已存在但未注册:视为上次崩溃残留(aiwf-work 归本工具所有),先清理。
    if (await exists(wtDir)) {
      await fs.rm(wtDir, { recursive: true, force: true });
    }

    const branchExists = await this.runGit(rootDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    const args = branchExists.code === 0
      ? ['worktree', 'add', wtDir, branch]
      : ['worktree', 'add', '-b', branch, wtDir, 'HEAD'];
    let r = await this.runGit(rootDir, args);
    if (r.code !== 0 && /already registered|is a missing but already registered/.test(r.stderr)) {
      // 注册表有残留(目录被外部删除等):prune 后重试一次。
      await this.runGit(rootDir, ['worktree', 'prune']);
      r = await this.runGit(rootDir, args);
    }
    if (r.code !== 0) {
      throw new Error(
        `AIWF(git): 创建 worktree(分支 ${branch})失败(git ${argsForDisplay(args)},退出码 ${r.code});` +
        `stderr 尾部: ${tail(r.stderr) || '(空)'};stdout 尾部: ${tail(r.stdout) || '(空)'}`,
      );
    }
    return wtDir;
  }

  async commitAll(dir: string, message: string): Promise<void> {
    await this.must(dir, ['add', '-A'], '暂存全部变更(add -A)');
    const st = await this.must(dir, ['status', '--porcelain'], '检查工作区状态');
    if (!st.trim()) return; // 无变更:跳过提交(不抛错,契约允许空 op)
    await this.must(dir, [...AIWF_GIT_AUTHOR_ARGS, 'commit', '-m', message], '创建提交');
  }

  async diffStat(dir: string, base: string, target: string): Promise<string> {
    return this.must(dir, ['diff', '--stat', base, target], '计算 diff --stat');
  }

  async mergeBranch(rootDir: string, branch: string): Promise<void> {
    const r = await this.runGit(
      rootDir,
      [
        ...AIWF_GIT_AUTHOR_ARGS,
        'merge', '--no-ff', branch, '-m', `merge: ${branch}`,
      ],
    );
    if (r.code === 0) return;

    // 合并失败(含冲突):先在冲突态抓取冲突文件清单,再 abort。
    let conflicted: string[] = [];
    try {
      const u = await this.runGit(rootDir, ['diff', '--name-only', '--diff-filter=U']);
      if (u.code === 0) conflicted = u.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch { /* 忽略清单抓取失败,继续 abort */ }
    let aborted = '';
    try {
      await this.runGit(rootDir, ['merge', '--abort']);
    } catch (e) {
      aborted = e instanceof Error ? e.message : String(e);
    }
    throw new Error(
      `AIWF(git): 合并分支 ${branch} 失败(git merge 退出码 ${r.code});` +
      `冲突文件(未解决): ${conflicted.length ? conflicted.join(', ') : '(无或未能获取)'};` +
      `git 输出尾部: ${tail(r.stderr) || tail(r.stdout) || '(空)'}` +
      (aborted ? `;merge --abort 记录: ${tail(aborted, 300)}` : ''),
    );
  }

  async removeWorktree(rootDir: string, worktreeDir: string): Promise<void> {
    // 失败仅记录、不抛错(契约语义:清理是 best-effort)。
    try {
      await this.must(rootDir, ['worktree', 'remove', '--force', worktreeDir], `移除 worktree(${worktreeDir})`);
    } catch (e) {
      console.warn(`AIWF(git): removeWorktree 静默失败(${worktreeDir}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async pushBranch(rootDir: string, branch: string, remote = 'origin'): Promise<void> {
    let remotes = '';
    try {
      remotes = await this.must(rootDir, ['remote'], '查询远端列表');
    } catch {
      remotes = '';
    }
    const names = remotes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!names.includes(remote)) {
      throw new Error(
        `AIWF(git): pushBranch 失败——仓库(${rootDir})不存在远端 "${remote}"。` +
        `当前远端: ${names.length ? names.join(', ') : '(无远端,先 git remote add <name> <url>)'}`,
      );
    }
    await this.must(rootDir, ['push', remote, `HEAD:refs/heads/${branch}`], `推送分支 ${branch}`);
  }
}

// ---------------------------------------------------------------------------
// changedFiles 收集(opencode engine 使用;M1 pipeline 亦可直接引用)
// ---------------------------------------------------------------------------

/** 解析 porcelain v1 单行状态码,映射 ChangedFileAction。返回 null 表示不关心该行。 */
function classifyStatus(xy: string): ChangedFile['action'] | null {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (x === '?' && y === '?') return 'add';
  if (x === '!' || y === '!') return null; // ignored
  if (x === 'D' || y === 'D') return 'delete';
  if (x === 'A' || x === 'C' || x === 'R') return x === 'A' ? 'add' : 'modify';
  if (y === 'A' || y === 'C' || y === 'R') return y === 'A' ? 'add' : 'modify';
  if (x === 'M' || y === 'M' || x === 'T' || y === 'T') return 'modify';
  return 'modify';
}

/** porcelain v1 对路径进行 C 风格转义(quoted + 八进制);还原为原始路径。 */
function unquotePorcelainPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] ?? '';
    if (ch === '\\' && i + 1 < inner.length) {
      const n = inner[i + 1];
      if (n !== undefined && /[0-7]/.test(n)) {
        // 连续八进制转义段:每段 1~3 位,porcelain 固定 3 位。
        const oct = inner.slice(i + 1, i + 4).match(/^[0-7]{3}/);
        if (oct?.[0]) {
          bytes.push(parseInt(oct[0], 8));
          i += 3;
          continue;
        }
      }
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
      if (n !== undefined && n in map) {
        const mapped = map[n];
        if (mapped !== undefined) {
          bytes.push(mapped);
          i++;
          continue;
        }
      }
      if (n !== undefined) {
        bytes.push(n.charCodeAt(0));
        i++;
      }
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 概率二进制探测:前 1KB 出现 NUL 即视为二进制。 */
function looksBinary(content: string): boolean {
  const n = Math.min(content.length, 1024);
  for (let i = 0; i < n; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

export interface CollectChangedFilesOptions {
  /** 需要合并诊断信息的 notes 数组(可选)。 */
  notes?: string[];
  /** 注入 git 执行器(测试用);默认构造 NodeGitOps。 */
  git?: Pick<NodeGitOps, 'runGit'>;
}

/**
 * 在 dir 内运行 `git status --porcelain --untracked-files=all`,
 * 把变更解析为 ChangedFile[];add/modify 的文件读取内容(超 500KB 截断 + note)。
 * 诊断信息(截断/二进制/读取失败)只写进 notes,不影响主流程。
 */
export async function collectChangedFiles(dir: string, options: CollectChangedFilesOptions = {}): Promise<ChangedFile[]> {
  const git = options.git ?? new NodeGitOps();
  const notes = options.notes;
  const r = await git.runGit(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (r.code !== 0) {
    throw new Error(`AIWF(git): 统计变更失败(git status --porcelain,退出码 ${r.code});stderr 尾部: ${tail(r.stderr)}`);
  }
  const results: ChangedFile[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rawPath = line.slice(3);
    if (rawPath.includes(' -> ')) {
      // 复制/重命名:porcelain v1 输出 "old -> new",取新路径。
      const newPath = unquotePorcelainPath(rawPath.split(' -> ').pop() ?? '');
      const action = classifyStatus(xy);
      if (!action) continue;
      await pushContentFile(results, dir, newPath, action === 'delete' ? 'delete' : action, notes);
      continue;
    }
    const p = unquotePorcelainPath(rawPath);
    const action = classifyStatus(xy);
    if (!action) continue;
    await pushContentFile(results, dir, p, action, notes);
  }
  return results;
}

async function pushContentFile(
  out: ChangedFile[],
  dir: string,
  p: string,
  action: ChangedFile['action'],
  notes?: string[],
): Promise<void> {
  if (action === 'delete') {
    out.push({ path: p, action: 'delete' });
    return;
  }
  const abs = path.join(dir, ...p.split('/'));
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      out.push({ path: p, action });
      return;
    }
    const size = Math.min(stat.size, MAX_CHANGED_FILE_BYTES);
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      let content = buf.toString('utf8');
      if (looksBinary(content)) {
        out.push({ path: p, action });
        notes?.push(`变更文件疑似二进制,未读取内容: ${p}`);
        return;
      }
      if (stat.size > MAX_CHANGED_FILE_BYTES) {
        content += `\n…(AIWF: 内容在 ${MAX_CHANGED_FILE_BYTES} 字节处截断,原始 ${stat.size} 字节)`;
        notes?.push(`变更文件过大已截断内容: ${p}`);
      }
      out.push({ path: p, action, content });
    } finally {
      await fh.close();
    }
  } catch (e) {
    // 状态与读取之间文件消失等情况:仍保留 action,但不带 content。
    out.push({ path: p, action });
    notes?.push(`变更文件读取失败(保留元数据): ${p}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Windows 大小写不敏感 + 分隔符归一化的目录等价比较。 */
function isSameDir(a: string, b: string): boolean {
  const na = path.normalize(a).replace(/[/\\]+$/, '');
  const nb = path.normalize(b).replace(/[/\\]+$/, '');
  return na.toLowerCase() === nb.toLowerCase();
}
