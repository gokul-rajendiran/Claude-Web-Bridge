#!/bin/bash
# Claude Web Bridge - Remote Install Script
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/gokul2507/Claude-Web-Bridge/main/install.sh)
# For a private fork, set TOKEN to a GitHub token with read access and REPO to the fork.
set -e

INSTALL_DIR="$HOME/.claude-web-bridge"
REPO="${REPO:-gokul2507/Claude-Web-Bridge}"
BRANCH="main"

echo "━━━ Claude Web Bridge Installer ━━━"
echo ""

# Clean previous install
if [ -d "$INSTALL_DIR" ]; then
  echo "→ Removing previous installation..."
  rm -rf "$INSTALL_DIR"
fi

# Download repo as tarball (TOKEN is only needed for a private fork)
echo "→ Downloading Claude Web Bridge..."
mkdir -p "$INSTALL_DIR"
AUTH=()
if [ -n "$TOKEN" ]; then
  AUTH=(-H "Authorization: token $TOKEN")
fi
curl -fsSL "${AUTH[@]}" \
  "https://api.github.com/repos/$REPO/tarball/$BRANCH" | \
  tar xz --strip-components=1 -C "$INSTALL_DIR"

# Install server dependencies
echo "→ Installing server dependencies..."
cd "$INSTALL_DIR/server"
npm install --production --silent
echo "  Done."
echo ""

# Output MCP config
echo "━━━ Add this to your Claude Code MCP config ━━━"
echo ""
echo "  File: ~/.claude.json (inside \"mcpServers\")"
echo ""
echo "  \"claude-web-bridge\": {"
echo "    \"command\": \"node\","
echo "    \"args\": [\"$INSTALL_DIR/server/index.mjs\"],"
echo "    \"cwd\": \"$INSTALL_DIR/server\""
echo "  }"
echo ""
echo "━━━ Browser Extension ━━━"
echo ""
echo "  1. Open chrome://extensions"
echo "  2. Enable 'Developer mode' (top right)"
echo "  3. Click 'Load unpacked'"
echo "  4. Select: $INSTALL_DIR/extension"
echo ""
echo "━━━ Done! ━━━"
