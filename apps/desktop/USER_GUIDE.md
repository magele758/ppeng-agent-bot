# Raw Agent Desktop - 用户指南

Raw Agent 的 macOS 原生客户端，一键启动完整的 Agent 环境。

## 功能特性

- 🖥️ **原生体验**：macOS 应用，无需单独安装 Node.js
- 🚀 **一键启动**：自动管理 daemon 和 Web Console 进程
- 🎯 **系统托盘**：后台运行，快速访问
- 💾 **持久状态**：对话、任务、工作空间自动保存
- ⚙️ **简单配置**：通过 .env 文件配置模型和 API Keys
- 🔒 **沙箱隔离**：代码执行自动沙箱保护

## 系统要求

- macOS 11.0 (Big Sur) 或更高版本
- Apple Silicon (M1/M2/M3) 芯片
- 至少 4GB 可用磁盘空间

## 安装

1. **下载**：从 release 页面下载 `.dmg` 文件
2. **安装**：
   - 双击 `.dmg` 文件挂载
   - 将 "Raw Agent" 拖拽到 Applications 文件夹
   - 弹出磁盘镜像
3. **首次运行**：
   - 打开 Applications 文件夹
   - 双击 "Raw Agent"
   - 如果提示"无法验证开发者"，右键点击选择"打开"

## 配置

### 首次配置

首次启动时，需要配置 AI 模型：

1. 点击菜单栏的 Raw Agent 图标
2. 选择 "Open Config (.env)"
3. 在打开的文本文件中添加：

```bash
# 模型配置（必需）
RAW_AGENT_MODEL_PROVIDER=openai-compatible
RAW_AGENT_MODEL_NAME=gpt-4
RAW_AGENT_API_KEY=your-api-key-here
RAW_AGENT_BASE_URL=https://api.openai.com/v1

# 可选：视觉模型（支持图片输入）
RAW_AGENT_VL_MODEL_NAME=gpt-4o
```

4. 保存文件
5. 点击托盘图标选择 "Restart Services"

### 支持的模型提供商

#### OpenAI / OpenAI 兼容

```bash
RAW_AGENT_MODEL_PROVIDER=openai-compatible
RAW_AGENT_MODEL_NAME=gpt-4
RAW_AGENT_API_KEY=sk-xxx
RAW_AGENT_BASE_URL=https://api.openai.com/v1
```

#### Anthropic Claude

```bash
RAW_AGENT_MODEL_PROVIDER=anthropic-compatible
RAW_AGENT_MODEL_NAME=claude-3-5-sonnet-20241022
RAW_AGENT_API_KEY=sk-ant-xxx
RAW_AGENT_ANTHROPIC_URL=https://api.anthropic.com
```

#### 本地模型（Ollama 等）

```bash
RAW_AGENT_MODEL_PROVIDER=openai-compatible
RAW_AGENT_MODEL_NAME=qwen2.5-coder:32b
RAW_AGENT_API_KEY=dummy
RAW_AGENT_BASE_URL=http://localhost:11434/v1
RAW_AGENT_USE_JSON_MODE=0
```

### 高级配置

```bash
# 端口配置（默认跟随 Lab：daemon 37070 / web 33815，无需修改；
# 占用时应用会自动探测递增，实际生效端口写回本地配置，此处仅用于强制指定）
RAW_AGENT_DAEMON_PORT=37070
RAW_AGENT_WEB_PORT=33815

# 认证：留空则应用首次启动会自动生成随机 token 并写回本文件，
# daemon 与内置 Web Console 会共用同一个 token，无需手动配置
RAW_AGENT_AUTH_TOKEN=your-secret-token

# 沙箱：对话里的 Agent 每次自己选隔离，一般不用设。这行只是旧调用的回退。
# RAW_AGENT_SANDBOX_MODE=auto

# 外部 AI 工具（需要本地安装对应 CLI）
RAW_AGENT_EXTERNAL_AI_TOOLS=1

# 技能路由
RAW_AGENT_SKILL_ROUTING_MODE=hybrid
```

## 使用

### 主界面

启动后会自动打开 Agent Lab Web 界面：

