<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## compact-archive-pointer
压缩摘要带上原文位置

runAutoCompact 成功做闭区间 replace 时，把归档相对路径写进同一条 summary。有记忆附录时 working-log tail 不会贴上，所以路径必须在摘要正文里，不能靠另一条 appendix。
摘要空则 empty_summary 跳过。这段逻辑不要改。
在 replace 之前拿到 archive 路径。路径要同时出现在 replacement 的 text 和 session.summary 里。
没有路径（archive 未提供或返回空）时，摘要文本与今天一致。
有路径时加一两行，说明这是被压缩掉的原文位置，只在摘要缺了具体代码或报错时再读。不要把归档正文塞进摘要。
如果 compact 的 archive 没返回模型能 read_file 的相对路径，让它返回这种路径，再让 auto-compact 写进摘要。

## compact-bot-secondary-tabs
精简 Bot 能力与权限及记录页

其他2个tab的也这么改一下

## compact-bot-settings
Bot 设置优先展示基本信息与已有定时任务

这个界面太臃肿了，核心信息全部被档到下面，定时任务新增应该要隐藏到二次弹窗里，已有的定时任务和基本信息在第一个tab里前置展示，其他的配置，非必要就隐藏或者折叠起来

## compact-reply-spacing
同一次回复中的相邻段落保持紧凑

这个会话一直看着很难受，怎么空行这么大，帮我优化一下这个对话流的界面
