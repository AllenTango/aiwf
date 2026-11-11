/**
 * @aiwf/action — PipelineEvent → @actions/core 输出桥(表驱动测试点)。
 * OWNER: M4.
 *
 * 映射规则:
 *   stage          → core.info(`▶ ${stage}`)
 *   plan           → core.info(JSON 概要:summary + tasks 每行最小要素)
 *   task-dispatch  → core.info(派发与工作分支)
 *   task-result    → completed/ partial/ failed 按级别 info/warning/error
 *   log            → 按事件 level 映射 debug/info/warning/error
 *   deliver        → 输出 pr-url / branch / summary,并打印交付概览
 */
import * as core from '@actions/core';
import type {
  Deliverable,
  LogLevel,
  PipelineEvent,
  TaskResult,
  TaskStatus,
} from '@aiwf/core';
import { STATUS_EMOJI } from './pr-body.js';

/** LogLevel → core.* 方法名(表驱动测试的映射事实源)。 */
export const LOG_LEVEL_TO_CORE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warning' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
};

/** TaskStatus → 建议的日志级别(completed=info / partial=warn / failed=error)。 */
export const TASK_STATUS_TO_LEVEL: Record<TaskStatus, LogLevel> = {
  completed: 'info',
  partial: 'warn',
  failed: 'error',
};

/** 把流水线事件转写为 @actions/core 的日志/输出(纯 switch,无 IO 其他副作用)。 */
export function bridgePipelineEvent(event: PipelineEvent): void {
  switch (event.type) {
    case 'stage':
      core.info(`▶ ${event.stage}`);
      break;
    case 'plan': {
      const overview = {
        summary: event.plan.summary,
        tasks: event.plan.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          role: task.role,
          dependsOn: task.dependsOn,
          expectedOutputs: task.expectedOutputs,
        })),
        risks: event.plan.risks,
      };
      core.info(`🧭 队长规划(JSON 概要):${JSON.stringify(overview)}`);
      break;
    }
    case 'task-dispatch':
      core.info(`⇒ 派发 ${event.taskId} → 工作分支 ${event.branch}`);
      break;
    case 'task-result':
      emitTaskResult(event.result);
      break;
    case 'log':
      emitLog(event.level, event.message);
      break;
    case 'deliver': {
      const pr = event.deliverable.pullRequest;
      core.info(
        `📦 交付就绪:分支 ${event.deliverable.branch || '(暂无分支)'}` +
          (pr === undefined ? ' · 未交付 PR' : ` · PR #${pr.number} ${pr.url}`),
      );
      setDeliverableOutputs(event.deliverable);
      break;
    }
  }
}

/** deliverable → action outputs(pr-url / branch / summary;PR 缺失时不设 pr-url)。 */
export function setDeliverableOutputs(deliverable: Deliverable): void {
  if (deliverable.pullRequest !== undefined) {
    core.setOutput('pr-url', deliverable.pullRequest.url);
  }
  core.setOutput('branch', deliverable.branch);
  core.setOutput('summary', deliverable.summary);
}

function emitTaskResult(result: TaskResult): void {
  const level = TASK_STATUS_TO_LEVEL[result.status];
  let message = `${STATUS_EMOJI[result.status]} [${result.taskId}] ${result.status}: ${result.summary}`;
  if (result.status === 'failed' && typeof result.error === 'string' && result.error !== '') {
    message += ` ← ${result.error}`;
  }
  emitLog(level, message);
}

function emitLog(level: LogLevel, message: string): void {
  switch (LOG_LEVEL_TO_CORE_METHOD[level]) {
    case 'debug':
      core.debug(message);
      break;
    case 'info':
      core.info(message);
      break;
    case 'warning':
      core.warning(message);
      break;
    case 'error':
      core.error(message);
      break;
  }
}
