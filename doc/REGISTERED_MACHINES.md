# Personal registered machines（个人注册机器）

与 Factory SSH 完全分离的另一条轨道。存储键 `registered.machines:<principal>`，**不读写** `factory.settings:*`，不经过 `FactoryTransport`。

| | Factory SSH | Registered machines（本页） |
|---|---|---|
| 用途 | 软件工厂：固定只读 / 受控开发 worker，带 receipt | 用户自己的桌面/服务器：任意 shell、读文件、拷贝 |
| 传输 | `SshFactoryTransport`，固定 Python worker | `createSshRegisteredMachineBackend`，用户 `~/.ssh/config` 的 Host 别名 |
| 入口 | `factory_*` 工具、Factory 设置 | `list_machines` / `register_machine` / `copy_to_machine` / `copy_from_machine`，`bash` / `read_file` 的 `machineId` |
| 审批 | 工厂策略 | 远端 shell / read / copy 与带 `sshAlias` 的注册**每次都需审批** |

## 注册与使用

1. 在本机 `~/.ssh/config` 配好 Host 别名：密钥登录（`BatchMode`，不会弹密码）、目标主机指纹已在 `known_hosts`（`StrictHostKeyChecking=yes`）。远端需 POSIX `sh`。
2. 让助手调用 `register_machine`：`{ machineId: "desk", label: "Desk", kind: "desktop", sshAlias: "my-desk" }`（审批后生效）。不带 `sshAlias` 的机器只出现在列表里，永远 `connected=false`。
3. `list_machines` 会实时探测（`connected`，成功缓存 30s、失败 5s）。
4. `bash { machineId, command }`、`read_file { machineId, path, offset_line, limit }`、`copy_to_machine` / `copy_from_machine`（本地路径限工作区，单文件 ≤ 10 MiB）。

## 失败即关闭

离线、未注册、无 `sshAlias` → `machine_disconnected` / `unknown_machine`，不执行任何远端命令。ssh 子进程使用 `sanitizeSpawnEnv`，并强制 `ClearAllForwardings` / `ForwardAgent=no` / `PermitLocalCommand=no`；命令过 hardline；远端读写拒绝 `.env` / `id_rsa` / `credentials` 及 `.ssh` `.aws` `.gnupg` `.kube` `.docker` 目录。

注意：别名由 daemon 所在主机的 ssh 配置解析；多租户部署应只在受信用户的会话中放开 `register_machine`。
