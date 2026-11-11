import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { TaskInput, TaskSource } from '@aiwf/core';
import { UsageError } from './errors.js';

/** utf8 file loader: the fs/promises default returns a Buffer — force text. */
export const readUtf8 = (path: string): Promise<string> => readFile(path, 'utf8');

export interface TaskSourceFlags {
  /** "owner/repo#123" — not supported locally, see TASK_GUIDE. */
  issue?: string;
  /** Path to a .md / .json (or plain text) task file. */
  from?: string;
  /** One-line request text. */
  inline?: string;
}

export const TASK_GUIDE = `--issue 需要访问 GitHub,本地 CLI v0.1 无法拉取远程 issue。
请改为以下任一方式:
  1) 完整 Issue→PR 闭环:在 GitHub 上用 issue 触发 aiwf GitHub Action(推荐);
  2) 本地:aiwf run --from <file.md|file.json>   或   aiwf run --inline "<一句话诉求>"。`;

export const USAGE_ONE_OF = `必须且只能提供一种任务来源(--issue / --from / --inline 三选一)。
示例:
  aiwf run --inline "给 README 增加 Quick Start 段落"
  aiwf run --from demo.md --dry-run`;

export interface ParsedTaskContent {
  title: string;
  body: string;
  comments?: string[];
  metadata?: Record<string, string>;
}

/** Markdown/text: if the first line starts with '#', it is the title and the
 *  rest is the body; otherwise the first non-empty line doubles as title. */
export function parseMarkdownTask(text: string): ParsedTaskContent {
  if (text.trim().length === 0) {
    throw new UsageError('--from 文件内容为空。');
  }
  const lines = text.split('\n');
  const firstLine = (lines[0] ?? '').trim();
  if (firstLine.startsWith('#')) {
    const title = firstLine.replace(/^#+\s*/, '').trim() || 'Local task';
    const body = lines.slice(1).join('\n').trim();
    return { title, body: body.length > 0 ? body : title };
  }
  const title = firstLine.length > 0 ? firstLine : 'Local task';
  return { title, body: text.trim() };
}

/** JSON: {title, body, comments?, metadata?}. title/body are required strings. */
export function parseJsonTask(text: string): ParsedTaskContent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`--from 的 JSON 解析失败:${detail}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError('--from 的 JSON 需为对象,包含 { title, body, comments?, metadata? }。');
  }
  const record = raw as Record<string, unknown>;
  const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
  const body = typeof record['body'] === 'string' ? record['body'] : undefined;
  if (title.length === 0) {
    throw new UsageError('--from 的 JSON 需包含非空 title 字段。');
  }
  if (typeof body !== 'string') {
    throw new UsageError('--from 的 JSON 需包含字符串 body 字段。');
  }
  const comments = Array.isArray(record['comments'])
    ? (record['comments'] as unknown[]).filter((c): c is string => typeof c === 'string')
    : undefined;
  const rawMetadata =
    typeof record['metadata'] === 'object' && record['metadata'] !== null
      ? (record['metadata'] as Record<string, unknown>)
      : undefined;
  let metadata: Record<string, string> | undefined;
  if (rawMetadata) {
    metadata = {};
    for (const [key, value] of Object.entries(rawMetadata)) {
      if (typeof value === 'string') metadata[key] = value;
    }
  }
  return {
    title,
    body,
    ...(comments && comments.length > 0 ? { comments } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export async function parseTaskFromFile(
  filePath: string,
  loader: (path: string) => Promise<string> = readUtf8,
): Promise<ParsedTaskContent> {
  let text: string;
  try {
    text = await loader(filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`--from 文件不可读:${filePath}(${detail})`);
  }
  if (text.trim().length === 0) {
    throw new UsageError(`--from 文件为空:${filePath}`);
  }
  switch (extname(filePath).toLowerCase()) {
    case '.json':
      return parseJsonTask(text);
    case '.md':
    case '.markdown':
    case '.txt':
    case '': // extension-less files are treated as plain text
      return parseMarkdownTask(text);
    default:
      // Unknown extensions: fall back to the lenient text parser.
      return parseMarkdownTask(text);
  }
}

export function parseInlineTask(text: string): ParsedTaskContent {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new UsageError('--inline 内容不能为空。');
  }
  const firstBreak = trimmed.indexOf('\n');
  const title = (firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak).trim()) || 'Local task';
  return { title, body: trimmed };
}

/** --json tasks carry their own metadata/comments; text tasks stay minimal. */
export function intoTaskInput(
  source: Extract<TaskSource, 'file' | 'inline'>,
  ref: string | undefined,
  parsed: ParsedTaskContent,
): TaskInput {
  return {
    source,
    ...(ref !== undefined ? { ref } : {}),
    title: parsed.title,
    body: parsed.body,
    ...(parsed.comments ? { comments: parsed.comments } : {}),
    ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
  };
}

/**
 * Exactly one of --issue / --from / --inline must be provided.
 * - --issue is rejected locally with guidance toward the GitHub Action.
 * - --from is parsed by extension (.md/.markdown/.txt text; .json object).
 * - --inline takes the first line as title and everything as body.
 */
export async function resolveTaskInput(
  flags: TaskSourceFlags,
  loader: (path: string) => Promise<string> = readUtf8,
): Promise<TaskInput> {
  const provided: TaskSource[] = [];
  if (flags.issue !== undefined) provided.push('issue');
  if (flags.from !== undefined) provided.push('file');
  if (flags.inline !== undefined) provided.push('inline');

  if (provided.length === 0) {
    throw new UsageError(`${USAGE_ONE_OF}\n(${TASK_GUIDE.split('\n')[0] as string})`);
  }
  if (provided.length > 1) {
    throw new UsageError(`任务来源互斥:同时收到 ${provided.join(' + ')}。${USAGE_ONE_OF}`);
  }
  // Length is exactly 1 here (validation above); safe to index.
  const chosen: TaskSource = provided[0] as TaskSource;

  switch (chosen) {
    case 'issue':
      if (!flags.issue) throw new UsageError('--issue 需要形如 owner/repo#123 的引用。');
      throw new UsageError(`本地 CLI 不支持 --issue "${flags.issue}"。\n${TASK_GUIDE}`);
    case 'file': {
      const filePath = flags.from;
      if (!filePath) throw new UsageError('--from 需要一个文件路径。');
      return intoTaskInput('file', filePath, await parseTaskFromFile(filePath, loader));
    }
    case 'inline': {
      const text = flags.inline;
      if (!text) throw new UsageError('--inline 需要一段非空文本。');
      return intoTaskInput('inline', undefined, parseInlineTask(text));
    }
  }
}
