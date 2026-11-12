/**
 * engine/opencode — `Engine` 的真实实现:调用 opencode CLI(实测 v2.2.6)。
 *
 * 联调确认过的 CLI 面(见收尾报告):
 *   opencode run [--model <provider/model>] [--agent <name>] [--auto] [--format default|json] [<message...>]
 * - stdout 仅助手回复文本;横幅/日志走 stderr → 解析只看 stdout。
 * - `--agent plan` 为内置只读规划 agent;`--auto` 放行权限,支撑无人值守写文件。
 * - npm 分布在 Windows 上经 cmd/ps1 shim 调用;本模块优先解析出原生 opencode.exe 直接
 *   spawn(无需 shell),失败再回退 shell 模式(cmd shim)。
 *
 * 纯逻辑(buildPlanPrompt/buildTaskPrompt/parsePlanJson/parseAiwfResultMark)为独立导
 * 出函数,便于离线单测;类内部只承载 spawn。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { collectChangedFiles } from '../infra/git-ops.js';
import type {
  Engine, EngineConfig, MemberContext, PlanRequest, TaskResult,
  TaskStatus, WorkflowPlan,
} from '../contracts/index.js';

export const AIWF_RESULT_PREFIX = 'AIWF_RESULT:';
export const DEFAULT_OPENCODE_TIMEOUT_MS = 20 * 60 * 1000;

/** opencode 结果标记的解析结果。 */
export interface AiwfResultMark {
  status: TaskStatus;
  summary: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// 纯逻辑:prompt 组装
// ---------------------------------------------------------------------------

/** 队长(plan)的完整提示词:工程语境 + 仓库树 + 需求 + 严格输出契约。 */
export function buildPlanPrompt(req: PlanRequest): string {
  const t = req.task;
  const parts: string[] = [];

  parts.push('# 任务');
  parts.push('你是 AI 原生研发团队的"队长"(captain)。不直接写代码;你的产出是把下面的需求拆解成一组可指派给并行队友的任务计划。');

  parts.push('# 仓库快照');
  parts.push(`- 仓库根目录: ${req.repo.rootDir}`);
  parts.push(`- 基分支: ${req.repo.branch}`);
  parts.push('## 文件树(缩进树,目录以 "/" 结尾)');
  parts.push(req.repo.treePreview);
  if (req.repo.keyFiles.length > 0) {
    parts.push('## 关键文件摘要');
    for (const f of req.repo.keyFiles) {
      parts.push(`### ${f.path}`);
      parts.push('```');
      parts.push(f.content);
      parts.push('```');
    }
  }

  parts.push('# 待办需求');
  parts.push(`标题: ${t.title}`);
  parts.push('正文:');
  parts.push(t.body);
  if (t.comments?.length) {
    parts.push('补充评论:');
    for (const c of t.comments) parts.push(`- ${c}`);
  }
  if (t.ref) parts.push(`参考: ${t.ref}`);
  if (req.request) parts.push(`队长附加要求: ${req.request}`);

  parts.push('# 拆解要求');
  parts.push('- 拆成 2~5 个任务;每个任务彼此尽量独立、可在独立 git worktree 内并行完成。');
  parts.push('- task.id 用短小稳定标识(如 t1、t2、implement-core),后续引用必须一致。');
  parts.push('- dependsOn 引用"此列表内其它任务的 id"形成 DAG;允许并行就不要人为串行,最终收尾/打包类任务再依赖实现类任务。');
  parts.push('- task.instructions 必须自包含:成员看不到需求原文和本对话,只能看到 instructions,请把上下文、验收标准完整写清(中文)。');
  parts.push('- task.role 是成员角色(如 implementer / reviewer / packager);expectedOutputs 为该任务预期产出文件的相对路径数组。');
  parts.push('- risks 列出执行风险与需要人工注意的事项。');

  parts.push('# 输出格式(严格遵守)');
  parts.push('仅输出一段 JSON(可用 ```json 代码围栏),JSON 之外不得有任何说明文字。');
  parts.push('结构:');
  parts.push('{');
  parts.push('  "summary": "整体计划的一句中文摘要",');
  parts.push('  "tasks": [');
  parts.push('    {');
  parts.push('      "id": "t1",');
  parts.push('      "title": "任务标题(中文)",');
  parts.push('      "role": "implementer",');
  parts.push('      "instructions": "自包含的完整执行指令(中文)",');
  parts.push('      "dependsOn": [],');
  parts.push('      "expectedOutputs": ["相对路径"]');
  parts.push('    }');
  parts.push('  ],');
  parts.push('  "risks": ["风险描述"]');
  parts.push('}');

  return parts.join('\n');
}

/** 成员(executeTask)的完整提示词:角色 + 指令 + 树 + 约束 + 结果标记收尾。 */
export function buildTaskPrompt(ctx: MemberContext): string {
  const { task, plan, repo } = ctx;
  const parts: string[] = [];

  parts.push('# 角色');
  parts.push(`你是 AI 原生研发团队的成员(member),角色: ${task.role};你负责且仅负责一个任务。`);

  parts.push('# 目标任务');
  parts.push(`任务 id: ${task.id}`);
  parts.push(`标题: ${task.title}`);
  parts.push('执行指令(必须完整遵守):');
  parts.push(task.instructions);

  parts.push('# 计划背景');
  parts.push(`整体计划摘要: ${plan.summary}`);
  if (task.dependsOn.length > 0) {
    parts.push(`前置任务(已先行完成并合入): ${task.dependsOn.join(', ')}`);
  }

  parts.push('# 仓库文件树(仅作参考,基于当前 worktree)');
  parts.push(repo.treePreview);

  parts.push('# 执行约束');
  parts.push('- 只在与本任务相关的文件/目录动手;改动最小而聚焦。');
  const expects = task.expectedOutputs.length > 0 ? task.expectedOutputs.join(', ') : '(未特别指定)';
  parts.push(`- 预期产出文件: ${expects}`);
  parts.push('- 不要改动 .git 及其内容;不要执行任何 git 提交/合并/推送/创建 worktree(版本控制由上游统一处理)。');
  parts.push('- 不要安装依赖;不要重构无关代码。');
  parts.push('- 工作目录就是你的独立 worktree,直接在其中创建/修改文件。');

  parts.push('# 收尾要求(必须执行)');
  parts.push('任务结束时,输出的最后一行必须是单独一行的结果标记,格式:');
  parts.push(`${AIWF_RESULT_PREFIX} {"status":"completed|partial|failed","summary":"一行中文摘要","notes":["可选备注"]}`);
  parts.push('- completed: 全部完成;partial: 部分完成(说明缺什么);failed: 无法完成(说明原因)。');
  parts.push('- 该标记行之后不要再输出任何内容。');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 纯逻辑:解析
// ---------------------------------------------------------------------------

/** 从模型输出中取出疑似 JSON 的文本:优先代码围栏,否则取首个 '{' 到最后一个 '}'。 */
function extractJsonCandidate(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}

function failParse(text: string, reason: string): never {
  const head = text.trim().slice(0, 200);
  throw new Error(`AIWF(opencode): 解析 plan JSON 失败——${reason}。原文本前 200 字: ${head}`);
}

/** 解析队长输出的 WorkflowPlan;必填缺失/非法 → 描述性中文错误。 */
export function parsePlanJson(text: string): WorkflowPlan {
  if (!text || !text.trim()) failParse(text ?? '', '输出为空');
  const candidate = extractJsonCandidate(text);
  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch (e) {
    failParse(text, `候选 JSON 不是合法 JSON(${e instanceof Error ? e.message : String(e)})`);
  }
  const obj = asRecord(data);
  if (!obj) failParse(text, 'JSON 顶层不是对象');

  const summary = requireNonEmptyString(obj.summary, 'summary') ?? failParse(text, '顶层缺少必填字段 summary');
  const rawTasks = obj.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) failParse(text, '顶层缺少必填字段 tasks(至少 1 个任务)');

  const tasks = rawTasks.map((raw, i) => {
    const t = asRecord(raw);
    if (!t) failParse(text, `tasks[${i}] 不是对象`);
    const id = requireNonEmptyString(t.id, `tasks[${i}].id`) ?? failParse(text, `tasks[${i}].id 缺失或非字符串`);
    const title = requireNonEmptyString(t.title, `tasks[${i}].title`) ?? failParse(text, `tasks[${i}].title 缺失`);
    const instructions = requireNonEmptyString(t.instructions, `tasks[${i}].instructions`) ?? failParse(text, `tasks[${i}].instructions 缺失`);
    const role = requireNonEmptyString(t.role, `tasks[${i}].role`) ?? 'implementer';
    const dependsOn = strArray(t.dependsOn, `tasks[${i}].dependsOn`);
    const expectedOutputs = strArray(t.expectedOutputs, `tasks[${i}].expectedOutputs`);
    return { id, title, role, instructions, dependsOn, expectedOutputs };
  });

  const risks = strArray(obj.risks, 'risks');
  return { summary, tasks, risks };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function requireNonEmptyString(v: unknown, field: string): string | null {
  if (typeof v === 'string' && v.trim()) return v;
  return null;
}

function strArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`AIWF(opencode): 解析 plan JSON 失败——字段 ${field} 应为数组`);
  return v.filter((x): x is string => typeof x === 'string');
}

