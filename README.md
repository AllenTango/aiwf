# ai-dev-workflow-action

把"AI 原生研发团队(队长 + 并行队员)"产品化:输入一个任务(Issue/描述文本),
流水线自动完成:

```
ingest 读取任务     →  plan 队长结构性规划
                    →  dispatch 并行队员在独立 git worktree 分头实现
                    →  synthesize 队长汇合产出、解冲突、合成提交
                    →  deliver 产出分支/PR + 结项报告
```

- 动作即验证:该仓库本身由"我(队长)+ 并行队员"的 AI 原生流程开发 —— 队员
  (subagent)在阶段 1 四路并行,各自职责与接口契约随阶段 0 提交,互不等待、
  互不通信。

## 结构

| 路径 | 说明 | 负责队员 |
| --- | --- | --- |
| `packages/core/src/contracts` | 全部共享类型/接口(队长所有) | 队长 |
| `packages/core/src/pipeline` | 流水线状态机、规划/调度/合成 | M1 |
| `packages/core/src/engine` | opencode + mock 引擎适配 | M2 |
| `packages/core/src/infra` | Git 操作、仓库快照构建 | M2 |
| `packages/cli` | 本地 CLI(`aiwf`) | M3 |
| `packages/action` | GitHub Action 壳 + 官方工作流 | M4 |

## 快速开始

```bash
pnpm install           # 同时构建 core
pnpm build && pnpm test
```

## 约定

- ESM + NodeNext:相对导入以 `.js` 结尾
- TypeScript strict;`vitest`;不抛异常表达成员级失败(TaskResult.status)
- 队员不得修改 `contracts/`、根配置与他人的责任区
