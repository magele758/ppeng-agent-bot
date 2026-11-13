<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## goal-checkpoint-no-goal-once
未分配目标时进度保存只报一次

goal_checkpoint with no goal assigned must return the existing clear error once and must not be retried in the same turn. Do not invent a goal. Do not search logs. Do not weaken security denials.
恢复波里如果跑到未分配的进度保存，同一次执行仍不得再次调用进度保存，对话里仍只有一次「No goal is assigned to this execution」，不得新建目标。
种类无效和未授权的等待必须保持各自原来的失败内容，不得改写成没有目标那句错误，也不得变成成功。同一次执行不得因此把进度保存再调用到轮数上限。

## goal-evidence-review
可回退的目标交付审查

可以，那就开发一版，做好回退的方案，避免降低Agent的能力

## goal-history-toolbar-align
目标历史与标题栏按钮垂直居中

聊天标题栏里的「目标历史」没居中对齐。
选中节点：header.chat-panel-header.chat-panel-header--bot 里的 details.goal-history，data-testid=goal-history，组件 GoalHistory，在 PlayPanel 的 play-toolbar。visible_text=目标历史。bounds 高 32px。附图里「目标历史」和右边那个方框图标不在同一垂直中线，文字/三角看起来偏了。
只做对齐：
- 「目标历史」这一项（summary 的三角和文字）在工具条里与相邻按钮垂直居中，左右不要单独上移或下移。
- 展开三角和「目标历史」四个字彼此垂直居中。
- 不要改目标历史的数据和展开行为，不要改文案。

## goal-intake-hot-path
开轮不再等待目标判定和数据库锁

执行 27s · 启动 780ms · 最慢 准入 11s · 目标接入 11s · 系统提示词 271ms
看来是前面goal的问题？搞完了吗？问题修复好了吗？分多个Agent去快速开发完成

## goal-restart-resume
重启后从安全检查点继续 Goal

如果bot在执行过程中，服务重启了，之前的任务就直接停了，重启之后，也没有继续执行。开发期频繁重启时，已经停在安全检查点上的 Goal 要继续，做了一半且效果未确认的不要重做。
本切片只处理 Goal 执行。

## goal-review-default
默认按交付条件审查目标

现在是默认开启还是默认关闭的？我要默认开启才好直接对比效果

## goal-update-hidden
目标更新通知不在聊天里展示

聊天里以 [goal update] 开头的系统通知完全不展示（历史与即时都隐藏），通知仍送模型。
