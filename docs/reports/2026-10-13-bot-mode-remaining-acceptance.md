# Bot 剩余验收与环境交接

最新状态：按用户要求完成失败回归修复后暂停，没有后台长测。见 [round15 暂停交接](2026-10-13-bot-mode-paused-handoff.md)。下文启动记录为历史记录，不能据此判断测试仍在运行。

日期 2026-10-13，用户时区 Asia/Shanghai；原始日志时间使用 UTC。仅继续已批准 G01–G19 / W0–W8，不增加跨会话正文检索、不改变任务可见性。

## 完成边界

[本地实现和验证报告](2026-10-13-bot-mode-implementation-review.md) 的 round12 单测、Playwright、故障、迁移、CRAP 结果保持有效；W8 从未完成。停止一次回复不能解释为发布目标完成。新增加的验收脚本不属于 round12 旧测试覆盖，单独记录自身验证。

## 条件与阻塞

| 剩余项 | 当前条件与下一步 | 是否等待用户权限/资源 |
|---|---|---|
| 完整性能 | 实际 cpu.max=400000/100000，即4核总配额；memory.max=16GiB；overlay磁盘不能证明SSD。仓库.nvmrc=22，实际测试Node v24.19.0（package engines允许>=22），原参考协议版本亦未匹配。原store benchmark未覆盖HTTP/auth/排队/真实状态API和浏览器首屏。补HTTP验收工具，并与长测串行；现环境结果只能补充，不能当4CPU/8GiB/SSD参考机通过 | 非破坏性免费工具补齐无须新批准；标准硬件尚缺，需已有合规免费资源或另行决定资源方案。不能自行付费置备 |
| 24h | 已启动原runner完整30分钟预热+24h测量，保留原负载及最多120秒排空，见下文；它有协议覆盖缺口，不能成为完整W8通过证据 | 当前补充测试没有权限阻塞；完整协议仍需HTTP/UI/进程树等验收工具及资源。环境若提前结束则协议未完成 |
| 真实模型质量 | 没有配置RAW_AGENT_API_KEY/RAW_AGENT_MODEL_NAME/OPENAI_API_KEY/ANTHROPIC_API_KEY等所需模型变量；只检查变量名是否配置，不读取或输出密钥。需每个支持模型3次、200轮/12压缩/100事实及原召回门槛 | 缺指定支持模型及已授权使用的免费/既有可用连接。不得创建或传输凭据、默认进行付费调用；用户无需在聊天粘贴密钥 |
| 真实软件/OS | 已有受控HTTP/MCP及Linux测试；没有Mac/Windows桌面和真实软件支持矩阵执行证据 | 缺相应隔离测试环境、测试账户/已授权非外发动作；真实外发、付费、凭据或安全设置变更必须另行授权 |
| computer-use | 本会话工具清单没有computer-use/浏览器控制所需Node REPL；Playwright不能替代 | 本会话环境阻塞，不推断其他环境不可用。可在已有CUA环境按交接包复核；访问/转发若需要环境变更，另行决定 |
| 不可变候选 | work分支HEAD仅是开发基线，工作区有实现变更；用完整源码归档及逐文件hash交付 | 生成本地快照不需提交/合并/发布。不可将基线SHA误报为已含开发成果 |

无需等待上述资源决定即可继续本地补充验收、保存证据和准备交接。若要解除真实环境阻塞，最小输入是已有可用测试环境/支持模型与软件矩阵、允许的免费测试范围；不需要用户重新批准原功能实现，也不请求秘密凭据。

## 首轮长时运行记录（已判无效并提前终止）

- 隔离目录：/workspace/bot-soak-full-20261013-round12。
- 启动：2026-10-13T11:07:45.658Z（北京时间19:07:45）。runner PID 87812，监督进程 PID 87805。
- 首个种子装载后工作：2026-10-13T11:10:28.438Z，百万历史装载约163秒；最终准确seedSeconds以report为准。
- 命令：/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/bot-release/soak.mjs --out /workspace/bot-soak-full-20261013-round12/report.json --state-dir /workspace/bot-soak-full-20261013-round12/state
- cwd：/workspace/ppeng-agent-core；完整配置、环境变量名、参数和硬件在launch.json。软件只调用本地loopback服务，模型为确定性adapter，无真实外发、付费或真实凭据。
- workload：scripts/bot-release/workload.v1.json，未用smoke或缩短参数。完整时间结束预计不早于北京时间10月14日19:40，加排空时间；不是承诺成功。
- 指纹：fingerprint-before.json含core/daemon source+dist及runner/workload逐文件SHA256，总hash c6c662300ea89c7064605f2f17c2fbb6c88e0f171d9339b53b287b85a34fe6a0。结束自动生成fingerprint-after.json及completion.json。
- 观察：monitor.jsonl每60秒记录存活/RSS/剩余磁盘；health-latest.json、health-15min.json为只读数据库状态观察；runner.log为运行日志。运行中不能因为尚无error日志就判定成功。
- 磁盘保护：隔离observer每15秒检查可用空间，低于1GiB仅向本runner发SIGTERM；150秒仍未退出再SIGKILL，写resource-stop.json，保留数据。此情形是resource-exhaustion、协议未完成，不是通过，也不降低负载。

明确偏差：reader直接store，firstScreen由page耗时代替；RSS为runner自身而非daemon及工作子进程总和；百万原文在同Bot的独立历史corpus，活跃canonical最初为空；参考机不匹配。因此即使满24h无错误，也只增加内部runtime/store稳定性证据，W8仍需完整协议。

监控示例（只读）：

```bash
cat /workspace/bot-soak-full-20261013-round12/launch.json
tail -n 3 /workspace/bot-soak-full-20261013-round12/monitor.jsonl
ps -p 87812 -o pid,etime,rss,stat
```

