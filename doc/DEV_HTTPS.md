# 本地开发的 Tailnet HTTPS

`pnpm run dev` 会读取本地 `.agent-state/dev-https.json`。本机开启后，每次启动都会等待 Next 就绪，再把指定 HTTPS 端口转发到这次实际选中的 Web 端口；端口冲突导致 Web 端口后移时也会同步。HTTP 到 daemon 的同源代理保持原样。

首次在另一台机器使用时，先安装并登录 Tailscale，然后在本地创建：

```json
{
  "enabled": true,
  "httpsPort": 23443
}
```

HTTPS 端口需要专供此项目。Tailscale 的 HTTPS 功能需已启用；未启用时请在 Tailscale 管理界面完成设置。脚本不会自动开放 Funnel、公网入口或修改 Tailnet 权限。

随后执行 `pnpm run dev`。终端提示 HTTPS 就绪后，访问地址在 `.agent-state/dev-https.status.json` 的 `httpsUrl` 字段。该文件权限为仅当前用户读写，不把设备域名打印到共享日志。状态文件只包含 HTTPS URL、本机目标端口和更新时间；不保存账户、节点清单或 CLI 原始输出。

启用 HTTPS 时，Next 仅监听 `127.0.0.1`，远程访问由 Tailscale Serve 提供。访问设备必须连接有权限访问此机器的 Tailnet。TLS 在本机 Tailscale 终止，转发到本机 HTTP；证书由 Tailscale 管理，无需将证书或私钥放进项目。Next 开发模式仍可能输出自己的来源诊断，分享整个开发日志前请检查隐私。

## 端口所有权与失败处理

成功后脚本将 `lastTarget` 写回本地配置，以便下一次识别并更新本项目原来的目标。只有空闲 HTTPS 端口，或仅包含本项目当前/上一次目标的根路径转发，才允许更新。其他服务、多路径转发、TCP 转发和 Funnel 入口会被拒绝；不会执行全局 `serve reset`。

若从手动 Serve 配置迁移，只有确认该入口属于本项目后，才将原目标填入本地 `lastTarget`，例如 `http://127.0.0.1:23000`。不要把其他服务的地址填入。

未安装/未登录 Tailscale、无权限、监听端口冲突、就绪超时、配置无效时，HTTPS 显示不可用，本地 HTTP 继续工作。失败会清除本次就绪状态文件；已存在的 Serve 配置仍保留，不会因失败去删除其他运行实例的入口。启动过程中退出会取消等待，不再配置转发。

## 持久化与停用

所有设备配置和地址只存放在已被 Git 忽略的 `.agent-state/` 中；不要强制添加这些文件。新克隆没有配置时保持普通 HTTP 启动，不会自动发布任何服务。本功能不增加环境变量。

Serve 使用后台持久化配置。退出 Lab 后 HTTPS 入口仍存在，但 Lab 未运行时不能访问。设置 `enabled: false` 只停止后续自动同步；彻底关闭此入口，请使用本机 Tailscale CLI：

```sh
tailscale serve --https=23443 off
```

macOS 若通过 PATH 的符号链接运行 CLI 发生 bundle identifier 错误，可使用 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。脚本会自动使用真实程序路径。不要执行 `serve reset`，它会影响其他项目。
