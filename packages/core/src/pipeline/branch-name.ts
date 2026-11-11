/** 分支命名:任务分支 / 交付分支 / 去重工具(纯函数)。 */

/** 兜底 slug:输入全是非法字符时使用。 */
const FALLBACK_SLUG = 'task';

/**
 * 归一化为分支友好的 slug:小写、非 [a-z0-9] 连续折叠成 '-'、去首尾 '-'。
 * 注意:非 ASCII(如中文)会被折叠掉,退回 FALLBACK_SLUG,避免跨平台
 * ref 编码差异(见完成报告的已知限制)。
 */
export function normalizeTaskId(raw: string): string {
  return slugify(raw);
}

/** slugify 同 normalizeTaskId,供交付分支等复用。 */
export function slugify(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? FALLBACK_SLUG : cleaned;
}

/** 成员任务分支:`<prefix><normalized(task.id)>`。 */
export function taskBranchName(taskId: string, prefix: string): string {
  return `${prefix}${normalizeTaskId(taskId)}`;
}

/** 交付分支:`<prefix>deliver-<slug(task.title)>`。 */
export function deliverBranchName(taskTitle: string, prefix: string): string {
  return `${prefix}deliver-${slugify(taskTitle)}`;
}

/** 返回不在 used 集合中的第一个 base / base-2 / base-3 …。 */
export function uniqueBranchName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
