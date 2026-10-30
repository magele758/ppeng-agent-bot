# Personal registered machines（个人注册机器）

与 Factory SSH 完全分离的另一条轨道。存储键 `registered.machines:<principal>`，**不读写** `factory.settings:*`，不经过 `FactoryTransport`。

| | Factory SSH | Registered machines（本页） |
|---|---|---|
| 用途 | 软件工厂：固定只读 / 受控开发 worker，带 receipt | 用户自己的桌面/手机/服务器：桌面任意 shell、读文件、拷贝；手机默认只读 |
| 传输 | `SshFactoryTransport`，固定 Python worker | **优先**桌面 agent 长连（`DesktopAgentHub`）或手机本机工具（`DeviceLocalHub`）；否则 `createSshRegisteredMachineBackend`（用户 `~/.ssh/config` Host 别名） |
| 入口 | `factory_*` 工具、Factory 设置 | `list_machines` / `register_machine` / `copy_to_machine` / `copy_from_machine`，`bash` / `read_file` 的 `machineId` |
| 审批 | 工厂策略 | 远端 shell / read / copy 与带 `sshAlias` 的注册**每次都需审批** |

运行时后端由 `createCompositeRegisteredMachineBackend` 装配：同一 `machineId` 上若手机本机工具或桌面 agent 已 `attach`，一律走对应 handlers，**不**再 spawn `ssh`。手机附着优先于桌面附着。

## 路径 A — 桌面 agent 长连（r4-7 Option A）

1. `register_machine { machineId, label, kind }`（可不带 `sshAlias`）。
2. 桌面 agent 与 daemon **同进程**时，调用 `getSharedDesktopAgentHub().attach(machineId, handlers)`。**另一进程**时走下面的 HTTP/SSE，不必自己拿 hub。
3. `list_machines` → `connected=true`；`bash` / `read_file` / `copy_*` 的 `machineId` 打到该 agent。
4. 长连断开时 `detach`；此后 `connected=false`，操作返回 `machine_disconnected`（若同时配置了 `sshAlias`，composite 会回退到 SSH 探测）。

### Daemon HTTP/SSE（跨进程）

桌面 agent 用 daemon bearer 接同一条 `DesktopAgentHub`（`getSharedDesktopAgentHub`），不经过 Factory：

1. `GET /api/desktop-agent/:machineId/events` — SSE。打开即 `attach`；首条事件 `ready`。之后每个 shell / read / copy 推一条 `event: op`，data 为 `{ requestId, kind, input }`。
2. `POST /api/desktop-agent/:machineId/reply` — body `{ requestId, result }`，`result` 为 `{ ok, content, exitCode? }`。命中挂起操作则 200；无会话或未知 `requestId` 为 404。
3. 连接关闭，或 `POST /api/desktop-agent/:machineId/detach`，都会 `detach`。进行中的操作以 `machine_disconnected` 结束，不再 spawn `ssh`。

同一 `machineId` 再开一条 SSE 会替换上一条。适配器 `createDesktopAgentHttpSseSession` 不依赖 `node:http`，daemon 路由只负责收发。

核心类型：`DesktopAgentHub`、`createDesktopAgentBackend`、`createCompositeRegisteredMachineBackend`、`createDesktopAgentHttpSseSession`（`packages/core/src/registered-machines/`）。

桌面 HTTP/SSE 只服务桌面 agent（`/api/desktop-agent/...`）。手机跨进程走下面的独立 `/api/device-local/...`，不复用桌面路由，也不经过 Factory。

## 路径 B — SSH Host 别名（#321）

1. 在本机 `~/.ssh/config` 配好 Host 别名：密钥登录（`BatchMode`，不会弹密码）、目标主机指纹已在 `known_hosts`（`StrictHostKeyChecking=yes`）。远端需 POSIX `sh`。
2. 让助手调用 `register_machine`：`{ machineId: "desk", label: "Desk", kind: "desktop", sshAlias: "my-desk" }`（审批后生效）。不带 `sshAlias` 且无 agent 长连时，机器只出现在列表里，永远 `connected=false`。
3. `list_machines` 会实时探测（`connected`，成功缓存 30s、失败 5s）。
4. `bash { machineId, command }`、`read_file { machineId, path, offset_line, limit }`、`copy_to_machine` / `copy_from_machine`（本地路径限工作区，单文件 ≤ 10 MiB）。

