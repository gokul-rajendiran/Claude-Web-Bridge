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
| `get_tabs` | List all open browser tabs |
| `switch_tab` | Switch to a specific tab |
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

## Troubleshooting

- **Extension shows red badge** — MCP server isn't running. Make sure Claude Code is open and the MCP config is correct.
- **"Browser extension is not connected"** — Click the extension icon and hit Connect.
- **Tools timeout** — Some pages block scripting (e.g., `chrome://` URLs). Try a different tab.
