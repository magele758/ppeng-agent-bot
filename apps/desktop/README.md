# Raw Agent Desktop

Electron desktop client for Raw Agent (Apple Silicon macOS, Linux). Windows and Intel Mac (darwin x64) are not packed.

![Raw Agent Desktop](assets/screenshots/main-window.png)

## Features

- 🖥️ Native window + system tray
- 🔧 Bundled daemon and web console
- 💾 Persistent state in the OS user-data directory
- ⚙️ Configuration via `.env` (tray → Open Config)

## Building

Node.js >= 22. Pack on the **same OS/arch** you want to ship (Next standalone and `sharp` are native).

```bash
# Host platform/arch
npm run build:desktop

# Explicit target (still needs a matching machine)
node scripts/build-desktop.mjs --platform linux --arch x64
```

Output: `apps/desktop/release/RawAgent-<version>-<os>-<arch>.{dmg,AppImage}`

| OS | x64 | arm64 |
|----|-----|-------|
| macOS | not built (Intel / darwin x64) | DMG |
| Windows | not built | not built |
| Linux | AppImage | AppImage |

Do not add Windows (`win-x64` / `win-arm64`) or darwin-x64 / `mac-x64` CI targets back without a new product decision. CI: daily at 17:00 UTC (01:00 Beijing), `desktop-v*` tag (agent; no Release), or [`.github/workflows/desktop.yml`](../../.github/workflows/desktop.yml) (see [`doc/CI.md`](../../doc/CI.md)).

## Development

```bash
cd apps/desktop
npm run dev
```

## Configuration

The app stores configuration in:
- **State data:** `~/Library/Application Support/agent-desktop/state/`
- **User config:** `~/Library/Application Support/agent-desktop/.env`

On first run, you can configure your API keys and model settings via the tray menu → "Open Config (.env)".

## Distribution

The built `.dmg` file in `apps/desktop/release/` can be distributed to users.

CI builds are **not Apple-signed or notarized**. On Apple Silicon (M1–M4) macOS often says the download is damaged. That is Gatekeeper quarantine, not a bad file. Use the `mac-arm64` DMG on M4 Max, then:

```bash
xattr -cr ~/Downloads/RawAgent-0.1.0-mac-arm64.dmg
open ~/Downloads/RawAgent-0.1.0-mac-arm64.dmg
```

Drag **Raw Agent** to Applications, then:

```bash
xattr -cr "/Applications/Raw Agent.app"
open "/Applications/Raw Agent.app"
```

Users can:
1. Remove the quarantine attribute (`xattr -cr`)
2. Mount the DMG
3. Drag "Raw Agent" to Applications
4. Launch (or `xattr -cr` the `.app` again if macOS still blocks it)

## Architecture

- **Main Process:** Electron main process manages:
  - Daemon (Node.js HTTP API server)
  - Web Console (Next.js standalone server)
  - Window and tray management
  
- **Renderer Process:** Loads the web console UI

- **State:** SQLite databases and logs are stored in the user data directory

## Troubleshooting

### Services won't start

Check logs in Console.app or run from terminal:
```bash
/Applications/Raw\ Agent.app/Contents/MacOS/Raw\ Agent
```

### Port conflicts

Desktop defaults follow Agent Lab (daemon `37070`, web `33815`). If either port is busy on
launch, the app automatically probes upward and persists the actually-bound ports to its local
`config.json` — no manual action is usually needed.

To pin a specific port instead, edit the user config:
```bash
open ~/Library/Application\ Support/agent-desktop/.env
```

Add:
```
RAW_AGENT_DAEMON_PORT=7071
RAW_AGENT_WEB_PORT=13001
```

Then restart via tray menu → "Restart Services".

### Authentication between daemon and web console

If `RAW_AGENT_AUTH_TOKEN` is missing from the user `.env`, the app generates a random token on
first launch and saves it there; the daemon and bundled web console are always started with the
same token, so the UI never gets an unexpected 401.

## Safe local updates (macOS Apple Silicon)

The **Raw Agent → 更新客户端… / Update client…** menu (also available in the tray)
opens a picker for a prepared `Raw Agent.app`. Mount the new DMG first, then select
its app. The dialog shows the current/new version, build timestamp and release
notes. Selecting a file or building a release does not install it: installation
starts only after clicking **更新客户端 / Update client**.

Active tasks, scheduler work or mutating requests prevent the update; retry when
idle. The desktop privately asks its daemon to stop accepting work, quits, and
hands off to an independent helper. The helper backs up the old application and
entire user-data directory before replacing the app. Backup, validation logs and
`Recover.command` are stored in a timestamp-independent unique transaction folder
under the sibling `agent-desktop-updates` directory. Backups are retained.

The new daemon starts in validation mode: regular requests, session execution,
schedulers, gateway startup and startup self-healing are blocked. After startup,
the helper stops validation processes, checks database integrity, preserved record
identities/content and asset availability, then permits normal startup. Failures
restore the old application and data. Interrupted updates block normal startup
and offer recovery. If the installed app is missing, run the backup folder's
`Recover.command`. Recovery terminates recorded validation processes before
restoring data; a failed recovery retains backups and reports manual recovery.

The currently installed pre-updater version requires a **one-time manual install**
of the first updater-capable build, with the client exited. Replacing only the
application bundle preserves its separate user-data directory. Subsequent updates
use the menu above. There is no automatic download or background installation.
Never replace the client while it is running.

Development/QA must use a disposable app copy and an explicit
`--user-data-dir=/absolute/temporary/test-profile`, plus synthetic data. Never point
a test profile, daemon, or proxy at the production client's data or services.
Updates preserve existing workspace bindings; they do not copy or roll back files
outside the user-data directory. Validation does not execute tools in those paths.