## 路径 C — 手机 / 本机工具（r5-1）

与路径 A 并列的非 SSH 附着，服务 `kind: 'phone'`。默认切片是**只读**。

1. `register_machine { machineId, label, kind: "phone", deviceLocalTools }`。`deviceLocalTools` 会出现在 `list_machines` 里（`toolId` + `available` / `needs_permission` / `unavailable`）。不带 `sshAlias`。
2. 手机 agent 与 daemon **同进程**时，`getSharedDeviceLocalHub().attach(machineId, { read })`。默认不提供 shell / copy。**另一进程**时走下面的 HTTP/SSE，不必自己拿 hub。
3. `list_machines` → `kind=phone` 且 `connected=true`。`read_file { machineId, path }` 打到该 handler，**不** spawn `ssh`。
4. 未 opt-in 时 `bash` / `copy_*` 返回 `device_local_readonly`（机器仍算 connected，但不执行）。要打开 shell 或 copy，必须同时：附着时 `shell: true`（或 `copy: true`）且 `deviceLocalTools` 里 `device_shell` / `device_copy` 为 `available`。缺一则 `device_local_readonly` 或 `device_local_tool_unavailable`。跨进程时，opt-in 写在事件流查询串 `?shell=1` / `?copy=1`（可同时）。
5. `detach` 之后 `connected=false`；若同时还配了 `sshAlias`，composite 才回退 SSH。敏感路径（`.env` / `id_rsa` / `credentials` 及 `.ssh` `.aws` `.gnupg` `.kube` `.docker`）在 handler 之前拒绝，不会推到 SSE。

### Daemon HTTP/SSE（跨进程，r5-3）

手机 agent 用 daemon bearer 接同一条 `DeviceLocalHub`（`getSharedDeviceLocalHub`），不经过 Factory，也不走 `/api/desktop-agent/...`：

1. `GET /api/device-local/:machineId/events` — SSE。打开即 `attach`（默认只读）；首条事件 `ready`，data 含 `{ machineId, attached, shell, copy }`。之后每个放行的 read / shell / copy 推一条 `event: op`，data 为 `{ requestId, kind, input }`。查询串 `shell=1` / `copy=1`（或 `true`）才登记对应 handler。
2. `POST /api/device-local/:machineId/reply` — body `{ requestId, result }`，`result` 为 `{ ok, content, exitCode? }`。命中挂起操作则 200；无会话或未知 `requestId` 为 404。
3. 连接关闭，或 `POST /api/device-local/:machineId/detach`，都会 `detach`。进行中的操作以 `machine_disconnected` 结束，不再 spawn `ssh`。

未 opt-in 的 shell / copy 在 backend 返回 `device_local_readonly`，不会出现在事件流上。已 opt-in 但工具不是 `available` 时返回 `device_local_tool_unavailable`，同样不推 `op`。同一 `machineId` 再开一条 SSE 会替换上一条。适配器 `createDeviceLocalHttpSseSession` 不依赖 `node:http`，daemon 路由只负责收发。

核心类型：`DeviceLocalHub`、`createDeviceLocalBackend`、`getSharedDeviceLocalHub`、`createDeviceLocalHttpSseSession`（与桌面 hub 分开的进程级单例）。

## 失败即关闭

离线、未注册、无 `sshAlias` 且无 agent / 手机本机工具附着 → `machine_disconnected` / `unknown_machine`，不执行任何远端命令。手机默认切片上的 shell / copy → `device_local_readonly`（或工具未 `available` 时 `device_local_tool_unavailable`）。ssh 子进程使用 `sanitizeSpawnEnv`，并强制 `ClearAllForwardings` / `ForwardAgent=no` / `PermitLocalCommand=no`；命令过 hardline；远端读写拒绝 `.env` / `id_rsa` / `credentials` 及 `.ssh` `.aws` `.gnupg` `.kube` `.docker` 目录（agent 与手机本机工具路径同样在 backend 层拒绝敏感路径）。

注意：SSH 别名由 daemon 所在主机的 ssh 配置解析；多租户部署应只在受信用户的会话中放开 `register_machine`。桌面 agent 与手机本机工具都附着在 daemon 进程内（各自的 HTTP/SSE 只是把另一进程接到对应 hub）。daemon 退出后两条长连都失效。
