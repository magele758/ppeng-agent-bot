# 对话附件：开源调研与功能设计

2026-11-16 · 设计提案。依据为项目官方文档、公开源码和本仓库当前源码，未逐款安装实测。

## 用户拿到什么

从桌面拖入文件，等于给当前消息附上一份只读参考。点击发送后，Agent 当轮可以用它回答，同一会话以后也能按需重读上传时的版本。用户通常只需提出问题，系统根据格式、内容长度和模型能力决定怎样读取。上传本身不授予修改电脑原件的权限；需要改文件时可以另行生成副本。

例如一起拖入故障截图、服务日志和配置文件，问「截图里的错误最早在什么时候出现，当时超时设了多少？」截图走视觉输入，短配置直接提供正文，长日志先搜索错误码，再读取命中附近的行。答案应能回到截图、配置行和日志时间戳。隔几轮问「同一错误后来又出现过吗」，仍可搜索同一份日志。

## 开源产品如何使用文件

| 项目与入口 | 经官方资料核对的行为 | 对本产品的启发 |
| --- | --- | --- |
| Aider，终端 | 用 `/add` 加入可审阅或编辑的文件，`/read-only` 加入只读材料，`/ls` 查看当前文件，`/drop` 释放上下文。视觉模型可用 `/paste` 接收截图。[命令](https://aider.chat/docs/usage/commands.html) · [图片](https://aider.chat/docs/usage/images-urls.html) | 明确文件的使用权限，用户随时能看见哪些文件参与对话。 |
| Gemini CLI，终端 | 显式提及 `@文件` 时读取并加入当前提问。读取实现对截断文本给出继续读取的指引，图片和 PDF 可作为独立内容部分处理。[命令](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md) · [读取实现](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/read-many-files.ts) | 用户指定的材料本轮就要可用，同时保留继续深读的入口。 |
| Cline，CLI | 输入解析区分图片与普通文件。图片读取成图像数据，普通文件保留路径，两者在提问里都有具名占位。[输入解析源码](https://github.com/cline/cline/blob/main/apps/cli/src/runtime/prompt.ts) | 界面可用一致的附件卡，底层采用各格式适合的读取方式。 |
| Continue，IDE | Agent 模式沿用聊天输入框的上下文选择，可引用工作区文件、函数或类，也可把编辑器中选中的代码加入对话。[Agent 模式](https://docs.continue.dev/ide-extensions/agent/quick-start) · [上下文来源](https://docs.continue.dev/customize/deep-dives/custom-providers) | 支持对具体材料和片段提问。工作区路径引用可在后续作为独立来源。 |
| OpenHands，Agent Canvas | 上传规范要求文件写入会话对应的工作目录。消息图片显示缩略图，可放大查看。[工作区上传规范](https://github.com/OpenHands/OpenHands/blob/main/specs/workspace-upload-path.md) · [消息图片](https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/conversations.mdx) | 工具处理文件需要稳定可读的副本，用户也需要能打开核对的原件。 |

这些入口有不同前提。终端和 IDE 可以直接读取其工作区路径，Lab 浏览器拿到的是用户选中的文件字节。尤其在浏览器与 daemon 分处两台机器时，本地路径无法充当交付凭据。Lab 应保存会话副本。若以后增加「引用工作区文件」，应显示工作区路径与读取版本，让用户知道后续读取是否会随编辑更新。

## 四个项目的端到端比较

补充核对日期为 2026-11-16。下文的源码链接指向具体提交，CLI、Web、消息渠道分别取证。文中提到的测试是上游测试源码，本次未执行四款产品的端到端实验。

### Codex：让模型看图，以及让 Agent 去读一个文件

桌面端的官方说明给出按住 Shift 把图片拖入输入框的操作；交互 CLI 可粘贴图片，也可用 `codex --image before.png,after.png` 一次带两张。移动端 Remote 的输入框还支持文件、照片和现场拍摄，工作实际运行在选定的主机。公开资料能确认这些入口，桌面端拖入任意 Office 文件后具体使用哪套转换器、原件保留多久，仍缺少同等证据。[桌面与 CLI 图片说明](https://learn.chatgpt.com/docs/image-inputs) · [Remote 实例](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)

在已核对的 TUI 工作区文件选择实现里，选普通源码会把路径写入输入框；可解码的图片会成为附件。协议中的 `LocalImage` 在组装请求时转换为图像数据，正文里的视觉占位可作为带位置的元素保留。另有 `view_image` 工具让 Agent 在工作过程中打开图片。上游测试检查实际模型请求中有图，也检查文件缺失时不会产生图像输入。因此「引用当前代码」「这一轮直接看图」「工作中再打开图」有三条可区分的路径。[文件选择实现](https://github.com/openai/codex/blob/94311d447587411789533c47601fd8bc9d81eb48/codex-rs/tui/src/bottom_pane/chat_composer.rs#L2458-L2478) · [输入协议](https://github.com/openai/codex/blob/cd1805370610e71eae7819b4ed28b90679a53f0e/codex-rs/protocol/src/user_input.rs) · [模型请求测试](https://github.com/openai/codex/blob/cd1805370610e71eae7819b4ed28b90679a53f0e/codex-rs/core/tests/suite/view_image.rs)

### Qwen Code：同一次拖放可以有两个目的地

Web Shell 专门区分「附到消息」和「上传到工作区」。官方设计约定两种能力都可用、宿主又没指定默认值时才让用户选；只有一种可用就直接执行。消息附件进入草稿，图片与其他文件分开处理，保留原顺序的各自队列和逐项失败信息；工作区上传则创建文件，把可供引用的路径放回输入框。普通同名冲突按编号生成新名称。托管版的上传代码还验证回执；上传过程中切换目标会使旧请求结果失效。[拖放决策](https://github.com/QwenLM/qwen-code/blob/de865b41ba23dc705a262db6073d0186dcbd99d2/docs/design/web-shell-file-drop-action.md) · [消息草稿实现](https://github.com/QwenLM/qwen-code/blob/de865b41ba23dc705a262db6073d0186dcbd99d2/packages/web-shell/client/hooks/useComposerCore.ts#L2245-L2335) · [工作区上传设计](https://github.com/QwenLM/qwen-code/blob/de865b41ba23dc705a262db6073d0186dcbd99d2/docs/design/web-shell-file-upload.md) · [托管版回执](https://github.com/QwenLM/qwen-code/blob/de865b41ba23dc705a262db6073d0186dcbd99d2/packages/web-shell/client/components/managed/use-managed-file-upload.ts)

CLI 的 `@文件` 则会在发送前解析路径、调用内部读取逻辑，把成功读到的内容并入本轮提问。这和 Codex TUI 的普通路径补全在视觉上很像，模型拿到的信息却不同。通过消息渠道接入时又有第三种行为：图片可直接进入视觉模型，文档先下载到临时目录，Agent 得到路径后再读。PDF 读取支持指定页码；当模型无法原生读 PDF 时，可提取文字，满足条件时再调用视觉转写，每次最多四页，并标明转写有损。临时路径的存在不足以承诺长期追问。[CLI 发送实现](https://github.com/QwenLM/qwen-code/blob/de865b41ba23dc705a262db6073d0186dcbd99d2/packages/cli/src/ui/hooks/atCommandProcessor.ts#L1149-L1298) · [渠道说明](https://qwenlm.github.io/qwen-code-docs/en/users/features/channels/overview/) · [PDF 读取策略](https://qwenlm.github.io/qwen-code-docs/en/developers/tools/file-system/)

### OpenClaw：每份附件都应有模型可见的处理结果

Gateway 会根据入口能力、实际文件类型、大小和当前模型决定如何交付。适合内联的图片直接进入图像输入，大图或纯文本主模型收到的图片可以落到入站媒体存储，保留可供工具使用的引用。支持视觉的主模型通常可直接收图；若启用媒体预处理并成功生成描述，主模型可改收描述。同批图片的选择策略会影响哪些由辅助模型处理，默认只选首个匹配项；其余图片依条件仍可能原生送达。模型能否看到每张图，需要按附件核对。[Gateway 解析](https://github.com/openclaw/openclaw/blob/059db8a7c5aad9cea5014b6b989e2169db1d403e/src/gateway/chat-attachments.ts#L356-L425) · [媒体理解策略](https://docs.openclaw.ai/nodes/media-understanding)

文档处理会给模型一个具名文件块，包含提取正文，或者部分读取、无可提取文字、读取失败等结果。扫描 PDF 可以在相应条件下转成页面图片。遇到无法解析的本机文件，只有确认回复运行环境能读该路径时，才提示 Agent 自行打开。这个细节直接适用于 Lab：界面上显示「已上传」时，Bot 在另一台机器或隔离环境里仍可能读不到它。[文档读取实现](https://github.com/openclaw/openclaw/blob/059db8a7c5aad9cea5014b6b989e2169db1d403e/src/media-understanding/file-context.ts) · [完整、部分与失败的说明](https://docs.openclaw.ai/nodes/media-understanding#file-attachment-extraction)

### Hermes Agent：文件放在哪里，由来源决定；旧图要能恢复

共享网关的文件暂存代码区分三种来源。工作区内已有的普通文件可就地引用；网关能访问的工作区外文件会复制到附件目录；浏览器暂存上传会另存副本，避免临时上传目录清理后引用失效。容器后端需要能访问该副本。工具层统一用 `read_file` 读取文档，DOCX/XLSX 有内置提取，PDF 等可走可选转换器，结果按范围分页。混合扫描 PDF 在具备检测依赖时，可列出缺字的原始页段，再针对这些页做视觉读取或 OCR。[来源与暂存实现](https://github.com/NousResearch/hermes-agent/blob/3e931466c0694e8c3ad53742e642e5fa46c3d402/tui_gateway/prompt_attachments.py#L264-L288) · [文档提取](https://hermes-agent.nousresearch.com/docs/user-guide/features/document-extraction)

图片发送与历史恢复单独处理。根据配置和模型能力，主模型接收原图或辅助视觉模型的描述。数据库里的消息保留文字占位和文件线索，重建模型请求时才从保留的副本恢复近期图片，并验证内容摘要。默认配置值为 3，按批淘汰时实际可保留最近 3 至 5 张，减轻反复改写历史对提示缓存的影响。消息网关的副本有约 24 小时清理策略，API 请求记录另有生命周期。过期、缺失、内容已变的图片维持占位。这个机制说明「历史气泡还在」「原件还在」「这一轮重新看到了像素」需要分别验证。[图片恢复源码](https://github.com/NousResearch/hermes-agent/blob/3e931466c0694e8c3ad53742e642e5fa46c3d402/agent/image_replay.py) · [图片路由和历史策略](https://hermes-agent.nousresearch.com/docs/user-guide/features/vision)

## Grok Build：同一个输入框有三条读取路径

核对对象是 xAI 官方终端客户端和运行时，源码固定在主仓提交 `2bdd1d6a`，该提交记录为 2026-09-29 从内部仓同步。以下结论适用于查阅的公开版本。[官方仓库说明](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md)

| 入口 | 实际传递的内容 | 工程含义 |
| --- | --- | --- |
| 终端中拖入普通文件，或从文件管理器复制后粘贴 | 输入框插入绝对路径文本。拖入或粘贴图片则形成编号图片项。上游终端测试还检查模拟模型请求中的图片数量、MIME 和宽高。 | 文件名出现、内容可以读取、像素真正送达是三个独立事实。[官方交互说明](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md#L281-L289) · [端到端用例](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/tests/scenarios/image_inputs.yaml) |
| 显式输入 `@src/a.ts:10-50` | 先读取 UTF-8 文本并切出指定行，再附上原始行号。选区超过 **5,000 个估算 token** 时仅提供路径、范围、跳过原因和按段读取的指引。来源为模型生成的不受信任提示时关闭文件展开。 | 先应用用户选区，再决定是否放得下；只把用户主动指定的来源当作读取意图。[提示解析](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/prompt_parser.rs#L117-L192) · [选区和预算](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/file_system/attach_file.rs#L14-L95) |
| 编辑器通过 ACP 直接提交资源 | 内嵌文本可直接提供；大段文本暂存后给出读取提示。二进制资源解码落盘，模型得到文件类型、大小和路径。此辅助函数用带进程标识的临时目录，应区别于正式的会话图片目录。 | 收到二进制和解析正文是两件事；长期回读需要由会话持有原件。[资源处理与暂存实现](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/file_system/attach_file.rs#L96-L245) |

**图片交付与压缩。** 常规 Grok 路径对图片做校验与必要的尺寸处理，将图像内容加入模型请求，并保留文件线索；内联图片通常写入会话 `assets/`，已有 URI 的输入有单独处理。Cursor 兼容路径改用辅助视觉描述；描述缓存同时考虑图片内容与提问指纹。压缩时单独保留最近一个真实用户轮次的图片部分，更早的图片以去重、验证且数量受限的资产路径进入恢复上下文。这让首次看图、隔轮追问和压缩后重读能采用不同成本的策略。[图像交付](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L1142-L1236) · [图片持久化与描述](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/image_describe.rs) · [压缩结构](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-chat-state/src/compaction_image_context.rs) · [恢复前的路径校验](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/compaction.rs#L1571-L1593)

**文档读取发生在工具层。** Grok Build 的 `read_file` 按实际类型分派。PDF 可以按原页码读取文本或页面图像，所查工具路径默认返回图像；超过 10 页要求指定范围，单次最多 20 页。PPTX 有独立的幻灯片文字提取逻辑。以上是明确调用读取工具后的行为，单纯拖入路径不会触发所有解析器。[工具分派](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build/read_file/mod.rs#L525-L581) · [PDF 处理](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/read_file/pdf.rs#L79-L232) · [PPTX 处理](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/read_file/pptx.rs)

## 综合产品决策

| 用户动作 | 文件放在哪里 | 本轮与后续的约定 |
| --- | --- | --- |
| 从电脑拖入输入框，或粘贴截图 | 当前会话中的只读版本 | 首轮自动使用。追问时按附件 ID 读取上传版本；原件失效时给出可操作提示。 |
| 从项目文件选择器引用已有文件（后续能力） | 当前 Agent 可访问的工作区 | 标出工作区与路径，记录本轮实际读取的版本；下次读取可看到新版本，内容已变时明示。 |
| 选择「复制到工作区」（后续能力） | 用户选定的项目目录 | 显式创建可处理的副本，展示目标路径和重名处理。项目里的编辑与原始聊天附件分别保存。 |

首版默认执行第一行，另外两行动作可以独立增加。上传完成后，服务端在组装模型请求时决定当轮交付的是原生图片、辅助视觉描述、全文、选定范围、预览加读取入口，或仅原件。附件卡可在详情中显示实际结果，例如「已看原图」「仅提供图片描述」「已提供第 2–4 页」「已保存，当前 Bot 无法读取」。这些标签表示交付给模型的材料；模型是否据此答对，要用内容题单独验收。

增加三个发布用例。① 两张截图上的金额略有不同，要求比较；对照实际模型输入和回答，确认两张都已交付且顺序正确。② 一份 PDF 有文本页和扫描页，询问扫描页内容；系统须读到对应页，或说清可读范围。③ 上传后重启 daemon 并压缩历史，更换为纯文本主模型再追问截图角落的新细节；有辅助视觉时回读原件并带着新问题分析，否则明确告知当前能力。另将过期副本列为负例，避免模型凭旧描述补写细节。

## 仓库里已有的能力

- 普通对话和单 Bot 已有加号上传及 URL 附件；群聊没有同等的附件入口。此前的文件、文件夹、文字拖放已正式退役。新提案仅恢复输入框里的文件拖放，启用范围需要新验收条目，保留旧记录。见 [退役说明](../COMPOSER_ATTACHMENT_SOAK.md) 和 [旧标准](../../acceptance/composer-drag-context.yaml)。
- 已有会话附件接口、图片资产、文本解码、长文本预览与分页、DOCX/XLSX 正文抽取。PDF 的上传路由目前保存原件并发出占位说明。源码默认的内联阈值是每份文本 100 KiB，不能直接充当多附件共用的模型预算。见 [文件路由](../../packages/core/src/ingestion/route.ts)、[格式分类](../../packages/core/src/ingestion/classify.ts) 和 [设置](../../packages/core/src/ingestion/settings.ts)。
- 当前聊天发送路径会把附件生成的文本拼入消息正文。上传处理同时收集附件 ID 和图片 ID，发送时还会从附件展开图片。建议新增消息到附件的有序引用，在最终模型输入处验证每张图只出现一次。见 [上传入口](../../apps/web-console/components/usePlayChat.ts)、[消息组装](../../packages/core/src/runtime.ts)。
- 附件展开函数接收会话参数，但目前按附件 ID 查找；新方案应把归属校验放在实际解析和读取边界。已有归档工具支持按关键词搜索和按行、偏移量或页回读。见 [附件展开](../../packages/core/src/ingestion/attachment-ingest-service.ts) 和 [归档工具](../../packages/core/src/tools/artifact-tools.ts)。

## 输入框与会话

1. **拖入与选择。** 普通对话和单 Bot 首发。一次拖入多份文件，加号选择与粘贴截图进入同一队列。仅在输入框区域接收文件，保留已输入文字。新对话首次附加文件时先确定会话，之后上传与发送使用同一会话。
2. **发送前。** 每份材料显示文件名、大小、缩略图或类型，以及「上传中」「全文可读」「可搜索」「仅原件」或失败原因。可以逐项移除或重试。部分失败时保留成功项，用户可点「仅发送已就绪的文件」。上传完成前继续输入；取消、切换会话或移除后到达的回执不能重新挂入草稿。
3. **发送时。** 按顺序绑定选定版本，允许只发附件。聊天气泡显示原问题和具名附件卡；打开卡片可核对原件或提取预览。若仅发附件且意图不明，Agent 简要指出可读内容并询问用途。
4. **后续追问。** 「刚才那张截图」「上份日志」优先解析到最近相关的已发送消息。多份同名文件有歧义时显示版本或发送时间供选择。用户也可从「本次对话的文件」重新引用。历史压缩后，系统仍能按引用取回对应版本。与附件无关的轮次不主动重复注入正文。
5. **生命周期。** 草稿移除立即解除本次绑定，清理无引用的暂存文件。已发送的原件随会话保存，删除会话时按现有保留策略回收。相同文件名配不同内容要产生不同版本。文件默认仅供本会话使用；群聊共享和加入长期知识库分别需要明确的产品动作。

## 各格式如何进入模型

| 类型 | 当轮提供 | 按需深读与能力边界 |
| --- | --- | --- |
| 源码、Markdown、TXT、JSON、日志 | 剩余预算足够时送具名正文。源文件扩展名应覆盖常用语言，并验证文本内容，以兼容浏览器提供空 MIME。 | 超预算后送预览、范围和读取入口；关键词搜索后按行回读。 |
| PNG、JPEG、WebP 截图或设计图 | 主模型支持视觉时交付原图。纯文本主模型可借用已配置的辅助视觉模型，结合当前问题生成描述，卡片标明实际交付方式。 | 追问新细节时重新读取原图；两条视觉路径都不可用则显示「当前 Bot 无法看图」。 |
| CSV、XLSX、DOCX | 小文件提供可读文本。大表先给工作表、列名和样例，大文档先给结构或预览。 | 表格定位到工作表和行，文档定位到段落。对 Excel 只承诺已提取的值，公式计算、图表和版式需独立能力。结构定位是拟新增能力。 |
| PDF | 首期沿用「仅原件」。第二期对文本型 PDF 提取带原始页码的文字。 | 扫描页需要 OCR 或视觉能力，混合 PDF 应逐页标明可读情况。归档工具的分块页号不可用作 PDF 原始页码。 |
| 压缩包、音视频、其他二进制 | 首期直接显示暂不支持，用户可以移除并继续发送其余文件。 | 下载、解压、转写等有明确用途后再设计。 |

## 综合技术方案

**持久化上传版本，按轮生成模型输入。** 同一份附件可以同时支撑三个场景：第一轮直接交付全文或像素；后续工具针对某几行、某一页或某张图深读；聊天气泡打开当初上传的版本。实现上让三者引用同一个附件 ID，保留用户原话、附件排序和选定范围。Qwen Code 的目的地区分、Grok Build 的选区与压缩处理、OpenClaw 的逐项交付结果，以及 Hermes 的旧图恢复分别解决这条链路上的不同问题。

| 边界 | 拟定契约 | 在现有仓库中的落点 |
| --- | --- | --- |
| 浏览器 → 上传 | 拖放、加号、粘贴截图共用一个有序草稿队列。每项先生成本地键，记录所属会话与草稿；按用户添加顺序展示，回执只更新对应项。允许逐项取消、重试。 | [上传逻辑](../../apps/web-console/components/usePlayChat.ts) · [输入框](../../apps/web-console/components/PlayPanel.tsx) · [草稿](../../apps/web-console/lib/composer-draft.ts) |
| 上传 → 会话资产 | 首版沿用会话上传接口和大小限制。先分配不可变的附件 ID，再按 ID 写原件。记录原始文件名、实际类型、大小、完整内容摘要和可用的图片或分页引用。原件成功保存、文本提取成功分别返回；传输超限按整条链路的有效上限提示。 | [附件路由](../../apps/daemon/src/routes/attachments.ts) · [入库服务](../../packages/core/src/ingestion/attachment-ingest-service.ts) · [存储](../../packages/core/src/stores/attachment-store.ts) |
| 发送 → 用户消息 | 复用现有 `attachmentIds`；有选区时使用有序 `attachmentRefs: [{attachmentId, range?}]`，旧字段在入口归一化。建议给用户消息的 `TextPart` 增加可选引用字段，持久化版本由不可变附件 ID 确定。只有附件也能发。发送回执关联消息与引用。 | [消息类型](../../packages/api-types/src/message-parts.ts) · [发送路径](../../packages/core/src/runtime.ts) · [消息持久化入口](../../packages/core/src/runtime/session-facade.ts) |
| 消息 → 模型请求 | 在产品侧准备模型视图时，把可见引用按模型能力、真实可用工具和本轮预算解析为具名文本、图像或读取入口。用户问题保留在用户消息中，文档内容带来源边界。逐项记录实际交付方式、范围、降级原因；用请求标识关联，不记录文件正文。 | [模型视图](../../packages/core/src/turn/prepare-view.ts) · [归档读取工具](../../packages/core/src/tools/artifact-tools.ts) · [辅助视觉工具](../../packages/core/src/tools/builtin-tools.ts) |

**一次发送的次序。** 浏览器先确定目标会话，再暂存文件。发送时服务端在同一写入事务内核验会话权限、校验附件全部归属、写入消息及有序引用。发送请求携带可重用的客户端消息键，超时重试返回同一条消息。并发移除与迟到的上传回执按草稿标识处理。普通对话与单 Bot 的首条消息、流式发送、运行中排队和重试都使用同一绑定逻辑。若新建会话或任务需要接收另一个暂存上下文的资产，明确校验来源与目标并生成目标会话引用。草稿预览允许上传者访问；模型可发现的文件以已经发送且对当前调用者可见的消息为准。

**当轮怎么选内容。** 先为用户问题、必要历史和输出留空间，再给所有附件分配共享预算。优先交付用户选中的行或页；接着交付预算内的小文件全文；大日志默认给文件名、短预览、行范围和归档句柄。超预算的小文件也能分页回读。检索和读取复用 `search_artifact_content`、`read_artifact_page`，对命中位置返回原文件行号；两个工具在实际 Bot 的可用清单中得到确认后，卡片才显示“可搜索”。图片根据最终模型路由选原生输入或按当前问题生成的辅助视觉描述；同图换问题时重新分析，缓存至少绑定文件摘要、提问、视觉模型和处理版本。有多个附件时，每项都要有结果，包括“仅保存原件”。

**后续怎么找回。** 本轮明确提及、回复某条消息或在附件卡点击“再次引用”，都能确定具体版本。「刚才那张」先从最近可见消息找，重名且有歧义时让用户选。长会话给模型一份有界的近期来源清单，保留查询更早已发送附件的入口。压缩摘要携带结构化来源 ID；历史图片按现有热图与拼图逻辑节省上下文。用户追问细字时从已绑定的原件再生成当轮图像。清理程序只回收无引用暂存和可重建的派生物；会话保留期内的已发送原件单独计入引用。合法删除或原件损坏时，卡片和工具都返回“原件不可用”，可重新上传为新版本。

**兼容与迁移。** 新消息开始保存引用。旧客户端送来的 `attachmentIds`、`imageAssetIds` 在同一入口校验并按资产去重。已有正文和历史图片继续按原格式回放；缺少可靠来源关联的旧文本保留原样。配置沿用现有 Lab 入库设置与模型窗口推导；设计评估时与实际 provider 请求对照，追踪附件引入的输入量、回读次数、提问命中率和部分交付原因。

**优先修正三个现有细节。**

1. `expandForMessage` 接受会话 ID，目前按附件 ID 取记录。把归属检查放在消息绑定与每次工具读取边界；过期、跨会话和仅草稿的引用应有不同内部原因，客户端统一给出适用的不可用提示。[现有展开实现](../../packages/core/src/ingestion/attachment-ingest-service.ts)
2. Office/PDF 的落盘名由输入批次序号与文件名组成，单文件上传反复从同一序号开始。同会话两次上传不同内容的同名文件可能写向同一路径。用独立附件 ID 作为存储位置；Office 长文抽取产生的归档句柄也应存入附件记录，后续可直接回读。[文件路由](../../packages/core/src/ingestion/route.ts) · [磁盘写入](../../packages/core/src/ingestion/ports.ts)
3. 当前历史冷图有按年龄清理的逻辑。若产品承诺会话内能再次看原图，必须让已发送附件持有原件，或者给清理过程加引用检查。上传时产生的图片 ID 和发送时展开的图片 ID 统一去重，验收到最终模型请求。[历史图片清理](../../packages/core/src/image-assets.ts) · [发送组装](../../packages/core/src/runtime.ts)

## 实现顺序

**第一期交付一次完整对话。** 共用现有附件上传接口和处理管线；草稿从两组裸 ID 改为有序的具名附件项。消息持久化「用户文字＋附件版本引用」，模型请求单独生成可读视图，兼容已有历史消息。上传原件使用独立对象位置，文件名只用于展示。优先用会话内搜索与分页完成长文件读取，确保普通对话及单 Bot 在实际工具集中都能回读。无合适读取工具时向用户标明可用范围。

附件预算按当前模型的可用窗口、历史占用、输出预留和本轮全部附件一起计算。显式指定的文件或片段优先，每个其余文件至少保留具名条目与读取入口。第一版复用已有上传大小与分页配置；用中英文日志、源码、多图混合样本测量实际模型输入后再定预算比例。附件正文继续走外部资料边界。发送重试复用同一组引用，待发送草稿不会进入可供 Agent 搜索的已发送文件集合。

**第二期补齐文档质量与引用。** 带页码 PDF、表格行列与 Word 段落定位、答案中的可点击出处。根据实际使用频率决定扫描件 OCR。群聊单列一期：先定义哪些成员或 Bot 可见，再定义转发、房间检索和删除传播。

## 验收建议

| 场景 | 通过条件 |
| --- | --- |
| 混合拖入截图、源码和长日志 | 三个来源具名呈现；能回答截图内容、源码里的特定值，以及仅在日志末尾出现的问题，并给出能核对的位置。视觉样本需含只能从像素识别的信息。 |
| 多轮和历史压缩 | 刷新页面并触发压缩后，能再次读到日志末尾；无关下一轮不新增整份正文。检查实际请求和读取记录。 |
| 中文文件名、空 MIME、重名新版本 | 源码仍可读取；旧消息和新消息分别指向发送时的版本。 |
| 部分失败、切会话、取消、重试 | 成功项可独立发送，已移除项不复现；会话之间不串文件，重试不重复建消息或插图。 |
| 解析能力不足 | 仅保存原件的 PDF、解析失败的表格、无视觉能力的图片均显示真实状态。 |
| 权限与回归 | 会话内工具只读本会话已发送的来源；普通对话与单 Bot 都经过真实发送路径；加号、URL 附件、既有历史和群聊原有交互正常。 |
