/**
 * infra/repo-context — 构建发给规划器/成员的仓库快照(RepoContext)。
 *
 * 自含实现(node:fs),无自动吞错:
 * - 根目录不可用 / git 不可用 → 抛描述性中文错误;
 * - 缺失的候选文件安静跳过(记录跳过原因);
 * - 深度/条目/token 预算造成的省略,全部在 treePreview 尾部的 `# …` 注释行注明
 *   (RepoContext 无 notes 字段,丢弃信息只能附在树尾)。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NodeGitOps } from './git-ops.js';
import type { RepoContext, FileSnippet } from '../contracts/index.js';

export interface BuildRepoContextOptions {
  /** 文件树最大深度(根的子项为 1),默认 3。 */
  maxDepth?: number;
  /** 文件树最大条目数,默认 200。 */
  maxEntries?: number;
  /** keyFiles 整体 token 预算(tokens ≈ 字符数/4),默认 4000。 */
  keyFilesBudgetTokens?: number;
  /** 单个 keyFile 最多读取的行数,默认 120(超出则截断并标注)。 */
  keyFileMaxLines?: number;
  /** 需求关键词:命中的相关文件会被优先纳入 keyFiles(见 extractKeywords)。 */
  keywords?: readonly string[];
  /** 最近提交条数上限,默认 20;0 = 不取。 */
  recentCommits?: number;
}

/** keyFiles 候选(按序;通配符只作用于单个路径段)。 */
export const KEY_FILE_CANDIDATES: readonly string[] = [
  'README*',
  'package.json',
  'tsconfig*',
  'action.yml',
  'pnpm-workspace.yaml',
  '.github/workflows/*.yml',
  'LICENSE',
  'CONTRIBUTING*',
];

/** 目录名排除(任意层级)。 */
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'aiwf-work', 'coverage']);

/** 文件名排除(单段通配,匹配 basename)。 */
const EXCLUDED_FILE_PATTERNS = ['.env*', '*.lock', 'pnpm-lock*'];

/** keyFiles 扫描深度(与树展示深度解耦,workflows 通常在三层内)。 */
const KEY_FILES_SCAN_DEPTH = 5;

const KEY_FILE_MAX_BYTES = 1024 * 1024; // 单个 keyFile 最多读 1MiB

function defaultOptions(): Required<Omit<BuildRepoContextOptions, 'keywords'>> & { keywords: readonly string[] } {
  return {
    maxDepth: 3,
    maxEntries: 200,
    keyFilesBudgetTokens: 4000,
    keyFileMaxLines: 120,
    keywords: [],
    recentCommits: 20,
  };
}

/** 英文停用词(不作为检索关键词)。 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was', 'were',
  'not', 'but', 'you', 'your', 'can', 'will', 'should', 'would', 'could', 'into', 'than',
  'then', 'them', 'they', 'when', 'what', 'which', 'while', 'here', 'there', 'been', 'being',
  'does', 'did', 'doing', 'done', 'just', 'like', 'make', 'made', 'need', 'want', 'use',
  'used', 'using', 'add', 'added', 'new', 'old', 'all', 'any', 'each', 'more', 'most', 'some',
  'such', 'only', 'other', 'same', 'very', 'via', 'per', 'out', 'off', 'own', 'too', 'get',
]);

/**
 * 从需求文本里抽取**用于路径检索**的关键词(纯函数)。
 *
 * 抽取四类 token,按信号强度排序:
 * 1. 形如 `a/b/c` 的路径片段(取每一段)—— 命中最准;
 * 2. 标识符([A-Za-z_][A-Za-z0-9_]{3,},含驼峰)—— 能定位到具体实现文件;
 * 3. 英文单词(≥4 字母,去停用词);
 * 4. 连续中文片段(≥2 字)—— 兼容中文文件名。
 *
 * 目的:让队长能看到「需求相关的代码长什么样」,而不只是仓库目录树。
 */
