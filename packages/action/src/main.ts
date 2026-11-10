/**
 * @aiwf/action entry. OWNER: M4.
 *
 * REQUIRED INTERFACE (from @aiwf/core):
 *   createWorkflowRunner(config: WorkflowConfig): WorkflowRunner
 *   createEngine(cfg: EngineConfig): Engine
 *   NodeGitOps / buildRepoContext from '@aiwf/core' infra barrel.
 *
 * M4 implements:
 *   1. GitHubPlatformClient (PlatformClient with octokit from @actions/github)
 *   2. inputs parsing (core.getInput) → EngineConfig / WorkflowConfig
 *   3. structured logging via core.* + onEvent sink
 *   4. failure containment: setFailed on fatal, report partials otherwise.
 * Do not edit other areas.
 */
import { runActionStub } from './stub.js';

runActionStub();
