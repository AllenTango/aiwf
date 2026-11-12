import pc from 'picocolors';
import type {
  PipelineEvent,
  PipelineStage,
  Redactor,
  RunResult,
  TaskResult,
  WorkflowPlan,
} from '@aiwf/core';
import type { LogLevel } from '@aiwf/core';

// ---------------------------------------------------------------------------
// Palette — pass `plainPalette` in tests for deterministic snapshots.
// ---------------------------------------------------------------------------

export type ColorFn = (text: string) => string;

export interface Palette {
  bold: ColorFn;
  dim: ColorFn;
  green: ColorFn;
  yellow: ColorFn;
  red: ColorFn;
  cyan: ColorFn;
  magenta: ColorFn;
  gray: ColorFn;
}

const identity: ColorFn = (text) => text;

/** 缺省脱敏器:恒等(向后兼容:不传 redact 时输出与历史完全一致)。 */
const identityRedactor: Redactor = (text) => text;

/** 对一组渲染行逐行脱敏(可选)。 */
function redactLines(lines: string[], redact?: Redactor): string[] {
  if (typeof redact !== 'function') return lines;
  return lines.map((line) => redact(line));
}

export const plainPalette: Palette = {
  bold: identity,
  dim: identity,
  green: identity,
  yellow: identity,
  red: identity,
  cyan: identity,
  magenta: identity,
  gray: identity,
};

// ---------------------------------------------------------------------------
// Stage banners — five-phase progress line: [1/5 ingest] …
// ---------------------------------------------------------------------------

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'ingest',
  'plan',
  'dispatch',
  'synthesize',
  'deliver',
];

export function renderStageBanner(stage: PipelineStage, p: Palette = pc): string {
  const total = PIPELINE_STAGES.length;
  const index = PIPELINE_STAGES.indexOf(stage);
  const step = (index >= 0 ? index : 0) + 1;
  return p.bold(p.cyan(`[${step}/${total} ${stage}]`));
}

// ---------------------------------------------------------------------------
// Plan rendering — tree indented by dependency depth, with role,
// expectedOutputs, dependsOn and risks.
// ---------------------------------------------------------------------------

/** Dependency depth of a task (0 = no deps). Cycle-safe and memoized. */
export function depthOfTask(plan: WorkflowPlan, taskId: string): number {
  const byId = new Map<string, WorkflowPlan['tasks'][number]>();
  for (const task of plan.tasks) byId.set(task.id, task);
  const memo = new Map<string, number>();

  const resolve = (tid: string, path: Set<string>): number => {
    const cached = memo.get(tid);
    if (cached !== undefined) return cached;
    if (path.has(tid)) return 0; // cycle guard
    const task = byId.get(tid);
    if (!task) {
      memo.set(tid, 0);
      return 0;
    }
    path.add(tid);
    let depth = 0;
    for (const dep of task.dependsOn) {
      const candidate = resolve(dep, path) + 1;
      if (candidate > depth) depth = candidate;
    }
    path.delete(tid);
    memo.set(tid, depth);
    return depth;
  };

  return resolve(taskId, new Set());
}

export function renderPlan(
  plan: WorkflowPlan,
  p: Palette = pc,
  redact: Redactor = identityRedactor,
): string[] {
  const lines: string[] = [];
  lines.push(p.bold(p.magenta('▶ 队长计划')));
  lines.push(p.dim(`  ${plan.summary}`));
  lines.push('');
  for (const task of plan.tasks) {
    const pad = '  '.repeat(depthOfTask(plan, task.id));
    const deps = task.dependsOn.length > 0 ? p.dim(` (依赖 ${task.dependsOn.join(', ')})`) : '';
    lines.push(`${pad}● ${p.bold(task.id)} · ${task.title}${deps}`);
    lines.push(`${pad}  ${p.magenta(`[role: ${task.role}]`)}`);
    if (task.expectedOutputs.length > 0) {
      lines.push(`${pad}  ${p.gray(`outputs: ${task.expectedOutputs.join(', ')}`)}`);
    }
  }
  if (plan.risks.length > 0) {
    lines.push('');
    lines.push(p.yellow('⚠ 队长风险提示'));
    for (const risk of plan.risks) lines.push(p.yellow(`  - ${risk}`));
  }
  return redactLines(lines, redact);
}

// ---------------------------------------------------------------------------
// Task results / log lines — ✔ green, △ yellow, ✘ red.
// ---------------------------------------------------------------------------

export function taskMark(
  status: TaskResult['status'],
  p: Palette = pc,
): string {
  if (status === 'completed') return p.green('✔');
  if (status === 'partial') return p.yellow('△');
  return p.red('✘');
}

export function renderTaskResult(
  result: TaskResult,
  p: Palette = pc,
  redact: Redactor = identityRedactor,
): string {
  const head = `${taskMark(result.status, p)} ${p.bold(result.taskId)} — ${result.summary}`;
  if (result.status === 'failed' && result.error) {
    return redact(`${head}  ${p.red(`↳ error: ${result.error}`)}`);
  }
  return redact(head);
}