export function extractKeywords(text: string, limit = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string, isPathSegment = false): void => {
    const token = raw.trim().toLowerCase();
    if (token.length < 2) return;
    // 纯字母 token 走停用词过滤(标识符规则会捞到 'this'/'with' 这类常见词)。
    if (!isPathSegment && /^[a-z]+$/.test(token) && STOP_WORDS.has(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  // 1) 路径片段
  for (const m of (text ?? '').matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g)) {
    for (const seg of m[0].split('/')) push(seg, true);
  }
  // 2) 标识符(含驼峰)
  for (const m of (text ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) push(m[0]);
  // 3) 英文单词
  for (const m of (text ?? '').matchAll(/[A-Za-z]{4,}/g)) push(m[0]);
  // 4) 中文片段:短串整体保留;长串切 4 字滑窗(兼顾中文文件名与长句)
  for (const m of (text ?? '').matchAll(/[一-龥]{2,}/g)) {
    const run = m[0];
    if (run.length <= 8) {
      push(run);
      continue;
    }
    for (let i = 0; i + 4 <= run.length && i < 24; i++) push(run.slice(i, i + 4));
  }

  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 排除与匹配
// ---------------------------------------------------------------------------

function isExcludedDirName(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function isExcludedFileName(name: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((p) => globToRegExp(p).test(name));
}

/** 候选 glob 是否匹配相对路径(单段 *;不含 **)。 */
function matchPattern(pattern: string, relPath: string): boolean {
  const pp = pattern.split('/');
  const rp = relPath.split('/');
  if (pp.length !== rp.length) return false;
  return pp.every((seg, i) => globToRegExp(seg).test(rp[i] ?? ''));
}

// ---------------------------------------------------------------------------
// 文件树
// ---------------------------------------------------------------------------

interface WalkResult {
  /** 渲染好的树行(缩进;目录条目以 '/' 结尾)。 */
  lines: string[];
  /** 收录条目数。 */
  count: number;
  /** 是否因 maxEntries 被截断。 */
  truncated: boolean;
}

/** 递归走目录;跳过排除项与 symlink(防环);产出确定性的缩进树行。 */
async function walkTree(rootDir: string, maxDepth: number, maxEntries: number): Promise<WalkResult> {
  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const visit = async (absDir: string, depth: number): Promise<void> => {
    if (truncated || depth > maxDepth) return;
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // 无权限/瞬时消失:安静跳过该层
    }
    const entries: { name: string; isDir: boolean }[] = [];
    for (const d of dirents) {
      const name = d.name;
      if (d.isDirectory()) {
        if (isExcludedDirName(name)) continue;
        entries.push({ name, isDir: true });
      } else if (d.isFile()) {
        if (isExcludedFileName(name)) continue;
        entries.push({ name, isDir: false });
      }
      // symlink/设备等其它形态:跳过,避免循环与误报
    }
    // 目录在前、文件在后,各自按字典序,输出确定。
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    for (const e of entries) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      count++;
      const indent = '  '.repeat(depth - 1);
      lines.push(`${indent}${e.name}${e.isDir ? '/' : ''}`);
      if (e.isDir) await visit(path.join(absDir, e.name), depth + 1);
    }
  };

  await visit(rootDir, 1);
  // 达到条目预算即视为"可能截断"(保守标注,宁可多提示不漏提示)。
  return { lines, count, truncated: truncated || count >= maxEntries };
}

// ---------------------------------------------------------------------------
// keyFiles
// ---------------------------------------------------------------------------

/** 收集 rootDir 下(带排除规则、深度上限)的全部相对文件路径(POSIX 分隔)。 */
async function collectRelPaths(rootDir: string, scanDepth: number): Promise<string[]> {
  const out: string[] = [];
  const visit = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > scanDepth) return;
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const name = d.name;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (d.isDirectory()) {
        if (isExcludedDirName(name)) continue;
        await visit(path.join(absDir, name), rel, depth + 1);
      } else if (d.isFile()) {
        if (isExcludedFileName(name)) continue;
        out.push(rel);
      }
    }
  };
  await visit(rootDir, '', 1);
  return out;
}

