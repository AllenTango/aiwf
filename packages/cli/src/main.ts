#!/usr/bin/env node
/**
 * @aiwf/cli entry. OWNER: M3.
 *
 * REQUIRED INTERFACE (from @aiwf/core):
 *   createWorkflowRunner(config: WorkflowConfig): WorkflowRunner
 *   createEngine(cfg: EngineConfig): Engine
 *   NodeGitOps  — GitOps impl
 *   buildRepoContext(rootDir) — RepoContext builder
 *
 * M3 defines the `WorkflowConfig` assembly (engine + local PlatformClient +
 * GitOps + logger/console event sink) and the CLI UX. Do not edit other areas.
 */
import { defineArgsAndRunStubs } from './stub.js';

defineArgsAndRunStubs(process.argv);
