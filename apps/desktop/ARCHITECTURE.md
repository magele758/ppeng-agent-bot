# Desktop Client - 架构说明

## 概述

Raw Agent Desktop 是一个 Electron 应用，将 daemon（HTTP API 服务器）和 Web Console（Next.js UI）打包为独立应用：macOS 仅 arm64，Windows 与 Linux 为 x64 与 arm64。Intel Mac（darwin x64）不打包。

## 核心设计

### 为什么选择 Electron

1. **复用现有 UI**：Web Console 是 Next.js 应用，Electron 可以直接加载
2. **集成后端**：可以在 Electron 内部启动 Node.js daemon 进程
3. **原生体验**：系统托盘、菜单栏、快捷键、文件关联等
4. **跨平台**：同一套主进程打 Apple Silicon mac、Windows 与 Linux（后两者 x64 与 arm64）

### 技术栈

- **Electron 37+**：需要 Node 22（`node:sqlite` 支持）
- **TypeScript**：类型安全
- **electron-builder**：打包和分发
- **electron-store**：持久化配置（窗口大小、端口等）

## 架构图

```
┌─────────────────────────────────────────┐
│         Electron Main Process           │
│  探测端口：daemon 默认 37070 / web 默认  │
│  33815（跟随 Lab），占用则递增并写回     │
│  config.json                             │
│  ┌───────────────────────────────────┐  │
│  │   spawn daemon (ELECTRON_RUN_AS_  │  │
│  │   NODE=1, execPath)               │  │
│  │   ↓                                │  │
│  │   apps/daemon/dist/server.js      │  │
│  │   (HTTP API on 探测得到的端口)     │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │   spawn web (ELECTRON_RUN_AS_     │  │
│  │   NODE=1, execPath；注入同一份     │  │
│  │   RAW_AGENT_AUTH_TOKEN /          │  │
│  │   DAEMON_PROXY_TARGET）           │  │
│  │   ↓                                │  │
│  │   .next/standalone/...server.js   │  │
│  │   (Next.js on 探测得到的端口)      │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
                    │
                    │ loadURL('http://127.0.0.1:<web 端口>')
                    ↓
┌─────────────────────────────────────────┐
│      Electron Renderer Process          │
│   (BrowserWindow with Web Console UI)   │
│                                          │
│  middleware.ts proxies /api/* to daemon │
└─────────────────────────────────────────┘
```

## 关键文件

| 文件 | 作用 |
|------|------|
| `apps/desktop/src/main.ts` | Electron 主进程：管理窗口、托盘、进程生命周期、端口探测、鉴权 token |
| `apps/desktop/src/port-utils.ts` | 本地端口探测（`isPortFree` / `pickPort`），供 daemon/web 启动前选择实际可用端口 |
| `apps/desktop/src/env-utils.ts` | 简单 `.env` 解析与「缺失则写入」工具，供端口/鉴权 token 读取与生成复用 |
| `apps/desktop/src/preload.ts` | Preload 脚本：渲染进程与主进程的桥梁（当前未使用） |
| `apps/desktop/package.json` | 构建配置、依赖、electron-builder 设置 |
| `scripts/prepare-desktop-server.mjs` | 装配 server-bundle：daemon + packages + node_modules |
| `scripts/build-desktop.mjs` | 一键构建（`--platform` / `--arch`） |
| `scripts/lib/desktop-targets.mjs` | 5 套产物 id 与 electron-builder 参数（不含 Intel Mac） |

## 打包流程

### 1. 准备阶段

```bash
npm run build                    # 编译 core、daemon、cli
cd apps/web-console && npm run build  # Next.js standalone
node scripts/prepare-desktop-server.mjs  # 装配 server-bundle
```

**server-bundle 结构**：

```
server-bundle/
├── apps/daemon/dist/        # daemon 编译产物
├── node_modules/            # 生产依赖（实体目录）
│   ├── @ppeng/agent-core/   # 从 packages/core/dist 复制
│   ├── redis/               # npm install 安装
│   ├── pg/
│   └── ...
└── package.json             # 合并后的依赖清单
```

### 2. 打包阶段

