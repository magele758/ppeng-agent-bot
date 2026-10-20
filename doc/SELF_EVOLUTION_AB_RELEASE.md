# A/B 自进化发布（Stable / Candidate）

控制面 `release-orchestrator` 驱动 **Stable（A）** 与 **Candidate（B）** 双栈发布；进化产物经 G0–G3 门禁后晋升。

## 架构

- **控制面**：`scripts/release-orchestrator.mjs`（git sync → evolution → gates → deploy → observe → promote/fix）
- **数据面 Stable**：`docker compose --profile stable` 或 Helm `ppeng-stable`
- **数据面 Candidate**：`docker compose --profile candidate` 或 Helm `ppeng-candidate`
- **报告**：`doc/evolution/reports/<release_run_id>.json` + `.md`；HTTP `GET /api/evolution/reports`、`/api/evolution/report/:id`

## 状态机

`GitSync → Learn/Run-day → G0 → Deploy Candidate → Deploy smoke → G1 → Observe/G2 → [Fix] → G3/Promote → Deploy smoke(Stable)`

部署冒烟失败会自动回滚：Candidate 失败拆掉 Candidate（Stable 不受影响）；promote 后 Stable 失败回到上一版 Stable。
细节见 [`DEPLOYMENT.md`](DEPLOYMENT.md)「自动回滚」。

## 门禁

| 关卡 | 内容 |
|------|------|
| G0 | build + test:unit + 可选 EVOLUTION_HARNESS_GATE |
| G1 | 真实 Candidate 地址的 health/readiness + candidate 只读契约 suite（不启动替代 daemon） |
| G2 | regression + integration + e2e（打 Candidate URL） |
| G3 | Bake 期满 + G0/G1/G2 全绿 + 固定 SHA/镜像身份（`EVOLUTION_RELEASE_AUTO_PROMOTE=1` 时自动晋升） |

`--force` 仅将 bake 等待缩短为 0，不绕过失败门禁。每次 start / fix / deploy-candidate 在部署前开启新的 `deployment_generation`，清空旧门禁、镜像身份与 bake；失败或中断也不能继承旧绿灯。G0 证据绑定该部署编号和源码 SHA，G1/G2 另绑定 exact image IDs/digests，G3 检查一致性。旧版没有绑定证据的报告需重新部署与验证。

分步运行的顺序为 `deploy-candidate → gate-g0 → gate-g1 → gate-g2 → gate-g3 → promote`（均传同一 `--run-id`）。deploy-candidate 会记录当前源码 SHA；G2 成功后开始新的 bake。完整 start/fix 在部署前先跑 G0，之后对新镜像跑 G1/G2。

晋级前记录并核对 Compose image IDs / Helm 已就绪 Pod 的 image digests；固定该组镜像，不重建。缺失 stable、镜像身份不一致、schema 未知或版本不同均拒绝自动晋级，先完成备份与迁移/恢复演练。晋级后的 stable 探测失败，Compose 恢复之前 IDs（绝不把 ID 当 tag），Helm 回滚之前 revision；恢复后重新核对实际镜像身份，再通过探测才记录 `rolledBack=true`。外层部署冒烟失败触发的恢复也必须重跑冒烟；命令失败、镜像不符或恢复后的冒烟失败均为 `backlog`，不能宣称恢复成功。

**Helm 旧版本前提**：回滚目标 revision 的 Deployment manifest 必须已经使用与当前 Pod 一致的 `repository@sha256:...`。如果旧 manifest 仍用 `latest` 等 tag（即使当前 Pod 有 digest），自动晋级会在变更 stable 前拒绝执行，提示先固定 stable digest。这样保留原 revision 的 chart/config 回滚语义，也避免先回滚到不确定的镜像再补救。candidate 清理仅停止/删除候选服务，保留状态卷，不执行会影响 stable 的全项目 down。

这些路径已用失败注入和命令契约测试验证，尚未在生产 Compose/Helm 集群演练。G1/G2 不是模型能力实验；新功能/系统提示词的真实模型比较见 [Harness 评估](HARNESS_EVALUATION.md)。

## 环境变量

见 `.env.example` 中 `EVOLUTION_RELEASE_*`、`EVOLUTION_CODING_*`。

## 常用命令

```bash
pnpm run release                    # 完整流水线 start
pnpm run release:git-sync
pnpm run release:status
pnpm run release:observe --run-id rel_YYYYMMDD_NNN
pnpm run release:promote --run-id rel_YYYYMMDD_NNN
pnpm run release:rollback --run-id rel_YYYYMMDD_NNN
```

## Compose ↔ Helm 对齐

| Concern | Compose | Helm |
|---------|---------|------|
| Candidate daemon | `http://127.0.0.1:37071` | Service DNS + 37070 |
| Candidate web / e2e | `http://127.0.0.1:33001` | Ingress / port-forward |
| DAEMON_PROXY_TARGET | `http://daemon-candidate:37070` | `values-candidate.yaml` |
| RAW_AGENT_AUTH_TOKEN | web-b + daemon-b 同源 | Secret 双 Deployment |
| State | `agent-state-candidate` volume | PVC |
| 切换后端 | `EVOLUTION_RELEASE_BACKEND=compose` | `=helm` |

## Coding-Agent（FixCandidate）

统一入口 `scripts/release/coding-agent.mjs`：默认 `EVOLUTION_CODING_AGENT=cmd` → `EVOLUTION_AGENT_CMD`；模型用 `EVOLUTION_CODING_*`（与 `RAW_AGENT_*` 分离）。

## 相关文档

- 能力地图：[`SELF_EVOLUTION_V2.md`](SELF_EVOLUTION_V2.md)
- Evolution 管线：根目录 `AGENTS.md` / `pnpm run evolution --help`
