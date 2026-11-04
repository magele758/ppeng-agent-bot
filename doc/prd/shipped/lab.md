<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## lab-auth-and-route-access
控制台鉴权与接口访问隔离

daemon 不能被绕过令牌直接访问；通过 Lab 控制台使用时浏览器不需要持有令牌。
多用户场景下，普通成员碰不到管理员功能，也看不到别人的数据。

## lab-library-pages
Lab library Pages panel (list / open / share / rotate / delete / create / edit)

Add a minimal Lab Knowledge -> Pages panel over existing admin
/api/library/pages* routes. Humans can list pages, open read-only or edit
markdown, copy /pages/:shareId, rotate share (old link dies), delete
(gone from list; public HTML 404), and create new pages. Do not clone
Grok/Canvas UI.

## lab-registered-machines
Lab Settings → Tools → Registered Machines panel

Add a minimal Lab Settings → Tools → Registered Machines panel over new admin
/api/registered-machines routes. Users can list live machines (connected status),
register new machines (id/label/kind), unregister, and refresh one machine.
Show short attach hints for desktop-agent SSE and device-local SSE paths.
No Factory SSH UI. No Grok/Canvas clone.

## lab-startup-timing
Lab 会话显示启动耗时

在 Lab 会话里显示启动耗时