最终必须同时检查report.json、completion.json、指纹一致、实际duration、负载/队列/副作用/RSS/错误，不能仅检查exitCode。若出现resource-stop.json则不得接受完整时长。此段保留启动时的监控说明；最新状态为下文“提前终止”，不能当作仍在进行的有效24h验收。

## CUA与源码交接

具体隔离启动、清理、合成fixture和逐屏操作见 [CUA交接文档](bot-cua-handoff.md)。源码包与证据索引位于 /workspace/bot-acceptance-handoff；最终校验值见candidate.json及SHA256SUMS。只在共享workspace生成本地文件，没有上传外部服务或传输到Mac。

源码归档来自完整tracked及未忽略新源码，包含lockfile和合成fixture；排除.git、node_modules、真实环境文件、运行数据库和忽略的构建目录。接收方按lockfile装依赖并构建候选，核对源文件manifest。重建后的产物应另存新指纹，不能沿用本机产物已验证的声明。

发布判断保持No-Go；完整性能、完整24h、真实质量/软件和CUA完成前不得把全部工作包标为完成。

## 15分钟观察发现（不是通过结论）

2026-10-13T11:22:46.482Z，runner仍存活，但Room顶层accepted未完成已146项、completed仅31项；前一观察时待完成13项。该增长不能用“进程活着”掩盖。目前排查控制模型operation关联、harness调度驱动和实际产品瓶颈，尚未定根因。计数仍在预热期，不提前宣称测量期达到2/s或120秒排空。

同主机有短暂CUA辅助实例HTTP自检，窗口11:14:42.066610–11:14:43.926414及11:15:40.605533–11:15:42.402175 UTC；没有浏览器/build，但属于共享资源干扰。有效启动/清理证据为test-results/bot-cua-http-smoke-v2.json及.log，首轮清理PID观察不足不采用。CPU/磁盘受共享测试影响的本机数据不作为标准硬件性能证明。

## 本轮补充长测提前终止

2026-10-13T11:28:26.740Z，仅向runner 87812发送SIGTERM，按原120秒上限排空；未调低负载、未修改被测产品，也未把该轮计为通过。

已经确认测试oracle缺陷：Super收到持久任务完成通知后，controlled adapter把通知中的operation标识当成新的软件任务；60个重复HTTP请求全部来自Super（52读、8写），fixture ledger去重掩盖了重复写效果。这不是已证实的产品自动重放。另有发生器实际仅约1.158个顶层任务/秒、Room和Super待处理队列增长，无法证明既定2/s稳定性或120秒排空。Room具体瓶颈仍需分离harness与产品分析，不凭此直接宣布产品根因。

原脚本和workload实物保存在隔离根runner-snapshot/；abort-reason.json、diagnostic-queue-growth.json、diagnostic-room-operation-association.json、diagnostic-duplicate-requests-summary.json保留完整判定。旧轮次状态为invalid-harness / NOT PASS / full protocol incomplete。脚本运行满24h也不能补出原W8证据，因此停止无效负载，修正真实HTTP测试驱动后重新验收。

## 真实HTTP负载器冻结及后续

新验收工具 scripts/bot-release/http-load.mjs、http-load-daemon.mjs 及operation helper已完成独立复核。test-results/bot-validation/http-load-harness-test.log：4/4，含启动失败留报告、收到final后异常退出拒绝通过、历史operation错关联反例。最终小fixture http-load-smoke.json：80预热读+200测量读，写4/2/2/2，15项接收均核对结果完成，模型最多2轮/run，2次审批等待≥5秒，9条持久结果通知只ack不调用软件，原始软件key重复为空，child exit0。仅作为工具正确性测试，不作为完整性能验收。

完整命令：node scripts/bot-release/http-load.mjs --out /workspace/bot-http-load-full-round12/report.json。默认百万实际canonical历史、20HTTP客户端40RPS、300秒预热+900秒测量、四类混合写2/s。运行由隔离supervisor在旧轮次退出、磁盘/指纹检查通过后串行启动；状态以该目录launch/report/completion为准，不能把本段命令存在当成执行通过。说明见doc/BOT_HTTP_PERFORMANCE.md。

完整HTTP 24h工具仍在补齐：需有界直方图、SQLite持久operation/result账本、小时突发热点、进程树RSS采样及窗口、持续队列趋势和排空。不会简单把20min脚本改长时间就声明完整协议。此工作属于已批准W8验收工具，不改变产品功能。

## 交接快照 v1（已生成并校验）

2026-10-13T11:32:55.082981Z，从work分支脏工作区生成1819文件完整快照。源码归档 /workspace/bot-acceptance-handoff/bot-round12-source.tar.gz，SHA256：63bcee7fdbb214adb39cbd9ce6227899f08bb8cba873ff754071f572f5f2a0bb。该归档固定保存当时产品和已冻结HTTP/CUA工具，不包含之后仍在开发的24h专用工具。candidate.json、source-files.sha256.json、runtime-files.sha256.json及SHA256SUMS描述准确候选，全部校验通过。

同目录evidence-index.json逐项映射19个Gap/9个工作包；bot-round12-evidence.tar.gz包含56个证据条目（含manifest），README.md包含解压/校验/依赖/构建/启动/清理。后续测试状态需要看新增报告，不能把快照采集时间当成最新状态。

修正HTTP完整负载于11:33:01Z由supervisor 89446启动（准确runner/child时间见 /workspace/bot-http-load-full-round12/launch.json）。命令、产品和harness指纹、15GiB启动/1GiB中止磁盘阈值均保留，当前不是完成或通过声明。
