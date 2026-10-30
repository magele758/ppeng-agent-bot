# Personal registered machines（个人注册机器）

与 Factory SSH 完全分离的另一条轨道。存储键 `registered.machines:<principal>`，**不读写** `factory.settings:*`，不经过 `FactoryTransport`。

| | Factory SSH | Registered machines（本页） |
|---|---|---|
| 用途 | 软件工厂：固定只读 / 受控开发 worker，带 receipt | 用户自己的桌面/服务器：任意 shell、读文件、拷贝 |
| 传输 | `SshFactoryTransport`，固定 Python worker | **优先**桌面 agent 长连（`DesktopAgentHub` / `createDesktopAgentBackend`）；否则 `createSshRegisteredMachineBackend`（用户 `~/.ssh/config` Host 别名） |
| 入口 | `factory_*` 工具、Factory 设置 | `list_machines` / `register_machine` / `copy_to_machine` / `copy_from_machine`，`bash` / `read_file` 的 `machineId` |
| 审批 | 工厂策略 | 远端 shell / read / copy 与带 `sshAlias` 的注册**每次都需审批** |

运行时后端由 `createCompositeRegisteredMachineBackend` 装配：同一 `machineId` 上若桌面 agent 已 `attach`，一律走 agent handlers，**不**再 spawn `ssh`。

## 路径 A — 桌面 agent 长连（r4-7 Option A）

1. `register_machine { machineId, label, kind }`（可不带 `sshAlias`）。
2. 本机桌面 agent（或同进程适配器）调用 `getSharedDesktopAgentHub().attach(machineId, handlers)`，在长连存活期间提供 `shell` / `read` / `copy`。
3. `list_machines` → `connected=true`；`bash` / `read_file` / `copy_*` 的 `machineId` 打到该 agent。
4. 长连断开时 `detach`；此后 `connected=false`，操作返回 `machine_disconnected`（若同时配置了 `sshAlias`，composite 会回退到 SSH 探测）。

核心类型：`DesktopAgentHub`、`createDesktopAgentBackend`、`createCompositeRegisteredMachineBackend`（`packages/core/src/registered-machines/`）。Daemon HTTP/SSE 适配器可随后把远端桌面进程接到同一 hub；本切片先落地 Port/backend 与单测。

## 路径 B — SSH Host 别名（#321）

1. 在本机 `~/.ssh/config` 配好 Host 别名：密钥登录（`BatchMode`，不会弹密码）、目标主机指纹已在 `known_hosts`（`StrictHostKeyChecking=yes`）。远端需 POSIX `sh`。
2. 让助手调用 `register_machine`：`{ machineId: "desk", label: "Desk", kind: "desktop", sshAlias: "my-desk" }`（审批后生效）。不带 `sshAlias` 且无 agent 长连时，机器只出现在列表里，永远 `connected=false`。
3. `list_machines` 会实时探测（`connected`，成功缓存 30s、失败 5s）。
4. `bash { machineId, command }`、`read_file { machineId, path, offset_line, limit }`、`copy_to_machine` / `copy_from_machine`（本地路径限工作区，单文件 ≤ 10 MiB）。

## 失败即关闭

离线、未注册、无 `sshAlias` 且无 agent 附着 → `machine_disconnected` / `unknown_machine`，不执行任何远端命令。ssh 子进程使用 `sanitizeSpawnEnv`，并强制 `ClearAllForwardings` / `ForwardAgent=no` / `PermitLocalCommand=no`；命令过 hardline；远端读写拒绝 `.env` / `id_rsa` / `credentials` 及 `.ssh` `.aws` `.gnupg` `.kube` `.docker` 目录（agent 路径同样在 backend 层拒绝敏感路径）。

注意：SSH 别名由 daemon 所在主机的 ssh 配置解析；多租户部署应只在受信用户的会话中放开 `register_machine`。桌面 agent 附着是进程内状态，需与 daemon 生命周期对齐。
