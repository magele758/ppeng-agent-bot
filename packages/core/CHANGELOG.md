# @ppeng/agent-core Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/)；版本号先随仓库整体节奏，暂不做独立 semver 发布。

## Unreleased

### Breaking

- 主入口 `@ppeng/agent-core` 改为白名单导出（`src/exports/public.ts`）。不再 `export *` 内部 `stores/*`，也不能再 `import { SqliteStateStore } from '@ppeng/agent-core'`。内部测试继续走 `../dist/storage.js`；嵌入方用 L4 `createAgentLoop` / L1 `SessionSurfaceStore`。见 [`doc/EMBEDDING_SDK.md`](../../doc/EMBEDDING_SDK.md)。

### Added

- `package.json`：补齐 `engines.node >= 22`（`node:sqlite` 依赖）、`files`（`dist`/`examples`/`README.md`/`CHANGELOG.md`）、`description`，明确发布边界。
- `doc/EMBEDDING_SDK.md`：第三方嵌入场景的稳定 API 面清单 + 最小 env 契约。
- `packages/core/README.md`：安装、快速开始、文档索引。
- 根目录 `npm run test:examples`：顺序运行 `examples/01`–`07`，验证 dist 产物对嵌入方仍可用。

- Bot 启动耗时：会话 `startup_phase` 记录启动各段毫秒数。看 `phase=ready` 的 `slowest` 即最慢的一段。控制台只在进程启动时打印 boot 阶段，不再把每一轮的分段打出来。

- 调度恢复目标时先拿写锁；同一状态目录的第二个运行时不再写库，避免 `database is locked`。
- 开轮时的目标接入不再等判定模型，数据库锁最多等 100ms，失败也不挡住这一轮。

### Fixed

- 群上下文刷新时，未设置的单次执行步数继续记为不限，不再把已继承的 0 删掉。
- `examples/03-subagent.mjs`：脚本化适配器未区分父/子会话上下文，导致 `spawn_subagent` 无限递归；现按子会话种子提示词直接终止。
