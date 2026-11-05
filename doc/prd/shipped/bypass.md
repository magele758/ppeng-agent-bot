<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## bypass-full-auto
bypass 全自动与重复审批修复

之前审批弹窗的优化也继续做完，要清楚告诉我具体执行什么、为什么有风险，反复申请审批的问题也一起查清楚修掉。
改一下，bypass全自动，不然叫什么bypass？

## bypass-remote-shell
bypass 下不再为无隔离反复审批，远端查找不被本机浏览规则拦住

我给4090的bot已经配置了bypass权限了，怎么还是一直在申请权限，还有ssh那边一直完成的不好，帮我排查一下原因
优化一下这个问题

## bypass-skill-write
bypass 的 Bot 写技能不再被额外确认拦住

正式 skill 的文件写入由 approve() 完成，写入路径为 stateDir/skills/.bots/<botSkillId>/SKILL.md。

但 skill_manage 的成功分支里没有调用 install、approve、distill 或 generator。因此 skill_manage 的持久化方式与提案存储不同。

需要先确认 skill_manage 的成功路径，避免给用户错误的文件位置。

skill存储的问题看起来还是没搞定，帮我排查彻底解决一下
而且我的bot是bypass权限怎么还有这种限制，skill写本来就不该拦截，何况是bypass的bot
还有什么其他的类似的问题，不该拦截的就帮我一起排查修改一下，这种逻辑都是矛盾的，分多个agent去排查和解决类似的问题，快速解决

## bypass-source-scope
permissionMode=bypass 视为用户显式授权，不再被来源范围拦截

会话已保存 permissionMode=bypass 且当前来源权威为用户直接输入时，来源范围检查放行，
不因外部暴露(如 bash 输出外部标记)或缺少 scope 而 source_scope_denied。
