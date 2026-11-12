# AI Dev Workflow — 本地 CLI(`aiwf`)手册

> `aiwf` 是本仓库的本地入口:在与 GitHub Action **完全相同的核心流水线**上,
> 对任意本地 git 仓库跑一次「队长规划 → 并行队员 → 队长合成 → 本地交付」。
> Action 面向"Issue 到 PR"的自动化场景;CLI 面向"我手头这个仓库,现在就干"的场景。

- Action 接入手册:[docs/action.md](action.md)
- 安全与额度护栏:[docs/security.md](security.md)

---

## 1. 构建与安装

```bash
pnpm install          # 同时构建 core
pnpm build            # 产出 packages/cli/dist/main.js
node packages/cli/dist/main.js --help
```

安装为全局命令(可选):

```bash
pnpm --filter @aiwf/cli build
npm link --global @aiwf/cli     # 之后可直接用 aiwf
```

CLI 依赖 `git`(必须);若要创建 PR,还需要 `gh` CLI 并已 `gh auth login`。

---

## 2. 基本用法

```bash
# 一句话诉求 → 先只看队长计划(dry-run,不碰任何成员、不交付)
aiwf run --inline "给 README 增加 Quick Start 段落" --dry-run

# 从 markdown 任务文件全量执行(mock 引擎,零真实模型调用)
aiwf run --from demo.md --engine mock

# 真实引擎:显式模型 + 超时 + 基线分支
AIWF_MODEL=opencode/glm-5.3-free aiwf run --from task.json \
    --engine opencode --model opencode/glm-5.3-free \
    --timeout-ms 1500000 --base-branch main

# 多模型编制:实现用快模型,评审用另一个模型
aiwf run --from task.md --models "worker=opencode/glm-5.3,reviewer=minimax/MiniMax-M3.1-Flash"

# 脚本化:结束后输出机器可读的 RunResult JSON
aiwf run --inline "规范 package.json scripts" --engine mock --json
```

---

## 3. 任务来源(三选一,互斥)

| 参数 | 说明 |
| --- | --- |
| `--from <file.md\|file.json>` | 任务文件:`.md`(首行 `# ` 为标题,其余为正文)或 `.json`(`{title, body, …}`) |
| `--inline <text>` | 一句话诉求 |
| `--issue <owner/repo#n>` | **本地不支持**,会给出引导信息(远程 Issue 是 Action 的场景) |

---

## 4. 选项表

| 选项 | 默认 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--dir <path>` | `.` | — | 目标 git 仓库(必须通过 `git rev-parse` 校验) |
| `--engine <opencode\|mock>` | `$AIWF_ENGINE` ?? `opencode` | `AIWF_ENGINE` | 引擎类型。`mock` 为确定性演练,不触发真实模型 |
| `--model <provider/model>` | `$AIWF_MODEL` | `AIWF_MODEL` | 队长与未指派队员使用的模型 |
| `--models <role=model,…>` | 空 | `AIWF_MODELS` | **模型池**:队长可为不同队员指派不同模型。逗号或换行分隔,`default` 为兜底角色 |
| `--max-tasks <n>` | `6` | `AIWF_MAX_TASKS` | **编制人数上限**(1~10):队长在此上限内自主决定用几个队员 |
| `--max-parallel <n>` | `4` | `AIWF_MAX_PARALLEL` | 并行队员上限(1~8) |
| `--timeout-ms <n>` | `1200000` | `AIWF_TIMEOUT_MS` | 引擎单步超时毫秒(60000~3600000) |
| `--budget <n>` | `0` | `AIWF_BUDGET` | **相对成本预算上限**(low=1 / medium=3 / high=8 单位);0 = 不限 |
| `--guidelines <text>` | 空 | `AIWF_GUIDELINES` | **行为准则**:每行一条,叠加在内置默认准则之后 |
| `--base-branch <name>` | 当前分支 | `AIWF_BASE_BRANCH` | PR 基线分支提示 |
| `--branch-prefix <p>` | `aiwf/` | `AIWF_BRANCH_PREFIX` | 队员工作分支前缀 |
| `--dry-run` | `false` | — | 只输出队长计划,不执行成员、不交付 |
| `--json` | `false` | — | 结束后输出完整 `RunResult` JSON(脚本化) |

> 所有选项的优先级恒为:**命令行参数 > 环境变量 > 默认值**。

---

## 5. 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 全部成员完成(或 dry-run 没有成员执行) |
| `1` | 跑完了,但有成员失败/部分完成(交付只达成了一部分) |
| `2` | 参数错误或致命错误(用法错误、git 不可用等) |

脚本里可直接用退出码判断成败,不必解析输出。

---

## 6. 与 GitHub Action 的差异

CLI 与 Action **共用同一套核心流水线**(队长、队员、合成、脱敏、护栏),差异只在平台适配层:

| 能力 | Action | CLI |
| --- | --- | --- |
| 任务来源 | GitHub Issue | 本地文件 / 一句话 |
| 触发准入(`trigger_policy`) | ✅ | ❌ 本地由你自己发起,无需准入 |
| 每日配额(`daily_run_limit`) | ✅ | ❌ 本地额度由你控制 |
| 幂等短路(`idempotent`) | ✅ | ❌ 本地重复跑是有意为之 |
| 两段式审批(`approve`) | ✅ | ❌ 本地你在场,无需审批 |
| 裁决回帖 / 决策包回帖 | ✅ 回到 Issue | ❌ 只在终端与 summary 输出 |
| 交付 | 推送 + 建 PR | 推送 + `gh pr create`(缺 `gh`/远端时降级为"仅本地分支") |

> 需要审批、准入、配额这些**组织级**护栏时,用 Action;需要"我手头这个仓库现在就干"时,用 CLI。

---

## 7. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `不是 git 仓库` | `--dir` 指向非 git 目录 | 指向仓库根,或先 `git init` |
| `opencode 找不到` | 未安装引擎 CLI | `npm install -g opencode-ai`;或先 `--engine mock` 验证链路 |
| `模型 4xx / 无凭证` | 供应商凭证未注入 | 导出对应变量(如 `MINIMAX_API_KEY`);opencode 系模型用 `OPENCODE_API_KEY` |
| `gh 缺失` | 未安装 `gh` | 装 GitHub CLI 并 `gh auth login`;否则只会推送分支不建 PR |
| `超出本次运行的时间预算` | 单次运行耗时超墙钟预算 | 调大 `--timeout-ms` 或调小 `--max-tasks` / `--max-parallel` |
| `已排除 N 个疑似凭证文件` | 成员产出了 `.env` / `*.pem` 等 | 属预期拦截:该文件不会进入提交与 PR |
| 退出码 `1` 但没报错 | 有成员 failed/partial | 看终端的「结项报告」状态表 |
| 退出码 `2` | 参数错误 | 按提示修正参数(错误信息是中文的) |
