<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## play-bot-group
Bot 会话列表里的多 Bot 群聊

为什么不能把多个 Bot 拉进一个群聊？希望这个能力就在 Bot 会话列表里，能直接看见、直接用。
从这条列表可以新建群聊，并加入一个以上已有的 Bot。群聊出现在同一列表里，和单个 Bot 的会话区分开。
打开后是一份共享记录。用户发出的消息进入这份记录，成员 Bot 参与其中。之后还可以加入或移出 Bot。
单个 Bot 的会话保持原样，不要把每个 Bot 会话都变成群。

## play-context-replay
Play 上下文回放

在 Play 右侧「上下文」标签上增加回放，让用户看这块准备好的模型上下文是怎么变的。
保留色条和每块原文。可以步进或拖动到更早的快照（每一轮准备之后记一次即可）。
切到更早的快照时，色条和块内容都变成那一刻的样子。最新一格是当前的实时上下文，并标出时间或轮次。
若还没有快照，就在一轮准备模型视图时记下种类、标签、token 估算和原文。
为了记历史，不要压缩会话，也不要另写一条摘要。回放只读。

## play-context-stack
Play 右侧栏模型上下文

在 Play 对话右侧栏，现有「活动」标签旁边加一个标签，用来调试当前会话的模型上下文。
里面要有一条横向堆叠条，每一段是将要发给模型的一块上下文，不同种类用不同颜色，能看出组成和相对大小（含图例，以及 token 或字符占比）。
条下面按顺序列出每一块的实际内容，能读到系统提示、摘要、记忆附录、工作日志、用户/助手轮次、工具结果、压缩占位，以及准备视图里真正有的其它内容。长内容要能滚动或展开，不能收成没用的哈希。
这是当前会话准备好的模型上下文，不是聊天记录的第二份副本。走运行时在调用模型前用的同一套准备和预算（系统提示、折叠/摘要、微压缩占位、记忆附录、工作日志、钉住消息、普通会话 20% 上限或 Bot 会话 50/85 线，看这条会话适用哪一种）。
会话切换和一轮结束时刷新，可以有手动刷新。不要另造一套和模型所见不一致的上下文格式。

## play-feed-window
对话记录按页加载并窗口渲染

The Play chat feed (div#playMessages, class chat-feed) gets very long. The user asked
whether loading is optimized or whether every open fetches the whole transcript, and
told us to design the strategy properly.
1. Opening a session or refreshing it loads the newest page only (a bounded page, on
   the order of a few dozen messages), not the whole history.
2. Scrolling up loads the previous page and keeps the scroll position (do not jump).
   The user can reach older messages this way.
3. The DOM does not mount every loaded message at once. Window the rendered rows
   (virtual list or an equivalent window). Streaming output still appends at the
   bottom and follows the tail while the user is already at the bottom.
4. A turn that is streaming must not refetch the entire history to show new tokens.
5. Preserve scroll position when a background refresh replaces messages (same rule
   the session list already follows).
Do not change what is stored, and do not change the model prepare / context-stack path.
This is only how the Lab loads and paints the transcript.

## play-group-delete-menu
群聊行的删除收进更多菜单

这个太扎眼了，搞成iconfont，隐藏的hover菜单里

## play-rail-default-closed
对话页右侧栏默认关闭

对话页右侧栏 aside.play-rail（活动 / 上下文 / 工件 / 轨迹 / 定时）默认关闭，不要默认展开。
用户用头部已有的侧栏切换按钮手动打开或关闭；手动操作后的偏好记在本机界面偏好里（localStorage，
和会话列表收起一样），刷新还在。首次或没设置过时默认关闭。不新增环境变量。
有活动时不自动展开。窄屏下右侧栏照旧不显示。

## play-sidebar-collapse
对话页会话列表可收起

用户指着对话页左侧的会话/Bot 列表（aside#mobile-session-list.play-sidebar，在 PlayPanel 里），说这个列表也要能收起。附图是现在展开的 220px 侧栏：置顶、功能分组、Bot 和群聊。

要做成：
- 有一个明显的收起/展开控制。收起后列表不再占对话旁边的宽度，对话区变宽；再点可以展开。不要把最左侧的图标轨（lab-rail）和这个列表混为一谈。
- 收起状态记在本机界面偏好里（localStorage 即可，和语言偏好一样），刷新还在。不要新增 RAW_AGENT_*，也不必进 daemon。
- 文案走 i18n，zh 与 en 同一套 key。按钮要有可访问名称。
- 收起时不要丢掉当前会话，展开后列表和选中项还在。置顶、分组、拖拽取消置顶的行为不要改。
