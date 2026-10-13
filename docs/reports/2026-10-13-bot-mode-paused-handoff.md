# Bot 模式暂停交接（2026-10-13）

用户先要求暂停供自行检查，随后限定先修复未通过的回归。现按该范围完成修复及相关复验，停止继续开发和长测。

## 当前候选与修复

- 工作区：`/workspace/ppeng-agent-core`，分支 `work`，HEAD `96d55dc449c776ae4627c570d3fa561cfdd70893` 只是开发基线；实现仍为未提交工作区变更，不可把该 SHA 当作已包含开发成果。
- round15 构建成功，日志：`test-results/bot-validation/build-round-15.log`。
- 修复关闭数据库后连续对话迟到回调再次写数据库而报错的问题。
- 修复配置 inbox overflow 时，摘要已进入模型输入后原始输入回执仍未消账的问题。回执关联真实摘要 inbox、key 和序号，在实际准备的输入随后完成模型轮时才确认；不通过文本匹配推断读取。补测摘要替换、未领取摘要不能提前确认及关闭进程边界。
- 修正容量回归的测试构造：原 `updateBot` 不支持修改 `agentId`，现建立并确认真实别名绑定，计数 3、429、隔离及去重断言保持不变。
- 修正审批 TTL 测试跨毫秒时钟抖动，同步持久化使用同一测试时钟；600000 毫秒精确断言保持不变，未修改产品 TTL。

## 本轮实际验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| round15 构建与类型检查 | 成功 | `test-results/bot-validation/build-round-15.log` |
| 连续对话、真实 HTTP、关闭边界、overflow、steer/inbox、Routine、BotWork | 77/77，0 失败、0 跳过 | `test-results/bot-validation/human-continuation-and-compat-round15.log` |
| 可靠通信、身份、Super Bot、daemon 路由及兼容专项 | 131/131，0 失败、0 跳过；基于 round14 构建，之后 A 的生产模块未修改 | `test-results/bot-validation/a-round14-all-fixed.log` |
| 长历史、记忆及隔离 HTTP 修复专项 | 71/71；基于 round13 构建 | `test-results/bot-validation/g04-round13-history-memory-http-targets.log` |

失败记录保留，包括 round14 原始失败及关闭/overflow 的先红后绿证据。按用户暂停要求，未重新启动全量单测、完整浏览器套件、完整性能或 24h 测试。此前全量回归的结果仅属于当时候选，不能据此宣称 round15 已完成全部发布门禁。

## 尚未完成及待复查

- 完整性能协议：上一真实 HTTP 负载积压、内存升高，驱动固定时间窗也有缺陷，已停止；没有完整通过报告。新固定窗口驱动有专项自检，未完成最终候选完整负载。
- 24h soak：未完成；此前无效测试已停止，不计为通过。
- 当前会话缺少 computer-use 工具接口；实际 CUA 未运行。已有浏览器自动化证据不替代 CUA。
- 真实模型质量、真实软件环境及标准参考硬件验收仍缺资源或证据。
- overflow 摘要与原回执共用队列容量时是否有额外重复计数，属于尚未实证的独立复查点；不是本次 `4 != 3` 测试失败的原因，不宣称已经排除。
- v1 交接源码包是 round12 时间点，未包含后续修复；当前候选请查看本工作区，不使用 v1 包作为最新版本。

发布结论仍为 **No-Go / 未完成商业级发布验收**。没有部署、合并、发布，也未变更 Mac 本地服务；Mac checkout 的升级情况不能由本 workspace 成果推断。
