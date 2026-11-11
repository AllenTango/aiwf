/**
 * PR 正文构建(纯函数,不依赖 platform/engine):
 * buildPullRequestBody(task, plan, results, deliverableSummary) 的唯一职责
 * 是把原始诉求、计划概要、任务状态表、变更文件汇总(top10 + 计数)、
 * risks、成员备注精选与结项报告拼成结构化正文,并附生成声明。
 */

import type { ChangedFileAction, TaskInput, TaskResult, WorkflowPlan } from '../contracts/index.js';
import { clampLine, mdCell } from './md.js';
import { STATUS_MARK } from './summary.js';

/** 变更文件清单在 PR 正文中的条数上限(top N)。 */
const CHANGE_FILE_LIMIT = 10;
/** "成员备注精选"条数上限。 */
const MEMBER_NOTES_LIMIT = 12;
/** 原始诉求文本截断长度。 */
const REQUEST_EXCERPT_LIMIT = 800;

/** 由本工具生成的声明(也是测试锚点)。 */
export const PR_DISCLAIMER =
  '> 本 PR 由 AI 研发流水线(`@aiwf/core`)自动生成 — AI Native Dev Workflow(Issue → 并行成员 → 队长合成 → PR)。';

export function buildPullRequestBody(
  task: TaskInput,
  plan: WorkflowPlan,
  results: readonly TaskResult[],
  deliverableSummary: string,
): string {
  const lines: string[] = [];

  // ---- 原始诉求 -----------------------------------------------
  lines.push(`# [aiwf] ${task.title}`, '');
  lines.push('## 原始诉求');
  lines.push(`- 来源:${task.source}${task.ref === undefined || task.ref === '' ? '' : `(\`${task.ref}\`)`}`);
  if (task.body !== '') {
    lines.push('', clampLine(task.body, REQUEST_EXCERPT_LIMIT));
  }
  const comments = task.comments ?? [];
  if (comments.length > 0) {
    lines.push('', '**补充说明:**');
    for (const c of comments.slice(0, 5)) {
      lines.push(`> ${clampLine(c, 200)}`);
    }
  }

  // ---- 计划概要 -----------------------------------------------
  lines.push('', '## 计划概要');
  lines.push(plan.summary === '' ? '(计划未提供摘要)' : plan.summary);

  // ---- 逐任务状态表 -------------------------------------------
  lines.push('', '## 任务状态');
  if (results.length === 0) {
    lines.push('本次运行没有成员任务。');
  } else {
    lines.push('| 任务 | 状态 | 摘要 |', '| --- | --- | --- |');
    for (const r of results) {
      const digest = r.error ?? clampLine(r.summary, 200);
      lines.push(`| ${r.taskId} | ${STATUS_MARK[r.status]} ${r.status} | ${mdCell(digest)} |`);
    }
  }

  // ---- 变更文件汇总(top10 + 计数) ----------------------------
  lines.push('', '## 变更文件');
  const fileMap = new Map<string, ChangedFileAction>();
  for (const r of results) {
    if (r.status === 'failed') continue;
    for (const f of r.changedFiles) fileMap.set(f.path, f.action);
  }
  if (fileMap.size === 0) {
    lines.push('无文件变更。');
  } else {
    const entries = [...fileMap.entries()];
    for (const [file, action] of entries.slice(0, CHANGE_FILE_LIMIT)) {
      lines.push(`- \`${file}\`(${action})`);
    }
    if (fileMap.size > CHANGE_FILE_LIMIT) {
      lines.push(`- ……其余 ${fileMap.size - CHANGE_FILE_LIMIT} 个文件略`);
    }
    lines.push(`**共 ${fileMap.size} 个文件**(展示前 ${Math.min(fileMap.size, CHANGE_FILE_LIMIT)} 个)。`);
  }

  // ---- 风险 ---------------------------------------------------
  lines.push('', '## 风险');
  if (plan.risks.length === 0) {
    lines.push('无已识别风险。');
  } else {
    for (const risk of plan.risks) lines.push(`- ${risk}`);
  }

  // ---- 成员备注精选 -------------------------------------------
  lines.push('', '## 成员备注精选');
  const notes: string[] = [];
  for (const r of results) {
    if (typeof r.error === 'string' && r.error.startsWith('skipped:')) continue;
    for (const n of r.notes) {
      if (!notes.includes(n)) notes.push(n);
    }
  }
  if (notes.length === 0) {
    lines.push('无成员备注。');
  } else {
    for (const n of notes.slice(0, MEMBER_NOTES_LIMIT)) {
      lines.push(`- ${clampLine(n, 200)}`);
    }
  }

  // ---- 结项报告 + 生成声明 ------------------------------------
  lines.push('', '---', '', deliverableSummary.trim() === '' ? '(结项报告为空)' : deliverableSummary);
  lines.push('', '---', '', PR_DISCLAIMER);
  return lines.join('\n');
}
