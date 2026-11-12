/**
 * pipeline/idempotency 单元测试:指纹稳定性与运行记录识别。
 */

import { describe, expect, it } from 'vitest';

import type { TaskInput } from '../contracts/index.js';
import type { IssueComment } from './decision-package.js';
import {
  RUN_MARKER,
  buildRunRecordComment,
  computeTaskFingerprint,
  findLastRunRecord,
  parseRunRecord,
} from './idempotency.js';

const task: TaskInput = {
  source: 'issue',
  ref: 'org/repo#42',
  title: '支持导出 CSV',
  body: '导出模块需要支持 CSV 格式。',
  comments: ['注意编码'],
};

describe('computeTaskFingerprint', () => {
  it('内容相同 → 指纹相同', () => {
    expect(computeTaskFingerprint(task)).toBe(computeTaskFingerprint({ ...task }));
  });

  it('标题/正文/评论任一变化 → 指纹不同', () => {
    const base = computeTaskFingerprint(task);
    expect(computeTaskFingerprint({ ...task, title: '改了标题' })).not.toBe(base);
    expect(computeTaskFingerprint({ ...task, body: '改了正文' })).not.toBe(base);
    expect(computeTaskFingerprint({ ...task, comments: ['换了评论'] })).not.toBe(base);
    expect(computeTaskFingerprint({ ...task, comments: ['注意编码', '多一条'] })).not.toBe(base);
  });

  it('不同任务 → 不同指纹;长度固定', () => {
    const other = computeTaskFingerprint({ ...task, title: '别的需求' });
    expect(other).not.toBe(computeTaskFingerprint(task));
    expect(computeTaskFingerprint(task)).toHaveLength(32);
  });
});

describe('parseRunRecord', () => {
  it('能解析自己生成的记录', () => {
    const body = buildRunRecordComment({
      fingerprint: 'abc123',
      at: '2026-01-01T00:00:00Z',
      members: 3,
      verdict: 'proceed',
    });
    const record = parseRunRecord(body);
    expect(record?.fingerprint).toBe('abc123');
    expect(record?.members).toBe(3);
    expect(record?.verdict).toBe('proceed');
  });

  it('普通评论 / 损坏的 JSON → null', () => {
    expect(parseRunRecord('普通评论')).toBeNull();
    expect(parseRunRecord(`${RUN_MARKER} {不是 json`)).toBeNull();
    expect(parseRunRecord(`${RUN_MARKER} {"members":1}`)).toBeNull();
  });

  it('记录用 HTML 注释包裹,GitHub 不会渲染出来', () => {
    const body = buildRunRecordComment({
      fingerprint: 'x',
      at: '',
      members: 0,
      verdict: 'proceed',
    });
    expect(body.startsWith('<!--')).toBe(true);
    expect(body.endsWith('-->')).toBe(true);
  });
});

describe('findLastRunRecord', () => {
  const rec = (fp: string, at: string): IssueComment => ({
    author: 'aiwf',
    body: buildRunRecordComment({ fingerprint: fp, at, members: 1, verdict: 'proceed' }),
    createdAt: at,
  });

  it('取时间最近的一条记录', () => {
    const found = findLastRunRecord([
      rec('old', '2026-01-01T00:00:00Z'),
      rec('new', '2026-01-02T00:00:00Z'),
    ]);
    expect(found?.fingerprint).toBe('new');
  });

  it('忽略普通评论', () => {
    const found = findLastRunRecord([
      { author: 'human', body: '普通评论', createdAt: '2026-01-02T00:00:00Z' },
      rec('only', '2026-01-01T00:00:00Z'),
    ]);
    expect(found?.fingerprint).toBe('only');
  });

  it('没有记录 → null', () => {
    expect(findLastRunRecord([])).toBeNull();
    expect(findLastRunRecord([{ author: 'h', body: 'x', createdAt: 'z' }])).toBeNull();
  });
});
