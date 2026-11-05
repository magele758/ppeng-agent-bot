<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## skill-capture-dismissal
技能沉淀完成提示可收起和关闭

这沉淀了技能了，无法关闭这个，一直挡着对话框

## skill-capture-intent-confirmation
模型判断技能沉淀并在提炼前请求确认

帮我开启技能提案和自动提醒，提醒间隔先设为每 10 次工具迭代，并确认所有 Bot 的 skill_propose 都已可用。沉淀技能可以让模型判断，不用我人工去介入，如果模型判断值得记录或者去更新技能，可以给一个操作提醒的交互框，我确认之后再去提炼

## skill-capture-save
技能沉淀确认后能把正文存下来

我看现在skill沉淀的功能有问题，特别是最后存储的部分，已经失败好几次了，排查修复一下

## skill-manifest-boundary
技能能力边界

Fill gaps so enforcement is fail-closed (no silent host downgrade for high-risk tools; no skill tools/paths/network beyond Manifest; untrusted tool/web content cannot induce cwd/eval escape).

## skill-operation-card-dismissal
技能管理结果可收起关闭且不干扰对话

这个也没有关闭窗口，一直占着对话流，没办法关闭，先修复这个，然后看看其他的组件、或者对话流有没有类似的问题
这个也是
还有这个
这个也是一样的问题
这个也没有

## skill-operation-confirm-bar
技能操作确认后收成可关闭的小横条

这个我点了，就缩成一个小横条，带个关闭窗口就行了，好像沉淀的过程比较慢，会一直挡着
这怎么还蹦出来2个？
这还有问题，失败的无法关闭

## skill-pending-retry
技能待确认请求重新授权

修复下这个问题，既不能存储skill，一直不能生效了，帮我解决下这个链路的问题，把一些过度设计的安全拦截都去掉

## skill-proposals
技能提案审批

Agent 可以把总结出的经验提交成技能提案，但必须由人在 Lab 里审核批准后才会生效，
批准过的技能也能随时撤销。
