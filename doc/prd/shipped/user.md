<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## user-message-actions
自己发送的消息支持复制和重试

现在有时候，会因为网络问题，导致请求失败，帮我在我自己的会话的部分加一个 hover 菜单，里面可以复制、重试

## user-preference-sync
用户长期偏好入库与迁移

排查一下还有哪些用户配置只存在浏览器里，应该存数据库的都改成存数据库，避免再出现这种跨浏览器不一致的问题，已有的数据要迁移过去

## user-vault-ref-fill
User Vault reference fill (distinct from secret-vault)

Product user entries (login / card / contact) live in UserVault, typed apart from
SecretVault (connector/env injection). Password and card number/CVV never enter
model-facing list or fill reports; computerUse/forms fill by opaque uvref tokens.

## user-vault-tools
User Vault assistant tools and Lab reference-fill

Ship UserVault product surface: vault_* assistant tools + Lab/product card fill UX aligned with Grok Vault reference-fill (uvref). This is product Vault entries, NOT SecretVault.