```bash
cd apps/desktop
npm install                  # 安装 electron、electron-builder
npm run dist                 # electron-builder 打包
```

**electron-builder 做什么**：

1. 编译 TypeScript（`src/*.ts` → `dist/*.js`）
2. 复制 `server-bundle/` 到 `Resources/server-bundle/`
3. 复制 `.next/standalone/` 到 `Resources/web/`
4. 复制静态资源（`.next/static/`, `public/`）
5. 生成 `.app` 和 `.dmg`

### 3. 产物

```
apps/desktop/release/
├── Raw Agent-0.1.0-arm64.dmg     # 用户分发文件
├── Raw Agent-0.1.0-arm64-mac.zip # 备用格式
└── mac-arm64/                     # 未签名的 .app 目录
```

## 运行时行为

### 启动流程

1. **Electron 主进程启动**
2. **创建托盘图标**（可选，图标不存在时跳过）
3. **探测端口**（`resolvePorts()`）：
   - 优先取用户 `.env` 中的 `RAW_AGENT_DAEMON_PORT` / `RAW_AGENT_WEB_PORT`，其次取本地 `config.json` 中保存的偏好值（默认跟随 Lab：37070 / 33815）
   - 逐一探测是否被占用，占用则递增探测；最终生效端口写回 `config.json`
4. **准备鉴权 token**（`ensureAuthToken()`）：用户 `.env` 中若无 `RAW_AGENT_AUTH_TOKEN`，生成随机 token 并写回该文件
5. **启动 daemon**：
   - `utilityProcess.fork(daemonPath, { env: { ELECTRON_RUN_AS_NODE: '1', RAW_AGENT_DAEMON_PORT, RAW_AGENT_AUTH_TOKEN, ... } })`
   - 读取 `~/Library/Application Support/agent-desktop/.env` 并合并，但探测端口/token 始终以主进程计算值为准
   - 设置 `RAW_AGENT_STATE_DIR` 到 `~/Library/.../state/`
   - 轮询 `http://127.0.0.1:<daemon 端口>/api/health` 直到成功或超时
6. **启动 Web Console**：
   - `utilityProcess.fork(webPath, { env: { ELECTRON_RUN_AS_NODE: '1' } })`
   - 设置 `DAEMON_PROXY_TARGET=http://127.0.0.1:<daemon 端口>`、`RAW_AGENT_AUTH_TOKEN`（与 daemon 一致）
   - 轮询 `http://127.0.0.1:<web 端口>/` 直到响应或超时
7. **创建窗口**：
   - `mainWindow.loadURL('http://127.0.0.1:<web 端口>')`
   - 渲染进程加载 Next.js UI
   - 用户交互通过 `/api/*` 请求到 daemon（middleware 自动附带 `Authorization: Bearer <token>`）

### 为什么用 `ELECTRON_RUN_AS_NODE`

打包后的 macOS 应用**不包含独立的 Node.js**。用户机器可能没装 Node。

Electron 自带 Node 运行时（Chromium + Node），通过设置 `ELECTRON_RUN_AS_NODE=1` 可以让 Electron 的 Node 运行任意 `.js` 脚本（而不是启动一个新的 Electron 窗口）。

**好处**：
- 无需用户安装 Node.js
- daemon 和 web 用的 Node 版本与 Electron 一致（Node 22）
- 原生模块（如 `node:sqlite`）无需重新编译

### 依赖解析

daemon 的 `import '@ppeng/agent-core'` 如何解析？

Node.js 模块解析从当前文件向上查找 `node_modules/`：

```
server-bundle/apps/daemon/dist/server.js
  → require('@ppeng/agent-core')
  → 向上查找 node_modules/@ppeng/agent-core/
  → 找到 server-bundle/node_modules/@ppeng/agent-core/
  → 加载 dist/index.js
```

`prepare-desktop-server.mjs` 把 `packages/*/dist/` 复制到 `server-bundle/node_modules/@ppeng/*/dist/`，模拟了 workspace 的符号链接。

### 配置管理

