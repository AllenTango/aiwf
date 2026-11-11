/**
 * @aiwf/core 公共 barrel(由 M1 最终成型)。
 *
 * - contracts:契约唯一事实源(队长所有);
 * - pipeline:五阶段流水线(M1);
 * - engine / infra:M2 交付,导出名以契约为准(createEngine / NodeGitOps / buildRepoContext)。
 */
export * from './contracts/index.js';
export { createWorkflowRunner } from './pipeline/index.js';
export { createEngine } from './engine/index.js';
export { NodeGitOps, buildRepoContext } from './infra/index.js';
