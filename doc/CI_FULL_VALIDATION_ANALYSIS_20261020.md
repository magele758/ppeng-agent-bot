# Actions 耗时与检查分工分析（2026-10-20）

## 数据口径

数据来自 GitHub Actions API：最近100次 workflow 记录，以及最终 main f731a413 的三次 Full validation 的 job/step 时间。CSV按耗时降序保留全部100条，包括失败和取消。workflow 的 observed elapsed 为 run_started_at 到 updated_at，可能含排队、取消等待及记录更新延迟；不能冒充 runner 计费分钟或成功完整验证耗时。下表 job 为 started_at 到 completed_at，并行 job 不能相加作为墙钟耗时。所有时间安排说明采用北京时间。

## 最新一次 Full validation：39319564695

[完整运行](https://github.com/magele758/ppeng-agent-core/actions/runs/39319564695)，北京时间10月20日04:28:13触发，04:53:30结束，观测总时长25分17秒。

| Job（降序） | 实际运行 | 结果 | 最慢 step |
|---|---:|---|---|
| agent-loop tests + CRAP gate | 24分23秒 | failure | Unit tests with V8 coverage: 23分32秒 |
| mutation / Mutate (hardline-1) | 19分42秒 | success | Run mutation tests: 18分54秒 |
| mutation / Mutate (hardline-2) | 19分09秒 | success | Run mutation tests: 18分19秒 |
| mutation / Mutate (hardline-3) | 14分05秒 | success | Run mutation tests: 13分18秒 |
| mutation / Mutate (others) | 10分51秒 | success | Run mutation tests: 10分04秒 |
| Browser and HTTP regression | 4分49秒 | failure | E2E (Agent Lab): 3分03秒 |
| Build, unit tests, HTTP regression, E2E | 2分07秒 | success | TypeScript build: 1分00秒 |
| mutation / Mutation gate | 0分37秒 | success | Run pnpm install --frozen-lockfile: 0分19秒 |
| Acceptance criteria gate | 0分33秒 | failure | Install dependencies: 0分16秒 |
| Main release gate | 0分11秒 | failure | Run actions/setup-node@v4: 0分05秒 |
| Check remote-smoke secrets | 0分05秒 | success | Run actions/checkout@v4: 0分02秒 |

## 三次固定候选的结果

| Run | 触发 | 北京时间 | 观测总时长 | 结果 |
|---|---|---|---:|---|
| [39293327505](https://github.com/magele758/ppeng-agent-core/actions/runs/39293327505) | workflow_dispatch | 2026/10/20 01:20:52 | 20分11秒 | failure |
| [39303478796](https://github.com/magele758/ppeng-agent-core/actions/runs/39303478796) | schedule | 2026/10/20 02:33:26 | 25分18秒 | failure |
| [39319564695](https://github.com/magele758/ppeng-agent-core/actions/runs/39319564695) | schedule | 2026/10/20 04:28:13 | 25分17秒 | failure |

三次均为同一候选。覆盖率单测在 domain-stores.test.js 的三条断言处因手写旧表缺少 reply_to_json 失败；formal、SDK coverage 和 CRAP 步骤因上游失败未执行。其缺少产物报错是连带结果。浏览器失败点为 factory-http-integration.spec.ts 创建 Bot：全套E2E共用daemon，前序测试累计到50个普通Bot上限，隐藏Bot仍计数；单独执行该文件会通过。验收聚合和最终发布汇总因此失败。这些运行不能用来声称独立 Formal 步骤或 CRAP 已通过。不过覆盖率单测内部已经包含真实进程/formal 相关验证，不能把独立步骤未执行理解成相关逻辑完全没跑。最慢的真实多进程验证单条测试334.48秒、重启恢复173.95秒、互斥准入/交接94.05秒，确实是主要耗时来源之一。

## 历史 workflow：最长15条观测时长

完整100条见 CI_ACTIONS_DURATIONS_20261020.csv。取消记录单列结果，不混作成功样本。

| Workflow | Run | 观测时长 | 结果 |
|---|---|---:|---|
| Docker nightly | [39255304328](https://github.com/magele758/ppeng-agent-core/actions/runs/39255304328) | 196分21秒 | cancelled |
| CI | [39254883578](https://github.com/magele758/ppeng-agent-core/actions/runs/39254883578) | 112分54秒 | success |
| CI | [39255292876](https://github.com/magele758/ppeng-agent-core/actions/runs/39255292876) | 109分57秒 | failure |
| CI | [39268196442](https://github.com/magele758/ppeng-agent-core/actions/runs/39268196442) | 107分27秒 | failure |
| CI | [39255011464](https://github.com/magele758/ppeng-agent-core/actions/runs/39255011464) | 106分57秒 | success |
| CI | [39254826210](https://github.com/magele758/ppeng-agent-core/actions/runs/39254826210) | 106分11秒 | success |
| Mutation | [39254883529](https://github.com/magele758/ppeng-agent-core/actions/runs/39254883529) | 94分04秒 | success |
| CI | [39257286641](https://github.com/magele758/ppeng-agent-core/actions/runs/39257286641) | 93分33秒 | failure |
| Docker nightly | [39254576089](https://github.com/magele758/ppeng-agent-core/actions/runs/39254576089) | 93分02秒 | success |
| CI | [39255299472](https://github.com/magele758/ppeng-agent-core/actions/runs/39255299472) | 85分41秒 | failure |
| CI | [39272276037](https://github.com/magele758/ppeng-agent-core/actions/runs/39272276037) | 81分06秒 | cancelled |
| CI | [39254821292](https://github.com/magele758/ppeng-agent-core/actions/runs/39254821292) | 79分52秒 | success |
| CI | [39254878642](https://github.com/magele758/ppeng-agent-core/actions/runs/39254878642) | 79分45秒 | success |
| CI | [39272984813](https://github.com/magele758/ppeng-agent-core/actions/runs/39272984813) | 74分37秒 | cancelled |
| CI | [39255006791](https://github.com/magele758/ppeng-agent-core/actions/runs/39255006791) | 73分59秒 | failure |

## 建议的检查分工（方案，尚未改变批准的范围）

| 场景 | 检查 | 阻止什么 |
|---|---|---|
| 每个 PR 当前 head / main push | Quick gate：源码审查指纹、工作区编译、Lab 类型、短关键回归、静态验收映射；实际执行120秒内，排队单列 | Quick 缺失/失败/超时或 review 未解决，禁止普通合并 |
| 每两小时固定 main SHA（现有安排） | 全量覆盖率单测、SDK coverage 与 CRAP、formal/真实进程与反向控制、四片 mutation、HTTP/integration、完整 E2E、结果型验收聚合 | 候选任一失败或缺证据，禁止发布；普通提交不重复启动全套 |
| 发布候选 / 手动立即验证 | 同一完整检查；候选源码、依赖、工具链与配置匹配的完整证据可严格复用；候选不同则重跑 | 发布入口要求实际候选完整通过，不能借用别的 SHA 或 Quick 绿灯 |
| 发布产物 | npm tarball 消费测试、容器构建/启动 smoke、不可变包/镜像摘要和候选绑定、部署后的 readiness/回滚 smoke | 禁止发布或推广有缺陷的产物；现场验收另外保留 |

实施建议：优先将单测、formal、SDK/CRAP作为可独立报告的并行职责；formal不应因为无关单测失败就完全没有执行机会。保留单测覆盖率仅采一次，不在其他 job 再跑一遍全部功能测试；严格输入一致的 formal 证据才复用。Mutation继续四片并行，每两小时完整执行，不把慢检查直接删除或移走。普通冒烟与真实发布 SLO/soak 分开，禁止降低正式阈值。无源码变化时可讨论严格复用或去重，但需保留每两小时执行原范围的已批准标准；在批准调整前仍每两小时完整执行。

定时 cron 当前为 UTC 17 */2 * * *，北京时间计划落在偶数小时的第17分钟。GitHub schedule存在延迟，实际触发可晚于计划；本次两轮实际在02:33、04:28开始，不能承诺整点准时。发布时使用手动触发，不等下一轮定时。

上述职责拆分属于后续方案；本次只修复已批准验证范围内的确定失败及复核发现的引用分叉缺陷，不改变触发频率、覆盖范围、阈值或发布判定。

## 本轮修复与复核

- `domain-stores.test.js` 原来单独手写旧版表，新增引用字段后3条既有测试稳定报错；保留全部断言，改用生产 `SqliteStateStore` 的建表和迁移初始化。先复现失败，再确认21项测试通过。
- 工厂HTTP用例的完整浏览器基线为201通过、1失败，响应明确为400 `Bot roster cap reached (50)`；单独运行该文件2项全部通过。改用真实默认Super Bot作为协调者，保留自己的Room、机器策略、任务、幂等性、证据、UI和取消断言。修复后完整浏览器202项一次通过，无重试。
- 后续CRAP补跑发现 `SessionStore.copyWalPrefix` 的新增引用分支无覆盖，复杂度由6增至7，原基线42变为56。失败测试进一步确认SQLite和内存fork复制引用后仍指向父消息。已修复为子消息ID映射，并同步SDK文档；没有上调CRAP基线。
- 安全复核捕捉到分叉重映射与共享撤销的交互。六个真实双kernel反例先失败，随后fork继承裁剪到复制边界的撤销约束，并封闭active/pending历史曝光；不继承共享成员资格、不改父状态，新子会话消息正常使用。无法持久化约束的host在创建子会话前拒绝。
- 最终专项66项通过，SDK416项及构建通过，本地CRAP恢复通过，纵向与独立安全/对抗review未发现遗留P1/P2。生产改动仅限引用分叉与可见性约束；未修改容量上限、工作流频率、验收标准或阈值。
- 第一版修复候选b722b93a的完整运行39334705519在构建/打包、浏览器+HTTP通过后主动取消，因为后续复核发现还需修正上述分叉与CRAP问题。取消记录和旧失败全部保留，不作为完整通过。
- 完整覆盖率、formal、SDK/CRAP、mutation及结果型验收仍需对修复候选实际执行成功；局部与浏览器通过不代表完整发布就绪。