- **用户配置**：`~/Library/Application Support/agent-desktop/.env`（模型/API Key、可选端口与 token 覆盖）
- **应用配置**：本地 `config.json`（`windowBounds`、`daemonPort`、`webPort`）——`daemonPort`/`webPort` 保存的是每次启动实际探测到的生效端口，不只是写入不读的静态默认值
- **状态数据**：`~/Library/Application Support/agent-desktop/state/`

首次运行时，托盘菜单 "Open Config" 会：
1. 检查 `.env` 是否存在
2. 不存在则从 `Resources/.env.example` 复制模板
3. 用系统默认编辑器打开

## 开发模式

```bash
cd apps/desktop
npm run dev
```

**假设**：
- `apps/daemon/dist/` 已存在（需先运行根目录 `npm run build`）
- `apps/web-console/.next/standalone/` 已存在（需先 `npm run build`）

**路径映射**：
- daemon: `process.cwd()/../daemon/dist/server.js`
- web: `process.cwd()/../web-console/.next/standalone/apps/web-console/server.js`

**注意**：开发模式不会自动重新编译 daemon/web，修改代码后需重新 build。

## 常见问题

### Q: 为什么不用 `asar` 打包？

A: daemon 依赖 `node:sqlite`，需要运行时写入数据库文件。`asar` 是只读归档，无法满足需求。

### Q: 为什么不用 `pkg` 或 `nexe` 打包成单文件？

A: `node:sqlite` 是 Node 22 内置模块，无法静态链接。且 `pkg` 不支持 ESM。

### Q: 为什么 `server-bundle` 这么大（>200MB）？

A: 包含完整的 `node_modules/`（redis、pg、aws-sdk、jsonrepair、sharp 等）。未来可以：
- 剔除 devDependencies（已做）
- 排除可选依赖（sharp）
- 使用 webpack 打包成单文件（复杂，不推荐）

### Q: Windows / Linux / Mac 怎么打？

A: `node scripts/build-desktop.mjs --platform mac|win|linux --arch x64|arm64`。Mac 只接受 `arm64`。CI 见 `.github/workflows/desktop.yml`（5 套，按 runner arch 本机编译）。不要加回 Intel Mac（darwin x64 / `mac-x64`）：用户太少，Rosetta 任务也慢。不要在 x64 Linux 上交叉打 arm64 / Windows：Next standalone 与 sharp 绑死本机三元组。

### Q: 如何签名和公证？

A: 需要 Apple Developer 账号：
1. 申请 Developer ID Application 证书
2. 在 `package.json` 添加：
   ```json
   "build": {
     "mac": {
       "identity": "Developer ID Application: Your Name (TEAM_ID)"
     }
   }
   ```
3. 构建后公证：
   ```bash
   xcrun notarytool submit --wait \
     --apple-id your@email.com \
     --password @keychain:AC_PASSWORD \
     --team-id TEAM_ID \
     apps/desktop/release/Raw\ Agent-0.1.0-arm64.dmg
   ```

### Q: 用户能修改数据库吗？

A: 可以，路径在 `~/Library/Application Support/agent-desktop/state/agent.db`。但不推荐直接修改，可能导致数据损坏。

### Q: 如何添加自动更新？

A: 使用 `electron-updater`：
1. 配置 `publish` 到 GitHub Releases
2. 在主进程添加更新检查逻辑
3. 签名 DMG（必需）

## 未来改进

1. **自动更新**：electron-updater + GitHub Releases
2. **性能优化**：延迟加载、按需启动 daemon
3. **多语言**：i18n 支持
4. **主题**：亮色/暗色模式切换
5. **快捷键**：全局快捷键唤醒窗口
6. **多窗口**：支持同时打开多个会话
7. **日志查看器**：内置日志面板
8. **备份/还原**：一键备份配置和数据

## 维护者

需要熟悉：
- Electron IPC 和进程模型
- Node.js 子进程管理（`spawn`, `kill`）
- Next.js standalone 模式
- electron-builder 配置
- macOS 应用签名和公证

## 参考资料

- Electron 官方文档：https://www.electronjs.org/docs
- electron-builder：https://www.electron.build/
- Next.js standalone：https://nextjs.org/docs/advanced-features/output-file-tracing
- Apple 代码签名：https://developer.apple.com/support/code-signing/
