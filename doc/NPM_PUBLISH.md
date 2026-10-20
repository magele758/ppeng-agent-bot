# npm 自动发布

只发布已经在 npm 上公开的两个包：`@mage-ai-lab/api-types`、`@mage-ai-lab/agent-loop`。其它 `@ppeng/*` 包不会上传。

对照 [magele758/hyper-vibekanban](https://github.com/magele758/hyper-vibekanban) 的 `publish.yml` / `pre-release.yml`：GitHub OIDC 可信发布，`id-token: write`，`npm publish --provenance --access public`，运行前把 npm 升到 11.12.0（可信发布需要 npm >= 11.5.1）。不使用长期 `NPM_TOKEN`。

## 工作流做什么

文件：`.github/workflows/publish-npm.yml`（Actions 里的名字是 **Publish npm**）。

1. **推送 tag `npm-v*`**（Cursor 项目里用这条）：tag 形如 `npm-v0.1.2`，指向已经把版本写进 `package.json` 的那次提交。工作流按仓库里已提交的版本编译、打包、校验后发布，不读取手动运行的输入，也不会再改版本号。该版本已经在 npm 上就跳过，不失败。普通分支 push 和 pull request **不**触发。
2. **手动**：Actions → Publish npm → Run workflow。`version_type` 为 `patch` / `minor` / `major` 时，取这两个包在仓库里的版本和 npm 上已发布版本中较高的那个，再递增，写回 `package.json` 和 lockfile 里对这两个包的精确版本，提交到当前分支，并推送 tag `npm-v<version>`。然后编译、打包、校验，再发布。成功后挂一个 **GitHub pre-release**（pre-release 不会再次触发本工作流）。Cursor 里的 GitHub App token 没有 `actions:write`，不能这样手动触发。
3. **正式 Release**：tag 以 `npm-v` 开头、且 Release 被标成正式版（不是 pre-release）时再跑一次。版本已经在 npm 上就跳过，用来重试。
4. 普通分支 push、pull request、预发布、桌面安装包用的 `v*` / `desktop-v*` Release **不发布**。桌面 `v*` Release 仍会启动这个工作流，但选择步骤会直接跳过，不会跑 release gate，也不会上传。
5. 真正上传之前必须通过 release gate。dry run 也不绕过。
6. `republish` 不改版本，按当前 `package.json` 发。两个版本都已经在 npm 上时失败。tag 推送和正式 Release 在版本已存在时跳过。

和参考项目的差别：那边用 `v*`，并用 `remote-*` / `relay-*` 排除镜像发布。本仓库的 `v*` 已经用来打桌面安装包，所以 npm tag 用 `npm-v*`。

`agent-loop@0.1.1` 已经在 npm 上（2026-09-18 的旧 tarball），不能原样再发。仓库里这两个包的版本是 **0.1.2**。在包含该版本的提交上推送 tag `npm-v0.1.2` 即可发布。

## 雷鹏需要做的事

1. 用 npm 上这两个包的维护者账号在浏览器登录 [npmjs.com](https://www.npmjs.com)（当前维护者是 magele758）。这是为了保存 Trusted Publisher，不是为了把 token 放进 GitHub。
2. **不要**新建 GitHub secret `NPM_TOKEN`。工作流不读它。仓库里如果已经有这个 secret，可以留着，也可以删掉。
3. 给**每个**包各加一条 Trusted Publisher（缺一个，那个包就会发布失败）：
   - `@mage-ai-lab/api-types`
   - `@mage-ai-lab/agent-loop`
   打开包页面 → **Settings** → **Trusted Publisher** → **GitHub Actions** → Set up connection：
   - Repository：`magele758/ppeng-agent-core`
   - Workflow filename：`publish-npm.yml`（只写文件名）
   - Environment name：留空（工作流没有使用 GitHub Environment）
4. 允许 GitHub Actions 用 `GITHUB_TOKEN` 推送到你按下 Run workflow 的那个分支（一般是 `main`），并创建 tag。工作流身份是 `github-actions[bot]`。如果分支保护拦住机器人推送，版本提交会失败、包也不会发出去。要么给这个 bot 开推送例外，要么自己把版本改好后用 `republish`。
5. Cursor 项目里的 `gh` 是 GitHub App（`ghs_` token），能推 tag，不能 `workflow_dispatch`。发布做法：把版本提交进要发布的提交，再 `git push origin npm-v<version>`。例如两个包都是 `0.1.2` 时推送 `npm-v0.1.2`。版本已在 npm 上则这次运行跳过。把该 tag 的 GitHub Release 从 pre-release 改成正式版仍会再跑一次，同样已存在则跳过。
6. 这两个包已经在 npm 上，**不需要**为了「让 Trusted Publisher 能保存」再手动发一版。也不要手动重发 `0.1.1`。成功后 npm 上应出现 `@mage-ai-lab/api-types@0.1.2` 和 `@mage-ai-lab/agent-loop@0.1.2`。
7. 只有在自己电脑上发布时才需要 `npm login`，然后 `pnpm run publish:npm`。CI 不走这条路。
