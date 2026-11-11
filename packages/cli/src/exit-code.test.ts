import { describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_PARTIAL, EXIT_USAGE, mapExitCode, type ExitCode } from './exit-code.js';
import type { TaskStatus } from '@aiwf/core';

const statuses = (...list: TaskStatus[]): { status: TaskStatus }[] => list.map((s) => ({ status: s }));

describe('exit code constants & mapping', () => {
  it('constants keep the documented ordering', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_PARTIAL).toBe(1);
    expect(EXIT_USAGE).toBe(2);
  });

  it('maps statuses to 0 / 1', () => {
    expect(mapExitCode([])).toBe(EXIT_OK as ExitCode);
    expect(mapExitCode(statuses('completed'))).toBe(0);
    expect(mapExitCode(statuses('completed', 'completed'))).toBe(0);
    expect(mapExitCode(statuses('partial'))).toBe(1);
    expect(mapExitCode(statuses('completed', 'failed'))).toBe(1);
    expect(mapExitCode(statuses('failed', 'failed'))).toBe(1);
  });
});
