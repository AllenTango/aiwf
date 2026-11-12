/**
 * @aiwf/action — 事件 → @actions/core 输出级别映射(表驱动,对 core.* 打桩)。OWNER: M4.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { debug, error, info, setOutput, warning } from '@actions/core';
import type { Deliverable, LogLevel, PipelineEvent, TaskResult, WorkflowPlan } from '@aiwf/core';
import {
  bridgePipelineEvent,
  LOG_LEVEL_TO_CORE_METHOD,
  redactPipelineEvent,
  setDeliverableOutputs,
  TASK_STATUS_TO_LEVEL,
} from './event-bridge.js';

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setOutput: vi.fn(),
}));

const logMocks: Record<'debug' | 'info' | 'warning' | 'error', Mock> = {
  debug: vi.mocked(debug),
  info: vi.mocked(info),
  warning: vi.mocked(warning),
  error: vi.mocked(error),
};
const setOutputMock = vi.mocked(setOutput);

beforeEach(() => {
  vi.clearAllMocks();
});

const basePlan: WorkflowPlan = {
  summary: '一条主支线,一位实现者',
  tasks: [
    {
      id: 't1',
      title: '核心实现',
      role: 'implementer',
      instructions: '……',
      dependsOn: [],
      expectedOutputs: ['src/**'],
    },
    {
      id: 't2',
      title: '文档补齐',
      role: 'packager',
      instructions: '……',
      dependsOn: ['t1'],
      expectedOutputs: ['docs/**'],
    },
  ],
  risks: ['API 变更可能破坏现有调用方'],
};

function makeTaskResult(status: TaskResult['status']): TaskResult {
  return {
    taskId: 't1',
    status,
    summary: '完成了单元功能',
    changedFiles: [],
    notes: [],
    ...(status === 'failed' ? { error: 'boom: engine died' } : {}),
  };
}

describe('级别映射契约表', () => {
  it('LOG_LEVEL_TO_CORE_METHOD:debug/info/warn/error → debug/info/warning/error', () => {
    expect(LOG_LEVEL_TO_CORE_METHOD).toEqual({
      debug: 'debug',
      info: 'info',
      warn: 'warning',
      error: 'error',
    });
  });

  it('TASK_STATUS_TO_LEVEL:completed=info / partial=warn / failed=error', () => {
    expect(TASK_STATUS_TO_LEVEL).toEqual({ completed: 'info', partial: 'warn', failed: 'error' });
  });
});

describe('log 事件(level → core 方法,表驱动)', () => {
  it.each([
    ['debug', 'debug'],
    ['info', 'info'],
    ['warn', 'warning'],
    ['error', 'error'],
  ] as const)('level=%s → core.%s(其余方法零调用)', (level, method) => {
    const event: PipelineEvent = { type: 'log', level: level as LogLevel, message: '成员日志', at: 1 };
    bridgePipelineEvent(event);

    expect(logMocks[method]).toHaveBeenCalledWith('成员日志');
    for (const [otherMethod, mockMethod] of Object.entries(logMocks)) {
      if (otherMethod !== method) {
        expect(mockMethod).not.toHaveBeenCalled();
      }
    }
  });
});

describe('task-result 事件(状态 → 级别,表驱动)', () => {
  it.each([
    ['completed', 'info', '✔'],
    ['partial', 'warning', '△'],
    ['failed', 'error', '✘'],
  ] as const)('status=%s → core.%s 且含状态标记 %s', (status, method, mark) => {
    bridgePipelineEvent({ type: 'task-result', result: makeTaskResult(status), at: 2 });

    expect(logMocks[method]).toHaveBeenCalledWith(expect.stringContaining(mark));
    expect(logMocks[method]).toHaveBeenCalledWith(expect.stringContaining('[t1]'));
    // 其他级别不得收到该结果
    for (const [otherMethod, mockMethod] of Object.entries(logMocks)) {
      if (otherMethod !== method) {
        expect(mockMethod).not.toHaveBeenCalled();
      }
    }
  });

  it('failed 的 error 详情随日志透出', () => {
    bridgePipelineEvent({ type: 'task-result', result: makeTaskResult('failed'), at: 3 });
    expect(logMocks.error).toHaveBeenCalledWith(expect.stringContaining('boom: engine died'));
  });
});

describe('stage / plan / task-dispatch / deliver 事件', () => {
  it('stage → core.info(`▶ ${stage}`)', () => {
    bridgePipelineEvent({ type: 'stage', stage: 'plan', at: 4 });
    expect(logMocks.info).toHaveBeenCalledWith('▶ plan');
  });

  it('plan → 一条 info(JSON 概要),含 summary 与每个任务行要素', () => {
    bridgePipelineEvent({ type: 'plan', plan: basePlan, at: 5 });
    expect(logMocks.info).toHaveBeenCalledTimes(1);
    const message = logMocks.info.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('一条主支线,一位实现者');
    expect(message).toContain('t1');
    expect(message).toContain('核心实现');
    expect(message).toContain('t2');
    expect(message).toContain('packager');
  });

  it('task-dispatch → info 含 taskId 与分支', () => {
    bridgePipelineEvent({ type: 'task-dispatch', taskId: 't1', branch: 'aiwf/issue-7/t1', at: 6 });
    expect(logMocks.info).toHaveBeenCalledWith(expect.stringContaining('t1'));
    expect(logMocks.info).toHaveBeenCalledWith(expect.stringContaining('aiwf/issue-7/t1'));
  });

  it('deliver → 设置 outputs(pr-url/branch/summary)并打印概览', () => {
    const deliverable: Deliverable = {
      branch: 'aiwf/issue-7',
      summary: '已合成结果',
      plan: basePlan,
      taskResults: [makeTaskResult('completed')],
      pullRequest: { number: 12, url: 'https://github.com/acme/team/pull/12' },
    };
    bridgePipelineEvent({ type: 'deliver', deliverable, at: 7 });

    expect(setOutputMock).toHaveBeenCalledWith('pr-url', 'https://github.com/acme/team/pull/12');
    expect(setOutputMock).toHaveBeenCalledWith('branch', 'aiwf/issue-7');
    expect(setOutputMock).toHaveBeenCalledWith('summary', '已合成结果');
    expect(logMocks.info).toHaveBeenCalledWith(expect.stringContaining('PR #12'));
  });

  it('deliver(无 PR)→ 打印提示且不设置 pr-url', () => {
    const deliverable: Deliverable = {
      branch: '',
      summary: '仅计划',
      plan: basePlan,
      taskResults: [],
      pullRequest: undefined,
    };
    bridgePipelineEvent({ type: 'deliver', deliverable, at: 8 });

    const prCalls = setOutputMock.mock.calls.filter((call) => call[0] === 'pr-url');
    expect(prCalls).toHaveLength(0);
    expect(setOutputMock).toHaveBeenCalledWith('branch', '');
    expect(setOutputMock).toHaveBeenCalledWith('summary', '仅计划');
    expect(logMocks.info).toHaveBeenCalledWith(expect.stringContaining('未交付 PR'));
  });
});

describe('setDeliverableOutputs(直接调用)', () => {
  it('有 PR 时三输出齐备', () => {
    setDeliverableOutputs({
      branch: 'aiwf/issue-3',
      summary: 's',
      plan: basePlan,
      taskResults: [],
      pullRequest: { number: 1, url: 'u' },
    });
    expect(setOutputMock).toHaveBeenCalledWith('pr-url', 'u');
    expect(setOutputMock).toHaveBeenCalledWith('branch', 'aiwf/issue-3');
    expect(setOutputMock).toHaveBeenCalledWith('summary', 's');
  });

  it('无 PR 时跳过 pr-url,但仍输出 branch/summary', () => {
    setDeliverableOutputs({ branch: 'b', summary: 's', plan: basePlan, taskResults: [] });
    expect(setOutputMock).not.toHaveBeenCalledWith('pr-url', expect.anything());
    expect(setOutputMock).toHaveBeenCalledWith('branch', 'b');
    expect(setOutputMock).toHaveBeenCalledWith('summary', 's');
  });
});

describe('redactPipelineEvent(四类事件脱敏,事件类型不变)', () => {
  const SECRET = 'sk-abcdefghijklmnopqrstuvwx';
  const PLACEHOLDER = '***REDACTED***';
  const redact = (text: string): string => text.split(SECRET).join(PLACEHOLDER);

  it('log 事件:message 被替换,类型不变', () => {
    const event: PipelineEvent = {
      type: 'log',
      level: 'info',
      message: `key=${SECRET}`,
      at: 1,
    };
    const out = redactPipelineEvent(event, redact);
    expect(out.type).toBe('log');
    expect(out.type === 'log' ? out.message : '').toBe(`key=${PLACEHOLDER}`);
    expect(out.type === 'log' ? out.message : '').not.toContain(SECRET);
  });

  it('plan 事件:summary/tasks[].title/instructions/risks 全部脱敏,类型不变', () => {
    const plan: WorkflowPlan = {
      summary: `概览 ${SECRET}`,
      tasks: [
        {
          id: 't1',
          title: `实现 ${SECRET}`,
          role: 'implementer',
          instructions: `请使用 ${SECRET}`,
          dependsOn: [],
          expectedOutputs: ['src/**'],
        },
      ],
      risks: [`风险 ${SECRET}`],
    };
    const out = redactPipelineEvent({ type: 'plan', plan, at: 2 }, redact);
    expect(out.type).toBe('plan');
    if (out.type !== 'plan') return;
    expect(out.plan.summary).toBe(`概览 ${PLACEHOLDER}`);
    expect(out.plan.tasks[0]?.title).toBe(`实现 ${PLACEHOLDER}`);
    expect(out.plan.tasks[0]?.instructions).toBe(`请使用 ${PLACEHOLDER}`);
    expect(out.plan.risks[0]).toBe(`风险 ${PLACEHOLDER}`);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('task-result 事件:summary/notes/error 全部脱敏,类型不变', () => {
    const result: TaskResult = {
      taskId: 't1',
      status: 'failed',
      summary: `完成 ${SECRET}`,
      changedFiles: [],
      notes: [`备注 ${SECRET}`],
      error: `boom ${SECRET}`,
    };
    const out = redactPipelineEvent({ type: 'task-result', result, at: 3 }, redact);
    expect(out.type).toBe('task-result');
    if (out.type !== 'task-result') return;
    expect(out.result.summary).toBe(`完成 ${PLACEHOLDER}`);
    expect(out.result.notes[0]).toBe(`备注 ${PLACEHOLDER}`);
    expect(out.result.error).toBe(`boom ${PLACEHOLDER}`);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('deliver 事件:summary/plan/taskResults 全部脱敏,类型不变', () => {
    const deliverable: Deliverable = {
      branch: 'aiwf/issue-7',
      summary: `结项 ${SECRET}`,
      plan: {
        summary: `概览 ${SECRET}`,
        tasks: [
          {
            id: 't1',
            title: `实现 ${SECRET}`,
            role: 'implementer',
            instructions: `请使用 ${SECRET}`,
            dependsOn: [],
            expectedOutputs: ['src/**'],
          },
        ],
        risks: [`风险 ${SECRET}`],
      },
      taskResults: [
        {
          taskId: 't1',
          status: 'completed',
          summary: `完成 ${SECRET}`,
          changedFiles: [],
          notes: [`备注 ${SECRET}`],
        },
      ],
      pullRequest: { number: 12, url: 'https://github.com/acme/team/pull/12' },
    };
    const out = redactPipelineEvent({ type: 'deliver', deliverable, at: 4 }, redact);
    expect(out.type).toBe('deliver');
    if (out.type !== 'deliver') return;
    expect(out.deliverable.summary).toBe(`结项 ${PLACEHOLDER}`);
    expect(out.deliverable.plan.summary).toBe(`概览 ${PLACEHOLDER}`);
    expect(out.deliverable.plan.tasks[0]?.title).toBe(`实现 ${PLACEHOLDER}`);
    expect(out.deliverable.taskResults[0]?.summary).toBe(`完成 ${PLACEHOLDER}`);
    expect(out.deliverable.taskResults[0]?.notes[0]).toBe(`备注 ${PLACEHOLDER}`);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // 非文本字段保持原样
    expect(out.deliverable.branch).toBe('aiwf/issue-7');
    expect(out.deliverable.pullRequest?.url).toBe('https://github.com/acme/team/pull/12');
  });

  it('stage / task-dispatch 事件原样返回(类型不变)', () => {
    const stage = redactPipelineEvent({ type: 'stage', stage: 'plan', at: 5 }, redact);
    expect(stage.type).toBe('stage');
    const dispatch = redactPipelineEvent(
      { type: 'task-dispatch', taskId: 't1', branch: 'aiwf/x', at: 6 },
      redact,
    );
    expect(dispatch.type).toBe('task-dispatch');
  });

  it('脱敏不改变事件的其他字段(at/level/id 等)', () => {
    const out = redactPipelineEvent(
      { type: 'log', level: 'warn', message: SECRET, at: 99 },
      redact,
    );
    expect(out.type === 'log' ? out.level : '').toBe('warn');
    expect(out.at).toBe(99);
  });
});
