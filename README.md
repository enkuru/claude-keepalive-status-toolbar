# claude-keepalive-status-toolbar

A lightweight macOS menu bar status (SwiftBar) + keepalive loop for Claude Code.

- **Menu bar**: live activity status, session start, last activity age, rate-limit progress bars, reset times, and hello history.
- **Keepalive**: every 10 minutes, if no recent activity and both 5h + 7d limits are under 100%, it spawns `claude` and sends `hello` after 5 seconds.
- **Manual button**: “Send hello now” appears in the menu (only enabled when limits are OK).

![Menu Bar Screenshot](images/menu.png)

## Requirements

- macOS
- Node.js 18+
- SwiftBar (menu bar runner)

## Install (Quick Start)

1) Install SwiftBar:

```bash
brew install --cask swiftbar
```

2) Clone and enter the repo:

```bash
git clone https://github.com/enkuru/claude-keepalive-status-toolbar.git
cd claude-keepalive-status-toolbar
```

3) Install the SwiftBar plugin (symlink recommended):

```bash
ln -s "$(pwd)/macos/claude-session.1m.js" \
  "$HOME/Library/Application Support/SwiftBar/Plugins/claude-session.1m.js"
```

4) Launch SwiftBar and refresh plugins.

> The menu updates every 1 minute (`.1m` in the filename).

## Keepalive Loop

Run once:

```bash
npm run keepalive:once
```

Run continuously (every 10 minutes):

```bash
npm run keepalive
```

### Auto-start on login (LaunchAgent)

```bash
./macos/install-launchagent.sh
```

This installs a LaunchAgent at `~/Library/LaunchAgents/com.enes.claude-keepalive.plist` and starts it.

## How activity is detected

The tool reads local Claude transcripts in:

- `~/.claude/projects`
- `~/.config/claude/projects`

It scans JSONL files and uses the most recent timestamp found.

## Menu items

- **Claude: Active / Idle**
- **Last activity: 1m**
- **5h limit / 7d limit**: progress bars + %
- **5h resets / 7d resets**: time until reset
- **Send hello now**: manual trigger (only if limits OK)

## Configuration

### Keepalive script (CLI args)

- `--interval-minutes=10`
- `--active-minutes=10`
- `--hello-delay-seconds=5`
- `--cooldown-minutes=10`
- `--transcript-path=/path/to/file.jsonl`
- `--once`
- `--dry-run`

### Environment variables

- `CLAUDE_CMD` (default: `claude`)
- `CLAUDE_ARGS` (space-separated args for the `claude` process)
- `CLAUDE_TRANSCRIPT_DIRS` (path-delimited list of extra dirs)
- `ACTIVE_MINUTES`, `TRANSCRIPT_PATH`, `MAX_DEPTH`, `TAIL_BYTES`
- `KEEPALIVE_PATH` or `KEEPALIVE_REPO` (used by the menu button to find the keepalive script)

## Troubleshooting

- **“Last activity: unknown”**
  - Ensure you have `~/.claude/projects` or `~/.config/claude/projects` with JSONL files.
- **“Send hello now” is disabled**
  - Either limits are full, or the keepalive script path can’t be found.
- **Limits show “Unknown” or “Cached” after sleep**
  - This usually means **Keychain access is blocked** or the **OAuth token expired**.
  - **Re-enable Keychain access**:
    1. Open **Keychain Access** → unlock “login” keychain
    2. Search for **“Claude Code-credentials”**
    3. Open it → **Access Control** → allow SwiftBar (or “Allow all applications”)
    4. Test in Terminal:
       ```
       security find-generic-password -s "Claude Code-credentials" -w
       ```
  - If the API says **token expired**, open Claude Code and re-auth once (sign out/in if needed).
- **No menu bar item**
  - Open SwiftBar → Preferences → Plugins → Refresh.

## License

MIT
