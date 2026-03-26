#!/bin/bash
# Claude Web Bridge - Setup Script
set -e

echo "━━━ Claude Web Bridge Setup ━━━"
echo ""

# Install server dependencies
echo "→ Installing server dependencies..."
cd "$(dirname "$0")/server"
npm install
echo "  ✓ Server dependencies installed"
echo ""

# Check if we should add to Claude Code MCP config
CLAUDE_MCP="$HOME/.claude.json"
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "→ MCP Configuration"
echo "  Add this to your Claude Code MCP config ($CLAUDE_MCP):"
echo ""
echo "  \"claude-web-bridge\": {"
echo "    \"command\": \"node\","
echo "    \"args\": [\"server/index.mjs\"],"
echo "    \"cwd\": \"$BRIDGE_DIR\""
echo "  }"
echo ""
echo "━━━ Browser Extension ━━━"
echo ""
echo "  Chrome/Edge:"
echo "    1. Open chrome://extensions"
echo "    2. Enable 'Developer mode' (top right)"
echo "    3. Click 'Load unpacked'"
echo "    4. Select: $BRIDGE_DIR/extension"
echo ""
echo "  Firefox:"
echo "    1. Open about:debugging#/runtime/this-firefox"
echo "    2. Click 'Load Temporary Add-on'"
echo "    3. Select: $BRIDGE_DIR/extension/manifest.firefox.json"
echo ""
echo "━━━ Usage ━━━"
echo ""
echo "  1. Start Claude Code in any project"
echo "  2. The MCP server starts automatically"
echo "  3. Click the extension icon → Connect"
echo "  4. Ask Claude to interact with your browser!"
echo ""
echo "Done! 🚀"
