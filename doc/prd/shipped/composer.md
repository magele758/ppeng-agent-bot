<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## composer-draft-per-session
聊天输入框草稿按会话隔离

聊天页输入框里未发送的草稿，在切换到另一个 bot（或会话）后仍然显示，把在 A bot 输入的内容带到了 B bot。
需求：草稿按 bot/会话隔离：切换到 B 时显示 B 自己的草稿（没有则为空）；切回 A 时恢复 A 之前未发送的草稿
（含输入文字；附件/引用/上下文标签等 composer 状态若现有结构支持也一并按会话隔离，至少保证文字）；
发送成功后清空该会话草稿（保持现有「发送后先挂乐观气泡、再清空、再等待请求」的顺序与行为）；
刷新页面若项目已有草稿持久化机制则沿用并按 key 隔离，否则内存级即可。
注意流式进行中切换、新建会话、语音输入（麦克风）回填等边界。

## composer-drop-retirement-soak-isolation
退役消息框拖拽并独立验证 HTTP soak 性能

那就把拖拽功能整体去掉，保留加号附件入口，相关验收和测试一起退役。其他核心测试保留，HTTP soak 的性能检查单独跑，先给我验收草案。

## composer-ime-enter
输入法确认回车不发送

While the user is composing Chinese with an IME, pressing Enter to confirm a candidate (including an English word picked from the IME) sends the unfinished message. Enter during composition must NOT send.
After composition has fully ended, Enter sends as today. Shift+Enter inserts a newline and does not send, if the composer is a textarea or can be one. If it is a single-line input, keep it single-line but still do not send during IME.
Do not clear the draft on a swallowed Enter.

## composer-quote-layout
输入栏中线对齐与不占行的消息操作

这里的中线都没对齐
把那个hover显示引用的按钮，改成不要占位的，现在空的一行行的太丑了