/** 解析成员输出的 `AIWF_RESULT: {...}` 标记;缺失/非法 → null。 */
export function parseAiwfResultMark(text: string): AiwfResultMark | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trim() ?? '';
    if (!trimmed.startsWith(AIWF_RESULT_PREFIX)) continue;
    const payload = trimmed.slice(AIWF_RESULT_PREFIX.length).trim();
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
    const obj = asRecord(data);
    if (!obj) return null;
    const status = obj.status;
    if (status !== 'completed' && status !== 'partial' && status !== 'failed') return null;
    const summary = typeof obj.summary === 'string' ? obj.summary : '';
    let notes: string[] = [];
    if (Array.isArray(obj.notes)) notes = obj.notes.filter((n): n is string => typeof n === 'string');
    return { status, summary, notes };
  }
  return null;
}

/** 压缩成一行的中文摘要(供 TaskResult.summary)。 */
function toOneLine(text: string, max = 240): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : (one || '(无输出)');
}

// ---------------------------------------------------------------------------
// spawn:寻找原生 exe / cmd shim
// ---------------------------------------------------------------------------

interface Invocation {
  /** 可执行文件路径(shell=false 时为真实 exe;shell=true 时为待引用的命令串头)。 */
  file: string;
  /** true → 走 cmd.exe shellJoin;false → 直接 spawn(argv 逐个传)。 */
  shell: boolean;
  /** 描述性说明(错误信息/注释用)。 */
  note: string;
}