- **会话列表**：左侧面板，查看和切换会话
- **对话区**：中间区域，与 Agent 交互
- **工具调用**：查看 Agent 执行的操作（文件读写、命令执行等）
- **思考过程**：展开查看 Agent 的推理过程

### 常用操作

#### 创建新会话

1. 点击左上角 "New Session"
2. 输入任务描述
3. 开始对话

#### 审批工具调用

某些敏感操作需要审批：

- 文件删除、修改关键配置等
- 在 UI 中会弹出审批提示
- 点击 "Approve" 或 "Reject"

#### 查看状态目录

托盘菜单 → "Open State Directory"

包含：
- SQLite 数据库（会话、任务、工作空间）
- 日志文件
- 工作空间副本

### 托盘菜单

- **Show Raw Agent**：显示/隐藏主窗口
- **Open State Directory**：打开数据目录
- **Open Config (.env)**：编辑配置
- **Restart Services**：重启后端服务（配置修改后使用）
- **Quit**：退出应用

## 常见问题

### 启动失败

**症状**：应用启动后立即退出或显示错误

**解决方案**：
1. 检查配置文件是否正确（托盘 → Open Config）
2. 验证 API Key 是否有效
3. 查看控制台日志：
   ```bash
   /Applications/Raw\ Agent.app/Contents/MacOS/Raw\ Agent
   ```

### 端口冲突

**症状**：错误提示端口已被占用

**解决方案**：
1. 打开配置文件（托盘 → Open Config）
2. 修改端口：
   ```bash
   RAW_AGENT_DAEMON_PORT=7071
   ```
3. 重启服务（托盘 → Restart Services）

### 工具执行失败

**症状**：bash 命令执行报错

**解决方案**：
1. 系统级隔离会挡住 ~/.ssh 等目录；需要碰到这些目录时，由对话里的 Agent 在该次命令选择无隔离，并等你批准
2. 不要靠改环境变量关掉隔离

### 内存/磁盘占用过高

**症状**：应用占用大量资源

**解决方案**：
1. 清理旧的工作空间：托盘 → Open State Directory → 删除 `workspaces/` 下的旧目录
2. 清理日志：删除 `state/logs/` 下的旧日志
3. 重置数据库（会丢失历史记录）：
   ```bash
   rm ~/Library/Application\ Support/agent-desktop/state/*.db
   ```

## 数据位置

所有数据存储在：
```
~/Library/Application Support/agent-desktop/
├── .env                 # 用户配置
└── state/               # 运行时数据
    ├── agent.db         # SQLite 数据库
    ├── traces/          # 执行轨迹
    ├── workspaces/      # 工作空间
    └── logs/            # 日志文件
```

## 卸载

1. 退出应用（托盘 → Quit）
2. 删除应用：
   ```bash
   rm -rf /Applications/Raw\ Agent.app
   ```
3. （可选）删除数据：
   ```bash
   rm -rf ~/Library/Application\ Support/agent-desktop
   ```

## 更新

1. 下载新版本的 `.dmg` 文件
2. 退出旧版本
3. 重新安装（覆盖旧版本）
4. 配置和数据会自动保留

## 安全建议

1. **保护 API Keys**：不要分享配置文件
2. **审批敏感操作**：不要盲目批准所有工具调用
3. **启用认证**：生产环境设置 `RAW_AGENT_AUTH_TOKEN`
4. **定期备份**：重要会话可导出 JSON
5. **沙箱模式**：保持 `auto` 或 `os` 模式

## 技术支持

- 项目文档：查看 `apps/desktop/README.md`
- 问题反馈：提交 Issue 到 GitHub
- 开发者文档：查看根目录 `README.md` 和 `doc/` 文件夹

## 开发者

### 从源码构建

```bash
# 克隆仓库
git clone <repo-url>
cd ppeng-agent-core

# 构建
npm run build:desktop

# 输出位置
ls apps/desktop/release/*.dmg
```

### 开发模式

```bash
cd apps/desktop
npm install
npm run dev
```

## 许可证

参见根目录 LICENSE 文件。
