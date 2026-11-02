# 用户配置存储审计（2026-11-02）

长期用户偏好以 SQLite daemon_control 为准，按 tenantId/userId 分区。入口 GET/PATCH /api/user/preferences，逐字段 PATCH，null 是显式恢复默认的墓碑。浏览器首次连接只迁移数据库尚无的字段；旧浏览器不能覆盖数据库已有字段。网络失败保留待写入值并重试；页面每三秒读取最新偏好。

| 分类 | 字段 | 存储 |
|---|---|---|
| 外观 | theme、lab.skin、lab.fontSize | 数据库 + 首屏缓存 |
| 语言 | lab.locale | 数据库 + 首屏缓存（本次用户要求取代此前仅本地约定） |
| 设置与对话偏好 | lab.settings.advanced、agentLab.sendAckSound、lab.sessionBrief | 数据库 |
| 新手引导 | lab.botFirstTaskSent、lab.botFirstTaskDismissed 及旧逐 Bot dismissed | 数据库 |
| 技能提示已忽略 | lab.skillCaptureDismissed.*、lab.skillOperationDismissed.* | 数据库 |
| 置顶与排序 | lab.botPins | 已有独立 /api/bot-pin-settings，数据库 |
| 窗口布局 | lab.railCollapsed、lab.playSidebarCollapsed、lab.sessionBriefOpen | 本地；不同屏幕/窗口可独立展开 |
| 当前导航 | lab.selectedBot、play surface | 本地；避免另一个浏览器跳走 |
| 正在编辑 | lab.botFirstTaskDraft、lab.botFirstTaskAnchor | 本地；避免覆盖另一窗口未发送输入 |
| 阅读活动 | recap seen/activity | 本地；用于当前窗口的阅读与活动判断 |
| 临时提醒 | 模型引导 sessionStorage dismissal | 当前标签页；未配置模型时新会话应继续提醒 |

旧数据只能在持有它的浏览器访问新版本时迁移，服务器无法读取从未重新打开的浏览器。冲突时数据库已有字段优先。浏览器缓存记录所属用户，切换用户时不迁移前一用户缓存。

新增用户配置应通过 preferenceStorage 写入并同步扩展服务端/客户端白名单及测试；不要直接新增 localStorage 配置写入。两个白名单由一致性测试约束。
