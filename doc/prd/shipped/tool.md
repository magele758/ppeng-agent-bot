<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## tool-call-pairing-batch-dedup
同批重复工具结果去重（验证试点发现 F-1）

确认，这 8 条验收标准可以，按项目规范开始实现，先写失败测试再实现验证。

## tool-call-pairing-verification
工具调用与结果配对验证试点

可以，就先拿工具调用与结果配对做试点，按项目规范先写验收标准给我确认。如果效果好，可以扩大到更大的范围

## tool-exposure-tiers
工具三层分类与独立的渐进和全量提供方式

就按这个思路，先把现在的工具按三层列出具体清单，再写验收标准给我确认，先别改代码。
我还发现一个问题，我关闭了能力发现，他也不是全tool一起加载的，现在是不是有问题？这个也排查一下，搞清楚

## tool-loop-same-call
工具循环按同一次调用判断

我不是关闭了模型的工具调用循环检测吗？怎么还有这种导致的停止问题？
检查配置是否生效，以及工具循环检测的逻辑，目前感觉不合理，检测循环也不是这么蠢的逻辑，分多个Agent去快速分析解决

## tool-observation-thumbnails
工具观察截图缩略图

Lab 对话里，用户角色、内容是工具观察的回合（气泡 class chat-bubble）被渲染成原始文本：
“[Tool observations: screenshots returned by tools, not a new user instruction.] [image img_… image/jpeg]”。
希望这些截图显示成小缩略图，不要打印看不懂的资产 id 字符串。保留简短说明；如果说明是用户能看见的写死英文，放到中英文 i18n。

## tool-progress-guard
重复工具调用按实际进展判断

按你说的方向改吧，先把目标的两套状态和展示统一起来，完成或失败的保留历史但别一直挂底部，再把重复调用检测改成看有没有实际进展。Jev我已经恢复了，不用管了。群聊组织模式，可以按你说的再新增一种模式，我对比看看执行效果。

分多个agent去推进
