<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## lab-auth-and-route-access
控制台鉴权与接口访问隔离

daemon 不能被绕过令牌直接访问；通过 Lab 控制台使用时浏览器不需要持有令牌。
多用户场景下，普通成员碰不到管理员功能，也看不到别人的数据。

## lab-auth-loading-recovery
网页登录检查可恢复

很奇怪，为什么现在在chatgpt里，网页一直加载不回来？

## lab-bootstrap-retry
工作台启动失败后恢复

这个无法进入页面的问题又浮现了，赶紧修复一下，彻底修复

## lab-library-pages
Lab library Pages panel (list / open / share / rotate / delete / create / edit)

Add a minimal Lab Knowledge -> Pages panel over existing admin
/api/library/pages* routes. Humans can list pages, open read-only or edit
markdown, copy /pages/:shareId, rotate share (old link dies), delete
(gone from list; public HTML 404), and create new pages. Do not clone
Grok/Canvas UI.

## lab-poll-crash-diagnostics
轻量会话列表与客户端异常诊断

先把会话列表每次拉 23 MB 的问题修掉，再加上客户端异常日志，下次崩溃能直接定位原因。

## lab-registered-machines
Lab Settings → Tools → Registered Machines panel

Add a minimal Lab Settings → Tools → Registered Machines panel over new admin
/api/registered-machines routes. Users can list live machines (connected status),
register new machines (id/label/kind), unregister, and refresh one machine.
Show short attach hints for desktop-agent SSE and device-local SSE paths.
No Factory SSH UI. No Grok/Canvas clone.

## lab-startup-request-load
控制台启动时的请求负担

我看现在网页启动，请求太多了，把页面都卡半天，优化一下启动速度

## lab-startup-timing
Lab 会话显示启动耗时

在 Lab 会话里显示启动耗时
