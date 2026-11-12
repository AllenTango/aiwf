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
  WorkflowPlan,
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

/**
 * 对流水线事件里的字符串字段做脱敏(事件类型不变)。
 *
 * 背景:core 的 runner 已经会脱敏它发出的文本,但 action 侧仍保留一道防线——
 * 将来 core 若新增事件或漏改某个字段,这里能兜住「密钥进 PR 正文」的风险
 * (GitHub 不对 PR 正文做 secret 掩码)。
 *
 * 覆盖:
 *   - plan:summary / tasks[].title / tasks[].instructions / risks
 *   - task-result:summary / notes / error
 *   - log:message
 *   - deliver:deliverable.summary / deliverable.plan / deliverable.taskResults
 */
export function redactPipelineEvent(
  event: PipelineEvent,
  redact: (text: string) => string,
): PipelineEvent {
  switch (event.type) {
    case 'plan':
      return {
        ...event,
        plan: {
          ...event.plan,
          summary: redact(event.plan.summary),
          risks: event.plan.risks.map((risk) => redact(risk)),
          tasks: event.plan.tasks.map((task) => ({
            ...task,
            title: redact(task.title),
            instructions: redact(task.instructions),
          })),
        },
      };
    case 'task-result':
      return {
        ...event,
        result: redactTaskResult(event.result, redact),
      };
    case 'log':
      return { ...event, message: redact(event.message) };
    case 'deliver':
      return {
        ...event,
        deliverable: {
          ...event.deliverable,
          summary: redact(event.deliverable.summary),
          plan: redactPlan(event.deliverable.plan, redact),
          taskResults: event.deliverable.taskResults.map((result) => redactTaskResult(result, redact)),
        },
      };
    case 'stage':
    case 'task-dispatch':
      return event;
  }
}

/** 计划整体脱敏(交付物内嵌的 plan)。 */
function redactPlan(plan: WorkflowPlan, redact: (text: string) => string): WorkflowPlan {
  return {
    ...plan,
    summary: redact(plan.summary),
    risks: plan.risks.map((risk) => redact(risk)),
    tasks: plan.tasks.map((task) => ({
      ...task,
      title: redact(task.title),
      instructions: redact(task.instructions),
    })),
  };
}

/** 成员结果脱敏(交付物内嵌的 taskResults)。 */
function redactTaskResult(result: TaskResult, redact: (text: string) => string): TaskResult {
  return {
    ...result,
    summary: redact(result.summary),
    notes: result.notes.map((note) => redact(note)),
    ...(result.error === undefined ? {} : { error: redact(result.error) }),
    changedFiles: result.changedFiles.map((file) => ({
      ...file,
      ...(file.content === undefined ? {} : { content: redact(file.content) }),
    })),
  };
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