/** 前 1KB 含 NUL → 视为二进制。 */
async function looksBinary(absPath: string): Promise<boolean> {
  let fh;
  try {
    fh = await fs.open(absPath, 'r');
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return false; // 无法判读按非二进制处理;后续读取失败会安静跳过
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

/** 读取单个 keyFile;返回 null 表示跳过(缺失/二进制/读取失败)。 */
async function readKeyFile(absPath: string, maxLines: number): Promise<{ content: string; lines: number; clipped: boolean } | null> {
  try {
    if (await looksBinary(absPath)) return null;
    const stat = await fs.stat(absPath);
    let buf: Buffer;
    let sizeCapped = false;
    if (stat.size > KEY_FILE_MAX_BYTES) {
      const fh = await fs.open(absPath, 'r');
      try {
        buf = Buffer.alloc(KEY_FILE_MAX_BYTES);
        await fh.read(buf, 0, buf.length, 0);
      } finally {
        await fh.close();
      }
      sizeCapped = true;
    } else {
      buf = await fs.readFile(absPath);
    }
    const text = buf.toString('utf8').replace(/^\uFEFF/, ''); // 去 BOM
    const all = text.split(/\r?\n/);
    const ownLines = all.length;
    if (ownLines <= maxLines) {
      const content = sizeCapped ? `# 注意: 文件超过 1MiB,仅读取了头部\n${text}` : text;
      return { content, lines: ownLines, clipped: sizeCapped };
    }
    const kept = all.slice(0, maxLines).join('\n');
    const marker = `# 注意: 仅展示前 ${maxLines} 行(共 ${ownLines} 行)${sizeCapped ? ';文件超过 1MiB,仅读取了头部' : ''}`;
    return { content: `${kept}\n${marker}`, lines: ownLines, clipped: true };
  } catch {
    return null;
  }
}

async function buildKeyFiles(rootDir: string, opts: Required<Omit<BuildRepoContextOptions, 'keywords'>> & { keywords: readonly string[] }): Promise<{ snippets: FileSnippet[]; notes: string[] }> {
  const relPaths = await collectRelPaths(rootDir, KEY_FILES_SCAN_DEPTH);
  const snippets: FileSnippet[] = [];
  const notes: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  const taken = new Set<string>();

  const pushSnippet = async (rel: string, why: string): Promise<void> => {
    if (taken.has(rel)) return;
    const read = await readKeyFile(path.join(rootDir, ...rel.split('/')), opts.keyFileMaxLines);
    if (!read) {
      notes.push(`keyFiles 跳过(缺失/读取失败或二进制): ${rel}`);
      return;
    }
    const tokens = Math.max(1, Math.round(read.content.length / 4));
    if (used + tokens > opts.keyFilesBudgetTokens) {
      dropped.push(`${rel}(${tokens} tokens)`);
      return;
    }
    used += tokens;
    taken.add(rel);
    snippets.push({ path: rel, content: read.content, tokens });
    if (why !== '') notes.push(`keyFiles 纳入(${why}): ${rel}`);
  };

  for (const pattern of KEY_FILE_CANDIDATES) {
    const matches = relPaths.filter((rel) => matchPattern(pattern, rel)).sort();
    for (const rel of matches) {
      await pushSnippet(rel, '');
    }
  }

  // 需求相关文件:按关键词命中数排序,追加在固定候选之后(仍受 token 预算约束)。
  const keywords = opts.keywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 2);
  if (keywords.length > 0) {
    const scored = relPaths
      .filter((rel) => !taken.has(rel))
      .map((rel) => {
        const lower = rel.toLowerCase();
        let hits = 0;
        for (const kw of keywords) {
          if (lower.includes(kw)) hits += 1;
        }
        return { rel, hits };
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => (b.hits - a.hits) || a.rel.localeCompare(b.rel))
      .slice(0, KEY_FILES_BY_KEYWORD_LIMIT);
    for (const { rel, hits } of scored) {
      await pushSnippet(rel, `命中需求关键词 ${hits} 个`);
    }
  }

  if (dropped.length) {
    notes.push(`keyFiles 超出 token 预算(~${opts.keyFilesBudgetTokens})按序丢弃: ${dropped.join('; ')}`);
  }
  return { snippets, notes };
}

/** 按关键词纳入的相关文件条数上限。 */
const KEY_FILES_BY_KEYWORD_LIMIT = 8;

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 构建仓库快照:
 * - branch:git rev-parse(空仓库回退 symbolic-ref);不可用则抛出中文错误。
 * - treePreview:缩进树(目录带 '/'),首行为说明注释,尾部 `# …` 注释注明一切省略。
 * - keyFiles:候选文件按序读入(单文件 ≤120 行截断并标注;~4000 token 预算按序丢弃)。
 */
export async function buildRepoContext(rootDir: string, options: BuildRepoContextOptions = {}): Promise<RepoContext> {
  const opts = { ...defaultOptions(), ...options };
  const maxDepth = Math.max(1, Math.floor(opts.maxDepth));
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries));

  const st = await fs.stat(rootDir);
  if (!st.isDirectory()) {
    throw new Error(`AIWF(repo-context): rootDir 不是目录: ${rootDir}`);
  }

  const git = new NodeGitOps();
  const branch = await git.currentBranch(rootDir);

  const [walk, keySet, commits] = await Promise.all([
    walkTree(rootDir, maxDepth, maxEntries),
    buildKeyFiles(rootDir, opts),
    readRecentCommits(rootDir, opts.recentCommits),
  ]);

  const notes: string[] = [...keySet.notes];
  if (walk.truncated) notes.push(`文件树在 ${maxEntries} 个条目处截断(达到上限)`);
  if (commits.length === 0 && opts.recentCommits > 0) {
    notes.push('未能读取最近提交历史(浅克隆/空仓库时正常)');
  }

  const head = `# repo 文件树(root=${path.basename(path.resolve(rootDir))};depth≤${maxDepth},entries≤${maxEntries})`;
  const parts = [head, walk.lines.join('\n'), ...notes.map((n) => `# ${n}`)];
  const treePreview = parts.filter((p) => p !== '').join('\n');

  return {
    rootDir,
    branch,
    treePreview,
    keyFiles: keySet.snippets,
    ...(commits.length > 0 ? { recentCommits: commits } : {}),
  };
}

/**
 * 读取最近提交摘要(`git log --oneline -N`)。
 *
 * 失败(浅克隆 / 空仓库 / 非 git 目录)一律安静返回空数组 —— 快照是增强项,
 * 不能因为拿不到历史就让整次运行失败。
 */
async function readRecentCommits(rootDir: string, limit: number): Promise<string[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const git = new NodeGitOps();
  try {
    const r = await git.runGit(rootDir, ['log', '--oneline', '--no-color', `-${Math.floor(limit)}`]);
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, Math.floor(limit));
  } catch {
    return [];
  }
}
