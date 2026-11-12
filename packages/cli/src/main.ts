#!/usr/bin/env node
/**
 * aiwf — local CLI entry. OWNER: M3.
 *
 * Commands:
 *   aiwf run …  — run the full Issue→PR pipeline locally against a git repo.
 * Engines: mock (deterministic) | opencode (real model).
 */
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { UsageError } from './errors.js';
import { executeRun } from './run.js';
import type { RunFlagValues } from './run-config.js';

const VERSION = '0.1.0';

const RUN_EXAMPLES = `示例:

  # 1) 一句话诉求 → 先只看队长计划(dry-run,不触碰任何成员/PR)
  $ aiwf run --inline "给 README 增加 Quick Start 段落" --dry-run

  # 2) 从 markdown 任务文件全量执行(mock 引擎,无真实模型调用)
  $ aiwf run --from demo.md --engine mock

  # 3) 真实引擎全量(opencode):显式模型 + 25 分钟超时 + 基线分支
  $ AIWF_MODEL=opencode/glm-5.3-free aiwf run --from task.json \\
      --engine opencode --model opencode/glm-5.3-free \\
      --timeout-ms 1500000 --base-branch main

  # 4) 脚本化:结束后输出机器可读的 RunResult JSON
  $ aiwf run --inline "规范 package.json scripts" --engine mock --json

  # 5) 限额运行:最多 3 个成员任务(也可用环境变量 $AIWF_MAX_TASKS)
  $ AIWF_MAX_TASKS=3 aiwf run --from task.json --engine mock --max-tasks 3

提示:--issue(owner/repo#12)仅 GitHub Action 支持;本地请改用 --from 或 --inline。`;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('aiwf')
    .description(
      'AI 原生研发团队 CLI:队长规划 → 并行队员执行 → 队长合成 → 本地交付/PR。',
    )
    .version(VERSION, '-V, --version', '输出版本号')
    .exitOverride()
    .addHelpText('after', '\n子命令用法与示例:aiwf run --help');

  program
    .command('run')
    .description(
      '在本地 git 仓库上运行完整流水线(任务来源:issue/file/inline 三选一)。',
    )
    .option('--issue <owner/repo#n>', '远程 issue 引用 — 本地 v0.1 不支持,将给出引导信息')
    .option('--from <file.md|file.json>', '任务文件:.md(首行 "# " 为标题,其余为正文)或 .json({title,…})')
    .option('--inline <text>', '一句话诉求')
    .option('--dir <path>', '目标 git 仓库(默认 process.cwd();必须通过 git rev-parse 校验)')
    .option('--engine <opencode|mock>', '引擎类型(默认 $AIWF_ENGINE ?? opencode)')
    .option('--model <provider/model>', '模型,透传给 EngineConfig(默认 $AIWF_MODEL)')
    .option('--max-parallel <n>', '并行队员上限(1~8,默认 4;$AIWF_MAX_PARALLEL)')
    .option('--max-tasks <n>', '单次运行允许的最大成员任务数(1~10,默认 6;$AIWF_MAX_TASKS)')
    .option('--base-branch <name>', 'PR 基线分支提示(默认当前分支;$AIWF_BASE_BRANCH)')
    .option('--branch-prefix <p>', '任务分支前缀(默认 aiwf/;$AIWF_BRANCH_PREFIX)')
    .option('--dry-run', '只输出队长计划,不执行成员、不交付', false)
    .option('--timeout-ms <n>', '引擎单步超时毫秒(60000~3600000,默认 1200000;$AIWF_TIMEOUT_MS)')
    .option(
      '--models <role=model,...>',
      '模型池:队长可为不同队员指派不同模型(如 worker=opencode/glm-5.3;$AIWF_MODELS)',
    )
    .option('--guidelines <text>', '行为准则:每行一条,叠加在内置默认准则之后($AIWF_GUIDELINES)')
    .option('--budget <n>', '相对成本预算上限(low=1/medium=3/high=8 单位;0=不限;$AIWF_BUDGET)')
    .option('--json', '结束后输出 RunResult JSON(脚本化)', false)
    .addHelpText('after', RUN_EXAMPLES)
    .action(async (options: RunFlagValues) => {
      await executeRun(options, process.env);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();

  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help / --version exit with code 0; every other commander failure
      // (unknown option, missing value, invalid argument) is a usage error.
      if (error.exitCode === 0) {
        return;
      }
      console.error(pc.red(pc.bold(`aiwf: ${error.message}`)));
      process.exitCode = 2;
      return;
    }
    if (error instanceof UsageError) {
      console.error(pc.red(pc.bold(`aiwf: ${error.message}`)));
      process.exitCode = 2;
      return;
    }
    const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(pc.red(`aiwf: 发生致命错误 →\n${details}`));
    process.exitCode = 2;
  }
}

await main();
