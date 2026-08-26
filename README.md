# Claude Web Bridge

Bridge between Claude Code and your browser. Lets Claude read pages, click elements, fill forms, take screenshots, and more — all through MCP.

## How It Works

```
Claude Code ◄──stdio/MCP──► MCP Server ◄──WebSocket (localhost:7862)──► Chrome Extension ◄──► Browser
```

Everything runs locally on your machine. No data leaves your computer.

## Quick Install

Run this one command (you'll need a token from the project owner):

```bash
TOKEN=<your-token> bash <(curl -sH "Authorization: token <your-token>" https://raw.githubusercontent.com/gokul2507/Claude-Web-Bridge/main/install.sh)
```

This downloads everything to `~/.claude-web-bridge/`.

## Setup

### 1. MCP Server

Add this to your `~/.claude.json` inside `"mcpServers"`, replacing
`/Users/YOUR_USERNAME` with your real home directory (`echo $HOME`):

```json
"claude-web-bridge": {
  "command": "node",
  "args": ["/Users/YOUR_USERNAME/.claude-web-bridge/server/index.mjs"],
  "cwd": "/Users/YOUR_USERNAME/.claude-web-bridge/server"
}
```

> **Use absolute paths.** `~` is expanded by your shell, and there is no shell
> here — Node receives a literal `~` and fails with `ENOENT`.
>
> **Register the server in exactly one place.** Do not also add a
> `.mcp.json` in a project directory. Two registrations start two servers
> that fight over port 7862; the loser exits, and if it is the one your
> session is attached to, every tool reports that the extension is not
> connected even though the browser is fine.

Then restart Claude Code.

### 2. Browser Extension

**Chrome / Edge:**
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select `~/.claude-web-bridge/extension`

**Firefox:**
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `~/.claude-web-bridge/extension/manifest.firefox.json`

### 3. Connect

1. Click the Claude Web Bridge extension icon in your browser toolbar
2. Click **Connect** — the badge should turn green ("ON")
3. Start Claude Code and ask it to interact with your browser

## Available Tools

| Tool | Description |
|------|-------------|
| `get_tabs` | List all open tabs across every connected browser profile |
| `switch_tab` | Switch to a specific tab (focuses it — visible to the user) |
| `use_tab` | Bind this session to a tab so later calls target it without focusing it |
| `get_page_content` | Get full text content of a page |
| `get_page_html` | Get HTML of a page or selector |
| `get_page_metadata` | Get page metadata (title, meta tags, OpenGraph) |
| `get_page_links` | Get all links on a page |
| `get_page_forms` | Get all forms with their inputs |
| `get_page_tables` | Extract tables as structured data |
| `query_selector` | Query DOM elements by CSS selector |
| `click_element` | Click an element by CSS selector |
| `click_at_coordinates` | Click at specific x,y coordinates |
| `fill_input` | Fill a form input |
| `select_option` | Select a dropdown option |
| `type_text` | Type text with keyboard events |
| `press_key` | Press a keyboard key (Enter, Escape, etc.) |
| `set_content_editable` | Set text in contenteditable elements |
| `scroll_page` | Scroll in a direction or to an element |
| `navigate` | Navigate to a URL or open a new tab |
| `wait_for_element` | Wait for an element to appear |
| `wait_for_page_load` | Wait for page to finish loading |
| `execute_js` | Execute custom JavaScript on a page |
| `take_screenshot` | Capture a screenshot (returns PNG) |
| `play_media` | Play video/audio |
| `pause_media` | Pause video/audio |
| `get_media_state` | Get media playback state |
| `set_volume` | Set media volume |
| `seek_media` | Seek to a specific time |
| `bridge_status` | Check if extension is connected |

## Updating

Re-run the install command to get the latest version:

```bash
TOKEN=<your-token> bash <(curl -sH "Authorization: token <your-token>" https://raw.githubusercontent.com/gokul2507/Claude-Web-Bridge/main/install.sh)
```

## Multiple Chrome windows and profiles

All windows of one Chrome profile are always visible — `get_tabs` lists every
tab of every window, and each tab carries its `windowId`.

Chrome **profiles** are separate browser instances: each profile runs its own
copy of the extension, so a profile is only visible to Claude if the extension
is loaded and connected **in that profile**. To control several profiles:

1. In each profile, open `chrome://extensions`, enable Developer mode, and
   **Load unpacked** → `~/.claude-web-bridge/extension` (repeat per profile).
2. Click the extension icon in that profile and hit **Connect**.

Every connected profile gets its own WebSocket to the bridge. `get_tabs` merges
tabs from all of them and tags each tab with a `browserId`; tool calls that pass
a `tabId` are routed to the profile that owns the tab automatically. Calls
without a `tabId` go to the active tab of the browser window you focused last.
`bridge_status` reports how many browsers are connected under `browsers`.

## Multiple Claude sessions

Several Claude sessions can drive the same browser at once. The extension holds
one WebSocket to one port, so the servers arrange themselves automatically:

```text
Claude session A ──► bridge server (HUB) ◄──WebSocket──► Extension ──► Browser
Claude session B ──► bridge server (peer) ──┘  forwards through the hub
Claude session C ──► bridge server (peer) ──┘
```

- The first server to bind port 7862 becomes the **hub** and owns the extension.
- Later servers become **peers** and forward their tool calls through the hub.
- If the hub's session closes, a peer takes over the port and the extension
  reconnects to it. No action needed.

The browser tools behave identically either way. `bridge_status` reports which
role a server has, plus `peer_sessions` on the hub, if you want to see the
arrangement.

### Working in different tabs at the same time

By default, a tool call that names no `tabId` targets the focused tab — which
is shared, global state, so two sessions doing that would fight over it (and
`switch_tab` steals focus from whatever the other session was doing).

To let sessions work side by side, each session can bind its own default tab:

- `use_tab <tabId>` — every later call from that session targets the bound tab
  in the background, without focusing it or disturbing the other sessions.
- `navigate` with `newTab: true` binds the session to the tab it just created,
  so "open a tab and work in it" is isolated per session out of the box.
- `switch_tab` also binds, but focuses the tab (user-visible).
- `use_tab` with no arguments clears the binding.

The binding lives in the session's own server process, so every session (hub or
peer) keeps an independent one. If the bound tab is closed, the next call fails
with a clear error and the binding resets.

### Reclaiming a wedged port

If a server holds port 7862 but is unresponsive (for example its Claude session
is gone but the process survived), reclaim it with `CWB_TAKEOVER=1` in the `env`
of your `~/.claude.json` entry, or find it with:

```bash
lsof -ti :7862 -sTCP:LISTEN
```

Takeover is opt-in on purpose. It used to be unconditional, which made
concurrent sessions kill each other's servers in a loop.

## Troubleshooting

- **Extension shows red badge** — MCP server isn't running. Make sure Claude Code is open and the MCP config is correct.
- **"Browser extension is not connected"** — Click the extension icon and hit Connect. If several Claude sessions are open, see [Multiple Claude sessions](#multiple-claude-sessions).
- **Tools timeout** — Some pages block scripting (e.g., `chrome://` URLs). Try a different tab.