export function renderLogLine(
  level: LogLevel,
  message: string,
  p: Palette = pc,
  redact: Redactor = identityRedactor,
): string {
  if (level === 'error') return p.red(`[error] ${redact(message)}`);
  if (level === 'warn') return p.yellow(`[warn] ${redact(message)}`);
  if (level === 'debug') return p.gray(`[debug] ${redact(message)}`);
  return redact(message);
}

// ---------------------------------------------------------------------------
// Event-driven renderer: every PipelineEvent maps to console lines.
// ---------------------------------------------------------------------------

export function renderEvent(
  event: PipelineEvent,
  p: Palette = pc,
  redact: Redactor = identityRedactor,
): string[] {
  switch (event.type) {
    case 'stage':
      return [renderStageBanner(event.stage, p)];
    case 'plan':
      return renderPlan(event.plan, p, redact);
    case 'task-dispatch':
      return [
        `${p.cyan('→')} ${p.bold(`分派 ${event.taskId}`)} ${p.dim(`→ 分支 ${event.branch}`)}`,
      ];
    case 'task-result':
      return [renderTaskResult(event.result, p, redact)];
    case 'log':
      return [renderLogLine(event.level, event.message, p, redact)];
    case 'deliver': {
      const pr = event.deliverable.pullRequest;
      const prText =
        pr && pr.number >= 0 ? p.magenta(` → PR #${pr.number} ${pr.url}`) : p.gray(' → 本地交付');
      return [`${p.cyan('→')} ${p.bold(`交付 ${event.deliverable.branch}`)}${prText}`];
    }
  }
}

// ---------------------------------------------------------------------------
// Final closing report box — ✅ success / ⚠️ partial / ❌ all failed.
// ---------------------------------------------------------------------------

export function summarizeStatus(
  results: readonly TaskResult[],
): { icon: string; label: string } {
  if (results.length === 0) return { icon: '✅', label: 'dry-run · 仅产出计划,未执行成员' };
  if (results.every((r) => r.status === 'completed')) return { icon: '✅', label: '成功(全部成员完成)' };
  if (results.every((r) => r.status === 'failed')) return { icon: '❌', label: '全部成员失败' };
  return { icon: '⚠️', label: 'partial · 部分交付(存在 failed/partial 成员)' };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderFinalReport(
  run: RunResult,
  opts: { notes?: readonly string[] } = {},
  p: Palette = pc,
  redact: Redactor = identityRedactor,
): string {
  const deliverable = run.deliverable;
  const status = summarizeStatus(deliverable.taskResults);
  const inner: string[] = [];

  inner.push(p.bold(`${status.icon} ${status.label}`));
  inner.push(`分支 : ${deliverable.branch}`);

  const pr = deliverable.pullRequest;
  if (pr && pr.number >= 0) {
    inner.push(p.green(`交付 : PR #${pr.number}\n       ${pr.url}`));
  } else {
    inner.push(p.gray('交付 : 本地交付(未自动创建 PR,详见上方指引)'));
  }

  inner.push(`耗时 : ${formatDuration(run.durationMs)}`);

  const stages = run.stageHistory.map((entry) => entry.stage).join(' → ');
  inner.push(`阶段 : ${stages.length > 0 ? stages : '(空)'}`);
  inner.push('');

  inner.push(p.bold('成员结果'));
  if (deliverable.taskResults.length === 0) {
    inner.push(p.gray('  (无 — dry-run 或计划为空)'));
  }
  for (const result of deliverable.taskResults) {
    inner.push(`  ${renderTaskResult(result, p, redact)}`);
  }

  if (opts.notes && opts.notes.length > 0) {
    inner.push('');
    inner.push(p.bold('备注'));
    for (const note of opts.notes) inner.push(p.gray(`  - ${note}`));
  }

  if (deliverable.plan.risks.length > 0) {
    inner.push('');
    inner.push(p.yellow('未决风险'));
    for (const risk of deliverable.plan.risks) inner.push(p.yellow(`  - ${risk}`));
  }

  // 脱敏在计算框宽之前逐行执行:占位符长度可能与原文不同,需按脱敏后的文本量宽。
  const scrubbed = redactLines(inner, redact);
  const width = Math.max(48, ...scrubbed.map((l) => stripAnsi(l).length + 4));
  const top = `┌─ 结项报告 ${'─'.repeat(Math.max(2, width - '┌─ 结项报告 '.length - 1))}`;
  const bottom = `└${'─'.repeat(Math.max(2, width - 1))}`;
  const body = scrubbed.map((l) => `│ ${l}`).join('\n');
  return [top, body, bottom].join('\n');
}

/** Best-effort ANSI strip for box-width computation (tests + terminals). */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}
