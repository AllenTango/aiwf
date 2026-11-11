import { describe, expect, it } from 'vitest';
import { UsageError } from './errors.js';
import {
  parseInlineTask,
  parseJsonTask,
  parseMarkdownTask,
  resolveTaskInput,
} from './task-input.js';

/** In-memory loader standing in for fs.readFile. */
const loaderOf =
  (files: Record<string, string>) =>
  async (path: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return content;
  };

describe('format 1 — markdown with "# " heading', () => {
  it('first line becomes title, the rest becomes body', () => {
    const parsed = parseMarkdownTask('# Fix login flow\n\nSteps: 1. reproduce 2. patch');
    expect(parsed.title).toBe('Fix login flow');
    expect(parsed.body).toBe('Steps: 1. reproduce 2. patch');
  });
});

describe('format 2 — markdown without heading', () => {
  it('first non-empty line doubles as title', () => {
    const parsed = parseMarkdownTask('给 README 增加 Quick Start 段落\n然后再加 FAQ');
    expect(parsed.title).toBe('给 README 增加 Quick Start 段落');
    expect(parsed.body).toContain('然后再加 FAQ');
  });
});

describe('format 3 — json full object', () => {
  it('title/body/comments/metadata flow through', () => {
    const parsed = parseJsonTask(
      JSON.stringify({
        title: 'T',
        body: 'B',
        comments: ['c1'],
        metadata: { priority: 'high' },
      }),
    );
    expect(parsed.title).toBe('T');
    expect(parsed.body).toBe('B');
    expect(parsed.comments).toEqual(['c1']);
    expect(parsed.metadata).toEqual({ priority: 'high' });
  });
});

describe('format 4 — plain .txt file (no heading)', () => {
  it('parses like a no-heading markdown text, .txt extension accepted', async () => {
    const task = await resolveTaskInput(
      { from: 'note.txt' },
      loaderOf({ 'note.txt': '整理 scripts\n包含 dev/build/test' }),
    );
    expect(task.title).toBe('整理 scripts');
    expect(task.body).toContain('dev/build/test');
  });

  it('extension-less files are treated as plain text too', async () => {
    const task = await resolveTaskInput(
      { from: 'note' },
      loaderOf({ note: 'first line acts as title' }),
    );
    expect(task.title).toBe('first line acts as title');
  });
});

describe('failures', () => {
  it('missing file yields a UsageError', async () => {
    await expect(
      resolveTaskInput({ from: 'nope.md' }, loaderOf({})),
    ).rejects.toThrowError(UsageError);
  });

  it('empty file content yields a UsageError', async () => {
    await expect(
      resolveTaskInput({ from: 'empty.md' }, loaderOf({ 'empty.md': '\n \n' })),
    ).rejects.toThrowError(/文件为空/);
  });

  it('invalid JSON yields a UsageError', async () => {
    await expect(
      resolveTaskInput({ from: 'bad.json' }, loaderOf({ 'bad.json': '{oops' })),
    ).rejects.toThrowError(/JSON 解析失败/);
  });

  it('json missing title yields a UsageError', async () => {
    await expect(
      resolveTaskInput(
        { from: 'nt.json' },
        loaderOf({ 'nt.json': '{"body":"x"}' }),
      ),
    ).rejects.toThrowError(/title/);
  });

  it('json missing body yields a UsageError', () => {
    expect(() => parseJsonTask('{"title":"T"}')).toThrowError(/body/);
  });

  it('empty inline yields a UsageError', () => {
    expect(() => parseInlineTask('   ')).toThrowError(UsageError);
  });
});

describe('one-of source validation', () => {
  it('no source at all → usage error with guidance', async () => {
    await expect(resolveTaskInput({}, loaderOf({}))).rejects.toThrowError(
      /三选一/,
    );
  });

  it('issue + from → usage error (互斥)', async () => {
    await expect(
      resolveTaskInput({ issue: 'o/r#1', from: 'a.md' }, loaderOf({})),
    ).rejects.toThrowError(/互斥/);
  });

  it('from + inline → usage error (互斥)', async () => {
    await expect(
      resolveTaskInput({ from: 'a.md', inline: 'x' }, loaderOf({})),
    ).rejects.toThrowError(/互斥/);
  });

  it('inline + issue → usage error (互斥)', async () => {
    await expect(
      resolveTaskInput({ inline: 'x', issue: 'o/r#1' }, loaderOf({})),
    ).rejects.toThrowError(/互斥/);
  });

  it('issue alone → descriptive guidance toward GitHub Action', async () => {
    const error = await resolveTaskInput({ issue: 'o/r#7' }, loaderOf({})).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain('o/r#7');
    expect((error as UsageError).message).toContain('GitHub Action');
  });
});

describe('inline parsing', () => {
  it('single line: title equals body', () => {
    const parsed = parseInlineTask('给 README 增加 Quick Start 段落');
    expect(parsed.title).toBe('给 README 增加 Quick Start 段落');
    expect(parsed.body).toBe(parsed.title);
  });

  it('multi line: first line is the title', () => {
    const parsed = parseInlineTask('标题行\n正文第二行');
    expect(parsed.title).toBe('标题行');
    expect(parsed.body).toBe('标题行\n正文第二行');
  });
});

describe('file → TaskInput via resolveTaskInput', () => {
  it('md file becomes source=file with ref', async () => {
    const task = await resolveTaskInput(
      { from: 'demo.md' },
      loaderOf({ 'demo.md': '# Demo\n\nbody text' }),
    );
    expect(task.source).toBe('file');
    expect(task.ref).toBe('demo.md');
    expect(task.title).toBe('Demo');
    expect(task.body).toBe('body text');
  });

  it('json metadata/comments are preserved', async () => {
    const task = await resolveTaskInput(
      { from: 'task.json' },
      loaderOf({
        'task.json': JSON.stringify({
          title: 'Pack',
          body: 'ship it',
          metadata: { k: 'v' },
        }),
      }),
    );
    expect(task.source).toBe('file');
    expect(task.metadata).toEqual({ k: 'v' });
  });

  it('inline becomes source=inline without ref', async () => {
    const task = await resolveTaskInput({ inline: 'quick ask' });
    expect(task.source).toBe('inline');
    expect(task.ref).toBeUndefined();
    expect(task.title).toBe('quick ask');
  });
});
