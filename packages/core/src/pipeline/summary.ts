/** 结项报告(deliverable.summary)构建:纯函数,含状态符号与冲突解析。 */

import type { TaskResult, TaskStatus, WorkflowPlan } from '../contracts/index.js';
import { clampLine, mdCell } from './md.js';

/** ✔ / △ / ✘ 状态符号。 */
export const STATUS_MARK: Record<TaskStatus, string> = {
  completed: '✔',
  partial: '△',
  failed: '✘',
};

/** 一次成员分支合并失败的记录。 */
export interface MergeConflict {
  branch: string;
  /** 承担该分支的任务 ID(可追溯)。 */
  taskId: string | null;
  /** 从 git 错误信息中解析出的冲突文件列表。 */
  files: string[];
  /** 原始错误信息。 */
  message: string;
}

/** 从 merge 错误信息里提取 `Merge conflict in <file>` 行。 */
export function parseConflictFiles(message: string): string[] {
  const files: string[] = [];
  for (const match of message.matchAll(/Merge conflict in\s+(\S+)/g)) {
    const file = match[1];
    if (file !== undefined && !files.includes(file)) {
      files.push(file);
    }
  }
  return files;
}

/** 整体状态:全失败 → failed;有冲突或非完成 → partial;否则 completed。 */
export function overallStatus(
  results: readonly TaskResult[],
  conflicts: readonly MergeConflict[],
): TaskStatus {
  if (results.length === 0 && conflicts.length === 0) return 'completed';
  if (results.length > 0 && results.every((r) => r.status === 'failed')) return 'failed';
  if (conflicts.length > 0) return 'partial';
  if (results.some((r) => r.status !== 'completed')) return 'partial';
  return 'completed';
}

export interface DeliverSummaryInput {
  plan: WorkflowPlan;
  results: readonly TaskResult[];
  conflicts: readonly MergeConflict[];
  dryRun?: boolean;
}

/**
 * 队长的结项报告,包含:整体状态、计划概要、逐任务状态表(✔/△/✘)、
 * 冲突与跳过清单、risks。dryRun 时末尾追加 "(dry-run)" 标记。
 */
export function buildDeliverSummary(input: DeliverSummaryInput): string {
  const { plan, results, conflicts, dryRun = false } = input;
  const counts: Record<TaskStatus, number> = { completed: 0, partial: 0, failed: 0 };
  for (const r of results) counts[r.status] += 1;
  const status = overallStatus(results, conflicts);

  const lines: string[] = ['## 结项报告', ''];
  lines.push(
    `整体状态:**${status}**(成功 ${counts.completed} / 部分 ${counts.partial} / 失败 ${counts.failed} / 合并冲突 ${conflicts.length})`,
  );
  lines.push('', '### 计划概要', plan.summary === '' ? '(计划未提供摘要)' : plan.summary);
  lines.push('', '### 任务状态');
  if (results.length === 0) {
    lines.push('本次运行没有成员任务。');
  } else {
    lines.push('| 任务 | 角色 | 状态 | 摘要 |', '| --- | --- | --- | --- |');
    for (const r of results) {
      const role = plan.tasks.find((t) => t.id === r.taskId)?.role ?? '-';
      const digest = r.error ?? clampLine(r.summary, 200);
      lines.push(`| ${r.taskId} | ${role} | ${STATUS_MARK[r.status]} ${r.status} | ${mdCell(digest)} |`);
    }
  }

  const skipped = results.filter(
    (r) => typeof r.error === 'string' && r.error.startsWith('skipped:'),
  );
  lines.push('', '### 冲突与跳过');
  if (conflicts.length === 0 && skipped.length === 0) {
    lines.push('无合并冲突,无跳过任务。');
  } else {
    for (const c of conflicts) {
      const filePart = c.files.length > 0 ? `,冲突文件:${c.files.join('、')}` : '';
      lines.push(
        `- 合并冲突:\`${c.branch}\`${c.taskId === null ? '' : `(任务 ${c.taskId})`}${filePart} — ${clampLine(c.message, 200)}`,
      );
    }
    for (const s of skipped) {
      lines.push(`- 跳过:${s.taskId} — ${clampLine(s.error ?? '依赖链失败', 200)}`);
    }
  }

  lines.push('', '### 风险');
  if (plan.risks.length === 0) {
    lines.push('无已识别风险。');
  } else {
    for (const risk of plan.risks) lines.push(`- ${risk}`);
  }

  if (dryRun) {
    lines.push('', '> (dry-run) 本次运行为演练模式:未执行成员任务、未创建分支、未发起 Pull Request。');
  }
  return lines.join('\n');
}
