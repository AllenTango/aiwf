import type { TaskStatus } from '@aiwf/core';

export const EXIT_OK = 0;
export const EXIT_PARTIAL = 1;
export const EXIT_USAGE = 2;

export type ExitCode = typeof EXIT_OK | typeof EXIT_PARTIAL | typeof EXIT_USAGE;

/**
 * Pure mapping from member task statuses to the process exit code.
 * - 0: every task completed (or no member ran, e.g. dry-run).
 * - 1: the run finished, but at least one member was failed/partial —
 *      delivery was achieved only partially.
 * - 2 (usage / fatal) is handled by the shell, not derived here.
 */
export function mapExitCode(statuses: readonly { status: TaskStatus }[]): ExitCode {
  if (statuses.length === 0) return EXIT_OK;
  return statuses.every((entry) => entry.status === 'completed') ? EXIT_OK : EXIT_PARTIAL;
}
