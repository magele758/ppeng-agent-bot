<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## secure-form
对话里的单字段安全表单

用户在对话里填写一次性验证码、密码、卡号或 CVV，而不是走浏览器 vault_fill。
模型只收到填写状态和一条不透明的 uvref。明文只进 UserVault，不进模型上下文，也不进对话文本。
这条路径与 vault_fill（浏览器会话填表）和 SecretVault（连接器环境变量）分开。

## secure-form-multi
对话里的多字段安全表单

用户在对话里一次性填写多个验证字段（如卡号和 CVV），而不是分别填写。
模型只收到多个字段的填写状态和对应的不透明 uvref。明文只进 UserVault，不进模型上下文，也不进对话文本。
保持单字段向后兼容；多字段和单字段共用同一接口。

## secure-form-short-digit-leak
短数字验证码不因编号或时间被误判为泄露

修复安全表单回执检查把短数字秘密误判成泄露的问题。
短数字秘密不能因为嵌在 id 或时间戳里就判泄露；真正作为独立值出现仍要拒绝。
卡号 4111111111111111 和更长密码仍必须被拒绝。
不要把该测试加进已知抖动名单，不要放宽验收标准，不要删测试。

## secure-form-vault
Secure Form fill-from-Vault

Lab Secure Form card can pick a saved UserVault login or card entry and map fields
by match (username/password/otp, cardNumber/cvv). Daemon POST /secure-form accepts
vaultEntryId (and entryId alias) while keeping legacy value/values. Port resolves
uvref: server-side; receipts stay fillRefs; plaintext never enters the model or
transcript. Separate track from browser vault_fill.