const invocationCache = new Map<string, Invocation>();

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 从 npm shim(cmd/ps1)内容里解析出真实 exe 路径,存在则返回。 */
async function extractExeFromShim(shimPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(shimPath, 'utf8');
  } catch {
    return null;
  }
  const m = content.match(/([^\s"';]*opencode\.exe)/i);
  const raw = m?.[1];
  if (!raw) return null;
  const shimDir = path.dirname(path.resolve(shimPath));
  const resolved = raw
    .replace(/%~?dp0%/gi, shimDir)
    .replace(/\$basedir\b/gi, shimDir)
    .replace(/^["']|["']$/g, '');
  if (!resolved) return null;
  const candidate = resolved.replace(/[/\\]+/g, path.sep);
  return (await fileExists(candidate)) ? candidate : null;
}

/**
 * 解析 binPath 的调用方式:
 * - Windows 优先原生 exe(直接 spawn,免 shell 引号损耗);
 * - 找不到 exe 时回退 shell 模式(交给 cmd 查 PATHEXT 找 .cmd shim)。
 * 非一行内完成,结果按 binPath 缓存。
 */
async function resolveInvocation(binPath: string): Promise<Invocation> {
  const cached = invocationCache.get(binPath);
  if (cached) return cached;
  const inv = await computeInvocation(binPath);
  invocationCache.set(binPath, inv);
  return inv;
}

async function computeInvocation(binPath: string): Promise<Invocation> {
  if (process.platform !== 'win32') {
    return { file: binPath, shell: false, note: '非 Windows:直接 spawn' };
  }
  const isAbsLike = /[\\/]/.test(binPath);
  const ext = path.extname(binPath).toLowerCase();

  if (ext === '.exe' || ext === '.com') {
    return { file: binPath, shell: false, note: `指定 exe: ${binPath}` };
  }

  if (isAbsLike) {
    // 显式路径:优先解析 shim 内的真实 exe;再试补 .exe;最后走 shell。
    const shimExe = (ext === '.cmd' || ext === '.bat' || ext === '.ps1')
      ? await extractExeFromShim(binPath)
      : null;
    if (shimExe) return { file: shimExe, shell: false, note: `经由 shim ${binPath} 解析到原生 exe: ${shimExe}` };
    if (ext === '.ps1') {
      return { file: 'powershell.exe', shell: false, note: `powershell 执行 ps1 shim: ${binPath}` };
    }
    if (!ext && binPath && await fileExists(`${binPath}.exe`)) {
      return { file: `${binPath}.exe`, shell: false, note: `补全 .exe: ${binPath}.exe` };
    }
  } else {
    // 裸名(如 'opencode'):沿 PATH 找 exe;找 .cmd shim → 解析其中 exe;都不行交 shell。
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      for (const name of ['opencode.exe', 'opencode.com']) {
        const p = path.join(dir, name);
        if (await fileExists(p)) return { file: p, shell: false, note: `PATH 命中原生二进制: ${p}` };
      }
    }
    for (const dir of pathDirs) {
      const shimPath = path.join(dir, `${binPath}.cmd`);
      if (await fileExists(shimPath)) {
        const shimExe = await extractExeFromShim(shimPath);
        if (shimExe) return { file: shimExe, shell: false, note: `解析 ${shimPath} → 原生 exe: ${shimExe}` };
        return { file: binPath, shell: true, note: `仅找到 cmd shim(${shimPath}),回退 shell 模式` };
      }
    }
  }

  return { file: binPath, shell: true, note: `未在 PATH 解析到 opencode,回退 shell 模式(bin=${binPath})` };
}

/** shell 模式下的单参转义:裸词安全集合之外的参数用双引号包住。 */
function winShellQuote(v: string): string {
  if (/^[A-Za-z0-9@%_+=,.:\\/-]+$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}

interface RunCommandOptions {
  file: string;
  shell: boolean;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** kill 进程树(Windows 用 taskkill /T /F,防止孤儿 opencode 进程)。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch { /* 尽力而为 */ }
  }
  try {
    child.kill('SIGKILL');
  } catch { /* 已退出 */ }
}

/** 直接运行 opencode(可注入 shell 模式);超时 kill 全树并按时返回。 */
function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    let argv = opts.argv;
    if (opts.shell) {
      // shell 模式:cmd.exe 对跨行引号不可靠 —— 把换行拍平成空格,并逐参转义。
      argv = argv.map((a) => winShellQuote(a.replace(/\r?\n/g, ' ')));
    }
    const child = spawn(opts.file, argv, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      shell: opts.shell,
      // stdin 显式丢弃:默认 'pipe' 会给子进程一个永不 EOF 的管道,
      // opencode 在非 TTY 下会尝试从 stdin 读输入而永远静默阻塞(CI 首跑 10 分钟零输出挂死的根因)。
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    timer.unref?.();

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = e.code === 'ENOENT'
        ? '找不到 opencode 可执行文件 —— 请安装 opencode,或用 AIWF_OPENCODE_BIN/engineConfig.binPath 指定 opencode.exe 路径'
        : e.code === 'EINVAL'
          ? 'Windows 上拒绝直接调用 .cmd/.bat shim —— 请把 AIWF_OPENCODE_BIN 指向原生 opencode.exe'
          : '';
      reject(new Error(`AIWF(opencode): 无法启动进程(${opts.file}): ${e.code ?? ''} ${e.message}${hint ? `——${hint}` : ''}`));
    });

    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Engine 实现
// ---------------------------------------------------------------------------

const PLAN_DEFAULT_FLAGS = ['--agent', 'plan'] as const; // plan() 默认使用内置只读 agent
const EXECUTE_DEFAULT_FLAGS = ['--auto'] as const;       // executeTask() 默认放行权限(无人值守写文件)

export interface OpencodeEngineOptions {
  /** 注入 runCommand 的测试替身形状。 */
  runCommandImpl?: (opts: RunCommandOptions) => Promise<RunCommandResult>;
}

export class OpencodeEngine implements Engine {
  readonly kind = 'opencode' as const;

  private readonly runImpl: (opts: RunCommandOptions) => Promise<RunCommandResult>;

  constructor(options: OpencodeEngineOptions = {}) {
    this.runImpl = options.runCommandImpl ?? runCommand;
  }

  private async binAndEnv(binPath: string, config: EngineConfig): Promise<{ file: string; shell: boolean; env: NodeJS.ProcessEnv; note: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(config.env ?? {}) };
    const inv = await resolveInvocation(binPath);
    return { file: inv.file, shell: inv.shell, env, note: inv.note };
  }

  async plan(req: PlanRequest, config: EngineConfig): Promise<WorkflowPlan> {
    const binPath = config.binPath ?? process.env.AIWF_OPENCODE_BIN ?? 'opencode';
    const extras = config.extraArgs ?? [];
    const { file, shell, env, note } = await this.binAndEnv(binPath, config);
    const timeoutMs = config.timeoutMs ?? DEFAULT_OPENCODE_TIMEOUT_MS;

    const argv: string[] = ['run'];
    const model = config.model ?? process.env.AIWF_MODEL;
    if (model && !extras.some((a) => a === '--model' || a === '-m')) argv.push('--model', model);
    if (!extras.some((a) => a === '--agent')) argv.push(...PLAN_DEFAULT_FLAGS);
    argv.push(...extras);
    argv.push(buildPlanPrompt(req));

    const r = await this.runImpl({ file, shell, argv, cwd: req.repo.rootDir, env, timeoutMs });
    if (r.code !== 0) {
      throw new Error(
        `AIWF(opencode): plan 阶段调用 opencode 失败(退出码 ${r.code}${r.timedOut ? `,超过 ${Math.round(timeoutMs / 1000)}s 超时被杀` : ''};${note})); ` +
        `stderr 尾部: ${(r.stderr || '(空)').trim().slice(-600)};stdout 尾部: ${(r.stdout || '(空)').trim().slice(-600)}`,
      );
    }
    return parsePlanJson(r.stdout);
  }

  async executeTask(ctx: MemberContext, config: EngineConfig): Promise<TaskResult> {
    const binPath = config.binPath ?? process.env.AIWF_OPENCODE_BIN ?? 'opencode';
    const extras = config.extraArgs ?? [];
    const timeoutMs = config.timeoutMs ?? DEFAULT_OPENCODE_TIMEOUT_MS;

    const base: Omit<TaskResult, 'changedFiles' | 'error'> = {
      taskId: ctx.task.id,
      status: 'completed',
      summary: '',
      notes: [],
    };

    let cwd = ctx.worktreeDir;
    try {
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) throw new Error('不是目录');
    } catch (e) {
      return {
        ...base,
        status: 'failed',
        summary: toOneLine(`worktree 目录不可用: ${cwd}`),
        changedFiles: [],
        notes: [...base.notes],
        error: `worktree 目录不存在或不可用: ${cwd}(${e instanceof Error ? e.message : String(e)})`,
      };
    }

    const { file, shell, env, note } = await this.binAndEnv(binPath, config);
    const argv: string[] = ['run'];
    const model = config.model ?? process.env.AIWF_MODEL;
    if (model && !extras.some((a) => a === '--model' || a === '-m')) argv.push('--model', model);
    if (!extras.some((a) => a === '--auto')) argv.push(...EXECUTE_DEFAULT_FLAGS);
    argv.push(...extras);
    argv.push(buildTaskPrompt(ctx));

    let r: RunCommandResult;
    try {
      r = await this.runImpl({ file, shell, argv, cwd, env, timeoutMs });
    } catch (e) {
      return {
        ...base,
        status: 'failed',
        summary: toOneLine('opencode 启动失败'),
        changedFiles: [],
        notes: [...base.notes, `细节: ${e instanceof Error ? e.message : String(e)}`],
        error: `opencode 启动失败(${note}): ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const notes = [...base.notes];

    // 非 0 退出码:失败(尽力收集已产生的变更供排查)。
    if (r.code !== 0) {
      const changed = await this.safeCollect(cwd, notes);
      if (r.timedOut) {
        notes.push(`opencode 超过 ${Math.round(timeoutMs / 1000)}s 被终止(kill 进程树)`);
      }
      return {
        ...base,
        status: 'failed',
        summary: toOneLine(`成员任务执行失败(opencode 退出码 ${r.code}${r.timedOut ? ',超时' : ''})`),
        changedFiles: changed,
        notes,
        error: r.timedOut
          ? 'timeout'
          : `opencode 退出码 ${r.code};stderr 尾部: ${(r.stderr || '(空)').trim().slice(-600)}`,
      };
    }

    const stdout = r.stdout;
    const mark = parseAiwfResultMark(stdout);
    let status: TaskStatus = 'completed';
    let summary: string;
    if (mark) {
      status = mark.status;
      summary = toOneLine(mark.summary || '(空摘要)');
      notes.push(...mark.notes.map((n) => `成员备注: ${n}`));
    } else {
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      summary = toOneLine(lines[lines.length - 1] ?? '(无输出)');
      notes.push('AIWF_RESULT 标记缺失或非法,状态按 completed 处理;摘要取自最后一行非空输出');
    }

    const changed = await this.safeCollect(cwd, notes);
    return { ...base, status, summary, changedFiles: changed, notes };
  }

  /** changedFiles 收集失败不影响主体结果(成员级收益,不是必须)。 */
  private async safeCollect(dir: string, notes: string[]): Promise<Awaited<ReturnType<typeof collectChangedFiles>>> {
    try {
      return await collectChangedFiles(dir, { notes });
    } catch (e) {
      notes.push(`收集 changedFiles 失败(git status): ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
}
