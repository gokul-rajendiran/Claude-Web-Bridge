#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Coercive number type - MCP clients often send numbers as strings
const zNum = z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number());
import { WebSocket, WebSocketServer } from "ws";

// ── State ──────────────────────────────────────────────────────────────────
// Several browser profiles can be connected at once — each Chrome profile runs
// its own copy of the extension and opens its own socket. Tabs are routed to
// the connection that owns them; ignoring all but one socket is what used to
// make every window outside the last-connected profile invisible.
const extensions = new Map();   // connId -> extension WebSocket
let extNextConnId = 0;
let lastFocusedConnId = null;   // which browser the user touched last
const tabRoutes = new Map();    // tabId -> connId that owns the tab
let pendingRequests = new Map();
let requestId = 0;
// This session's default tab. Each Claude session runs its own server process,
// so this is naturally per-session state — it lets concurrent sessions work in
// different tabs without fighting over the browser's single focused tab.
let sessionTabId = null;
const WS_PORT = Number(process.env.CWB_PORT || 7862);

// ── Optional takeover of the port ─────────────────────────────────────────
// This used to unconditionally SIGTERM whoever held the port. One server per
// Claude session plus that kill turned two concurrent sessions into a war: each
// new server killed the incumbent, whose client restarted it, which killed the
// new one, forever. The extension followed the winner around and every session
// saw intermittent "extension is not connected".
//
// A crashed process releases its listening socket, so a truly dead server never
// holds the port — only a live one does, and killing that is what caused the
// thrashing. So default to leaving it alone. Set CWB_TAKEOVER=1 to reclaim the
// port from a wedged or orphaned server.
if (process.env.CWB_TAKEOVER === "1") {
  const { execSync } = await import("child_process");
  try {
    // -sTCP:LISTEN so we only match the server, not clients (e.g. Chrome)
    // holding an established connection to the port.
    const pids = execSync(`lsof -ti :${WS_PORT} -sTCP:LISTEN 2>/dev/null`).toString().trim();
    if (pids) {
      for (const pid of pids.split("\n")) {
        if (pid && Number(pid) !== process.pid) {
          try { process.kill(Number(pid), "SIGTERM"); } catch {}
        }
      }
      await new Promise(r => setTimeout(r, 500));
      console.error(`[claude-web-bridge] CWB_TAKEOVER=1 — killed process(es) holding port ${WS_PORT}`);
    }
  } catch {}
}

// ── Hub / peer role ───────────────────────────────────────────────────────
// Every Claude session starts its own bridge server, but the extension holds a
// single WebSocket to a single port, so only one process can own the browser.
// Rather than let sessions fight for it, the first server to bind becomes the
// HUB and owns the extension; every later server becomes a PEER and forwards its
// tool calls through the hub. Several sessions can then drive one browser.
//
// Peers are told apart from the extension by connection path, so the extension
// needs no changes — it still connects to "/".
const PEER_PATH = "/peer";
const EXT_NOT_CONNECTED =
  "Browser extension is not connected. Please open the extension and click Connect.";

let role = null;             // "hub" | "peer" | null while negotiating
let wss = null;              // hub: the WebSocket server
let hubSocket = null;        // peer: our client connection to the hub
const peerSockets = new Set();  // hub: connected peer servers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Hub side ──────────────────────────────────────────────────────────────
function tryBecomeHub() {
  return new Promise((resolve) => {
    // No host given, so this binds the same interfaces as before. The extension
    // reaches the port over IPv6 loopback, so do not narrow this to 127.0.0.1.
    const server = new WebSocketServer({ port: WS_PORT });
    const onError = (err) => {
      server.off("listening", onListening);
      if (err.code !== "EADDRINUSE") {
        console.error("[claude-web-bridge] WebSocket server error:", err.message);
      }
      try { server.close(); } catch {}
      resolve(false);
    };
    const onListening = () => {
      server.off("error", onError);
      server.on("error", (e) => console.error("[claude-web-bridge] Hub error:", e.message));
      wss = server;
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function setupHub() {
  wss.on("connection", (ws, req) => {
    if ((req?.url || "/") === PEER_PATH) attachPeer(ws);
    else attachExtension(ws);
  });
}

function attachExtension(ws) {
  const connId = ++extNextConnId;
  ws.connId = connId;
  extensions.set(connId, ws);
  // Best guess until a focus event arrives: the browser that connected most
  // recently is the one the user is looking at.
  lastFocusedConnId = connId;
  console.error(`[claude-web-bridge] Extension connected (browser ${connId}, ${extensions.size} total)`);
  ws.lastSeenAt = Date.now();

  ws.on("pong", () => { ws.lastSeenAt = Date.now(); });

  ws.on("message", (raw) => {
    ws.lastSeenAt = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      // Ignore keepalive pings from the extension
      if (msg.type === "ping") return;
      // The user focused a window of this browser — make it the default target.
      if (msg.type === "focus") { lastFocusedConnId = connId; return; }

      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      }
    } catch (e) {
      console.error("[claude-web-bridge] Bad message from extension:", e.message);
    }
  });

  ws.on("close", () => {
    extensions.delete(connId);
    console.error(`[claude-web-bridge] Extension disconnected (browser ${connId}, ${extensions.size} left)`);
    // Only fail the requests that were waiting on THIS browser.
    for (const [id, pending] of pendingRequests) {
      if (pending.connId === connId) {
        pendingRequests.delete(id);
        pending.reject(new Error("Extension disconnected"));
      }
    }
    for (const [tabId, owner] of tabRoutes) {
      if (owner === connId) tabRoutes.delete(tabId);
    }
    if (lastFocusedConnId === connId) {
      const remaining = [...liveExtensions()];
      lastFocusedConnId = remaining.length ? remaining[remaining.length - 1].connId : null;
    }
  });
}

function* liveExtensions() {
  for (const ws of extensions.values()) {
    if (ws.readyState === 1) yield ws;
  }
}

// Send one request to one extension socket and await its reply.
function sendToConn(ws, action, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, {
      connId: ws.connId,
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); },
    });
    try {
      ws.send(JSON.stringify({ id, action, params }));
    } catch (e) {
      clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(e);
    }
  });
}

// Ask every connected browser for its tabs, merge, and refresh tab routing.
// Partial answers are fine — a browser that fails to answer just contributes
// nothing rather than failing the whole call.
async function mergedGetTabs(timeoutMs = 10000) {
  const live = [...liveExtensions()];
  const settled = await Promise.allSettled(
    live.map((ws) =>
      sendToConn(ws, "getTabs", {}, Math.min(timeoutMs, 10000)).then((tabs) => ({ ws, tabs })))
  );
  const answers = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  if (answers.length === 0) {
    throw settled[0]?.reason || new Error(EXT_NOT_CONNECTED);
  }
  const merged = [];
  for (const { ws, tabs } of answers) {
    for (const t of tabs) {
      tabRoutes.set(t.id, ws.connId);
      merged.push({ ...t, browserId: ws.connId });
    }
  }
  return merged;
}

// Hub-side dispatch: pick the extension socket that should handle this action.
// Explicit tabIds route to the browser that owns the tab; everything else goes
// to the browser the user focused last.
async function dispatchToBrowser(action, params = {}, timeoutMs = 30000) {
  let live = [...liveExtensions()];
  if (live.length === 0) throw new Error(EXT_NOT_CONNECTED);

  if (action === "getTabs") return mergedGetTabs(timeoutMs);

  let target = null;
  if (params.tabId != null) {
    let owner = tabRoutes.get(params.tabId);
    if (owner == null || !extensions.get(owner) || extensions.get(owner).readyState !== 1) {
      // Route unknown or stale — rebuild routes and look again.
      await mergedGetTabs(5000).catch(() => {});
      owner = tabRoutes.get(params.tabId);
      live = [...liveExtensions()]; // a browser may have dropped during the refresh
    }
    if (owner != null && extensions.get(owner)?.readyState === 1) {
      target = extensions.get(owner);
    } else if (live.length === 1) {
      // A single browser can answer for its own tabs (it may be mid-navigation
      // and missing from the last snapshot); let it report its own error.
      target = live[0];
    } else {
      throw new Error(
        `Tab ${params.tabId} was not found in any connected browser ` +
        `(${live.length} connected). It may have been closed — use get_tabs to list current tabs.`
      );
    }
  } else {
    target = extensions.get(lastFocusedConnId);
    if (!target || target.readyState !== 1) target = live[live.length - 1];
  }

  const result = await sendToConn(target, action, params, timeoutMs);
  // Results that name a tab teach us its route (e.g. navigate with newTab).
  if (result && typeof result === "object" && typeof result.tabId === "number") {
    tabRoutes.set(result.tabId, target.connId);
  }
  return result;
}

function attachPeer(ws) {
  peerSockets.add(ws);
  console.error(`[claude-web-bridge] Peer session connected (${peerSockets.size} peer(s))`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "status") {
      sendJson(ws, {
        type: "response", id: msg.id,
        result: {
          connected: isExtensionLive(), role: "hub",
          peers: peerSockets.size, browsers: [...liveExtensions()].length,
        },
      });
      return;
    }
    if (msg.type === "request") relayPeerRequest(ws, msg);
  });

  ws.on("close", () => {
    peerSockets.delete(ws);
    console.error(`[claude-web-bridge] Peer session disconnected (${peerSockets.size} peer(s))`);
  });
}

function relayPeerRequest(peerWs, msg) {
  // Give the peer's own timer the first chance to fire, so the caller sees its
  // own timeout rather than a racing one from here.
  const timeoutMs = (msg.timeoutMs || 30000) + 2000;
  dispatchToBrowser(msg.action, msg.params || {}, timeoutMs)
    .then((result) => sendJson(peerWs, { type: "response", id: msg.id, result }))
    .catch((err) => sendJson(peerWs, { type: "response", id: msg.id, error: err.message }));
}

// ── Peer side ─────────────────────────────────────────────────────────────
function connectToHub() {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(`ws://localhost:${WS_PORT}${PEER_PATH}`); }
    catch { resolve(false); return; }

    const fail = () => { try { ws.terminate(); } catch {} resolve(false); };
    ws.once("error", fail);
    ws.once("open", () => {
      ws.off("error", fail);
      ws.on("error", (e) => console.error("[claude-web-bridge] Hub link error:", e.message));
      hubSocket = ws;
      setupPeer(ws);
      resolve(true);
    });
  });
}

function setupPeer(ws) {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "response") return;
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  });

  ws.on("close", () => {
    if (hubSocket !== ws) return;
    hubSocket = null;
    role = null;
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error("Bridge hub disconnected"));
      pendingRequests.delete(id);
    }
    console.error("[claude-web-bridge] Hub went away — renegotiating role");
    negotiateRole();
  });
}

function sendViaHub(action, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!hubSocket || hubSocket.readyState !== 1) {
      reject(new Error("Not connected to the bridge hub yet. Retry in a moment."));
      return;
    }
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); },
    });
    sendJson(hubSocket, { type: "request", id, action, params, timeoutMs });
  });
}

function requestHubStatus() {
  return new Promise((resolve, reject) => {
    if (!hubSocket || hubSocket.readyState !== 1) {
      reject(new Error("Not connected to the bridge hub"));
      return;
    }
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Hub status request timed out"));
    }, 5000);
    pendingRequests.set(id, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); },
    });
    sendJson(hubSocket, { type: "status", id });
  });
}

// ── Role negotiation ──────────────────────────────────────────────────────
function isExtensionLive() {
  for (const _ of liveExtensions()) return true;
  return false;
}

function sendJson(ws, payload) {
  try { ws.send(JSON.stringify(payload)); } catch {}
}

let negotiating = false;

async function negotiateRole() {
  if (negotiating) return;
  negotiating = true;
  try {
    for (let attempt = 0; ; attempt++) {
      if (await tryBecomeHub()) {
        role = "hub";
        setupHub();
        console.error(`[claude-web-bridge] Hub: listening on ws://localhost:${WS_PORT}`);
        return;
      }
      // Someone else holds the port. Jitter first so several peers starting at
      // once do not stampede the hub with simultaneous connects.
      await sleep(50 + Math.floor(Math.random() * 250));
      if (await connectToHub()) {
        role = "peer";
        console.error(
          `[claude-web-bridge] Peer: another session owns the browser; ` +
          `forwarding tool calls through it.`
        );
        return;
      }
      // Neither worked — the hub may be mid-restart. Back off and retry.
      const backoff = Math.min(5000, 250 * 2 ** attempt);
      if (attempt === 3) {
        console.error(
          `[claude-web-bridge] Could not bind port ${WS_PORT} or reach a hub on it. ` +
          `Retrying in the background; browser tools will error until this resolves.`
        );
      }
      await sleep(backoff);
    }
  } finally {
    negotiating = false;
  }
}

// ── Heartbeat: detect a socket the extension has silently abandoned ───────
// Chrome suspends MV3 service workers, which can leave a half-open socket that
// the OS still reports as ESTABLISHED while no messages ever arrive. Without
// this, bridge_status reports a connection that cannot actually answer, and
// every tool call waits for a timeout instead of failing fast. The extension
// pings every 18s (chrome.alarms), so 60s of silence means two missed pings.
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 60000;

setInterval(() => {
  if (role !== "hub") return;  // only the hub holds extension sockets
  for (const ws of extensions.values()) {
    if (Date.now() - (ws.lastSeenAt || 0) > HEARTBEAT_TIMEOUT_MS) {
      console.error(
        `[claude-web-bridge] Extension socket (browser ${ws.connId}) silent for over ` +
        `${HEARTBEAT_TIMEOUT_MS / 1000}s — dropping it so the extension can reconnect.`
      );
      // terminate() fires "close", which cleans up state for this connection.
      try { ws.terminate(); } catch {}
      continue;
    }
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS).unref();

await negotiateRole();

// ── Helper: send command to extension and await response ──────────────────
function sendToExtensionOnce(action, params = {}, timeoutMs = 30000) {
  // A peer does not hold the extension sockets — the hub does. Forward instead.
  if (role === "peer") return sendViaHub(action, params, timeoutMs);
  if (role === null) {
    return Promise.reject(new Error(
      "Bridge is still deciding which session owns the browser. Retry in a moment."
    ));
  }
  return dispatchToBrowser(action, params, timeoutMs);
}

// Retry wrapper for transient errors (tab dragging, debugger busy, etc.)
const RETRYABLE_ERRORS = [
  "Tabs cannot be edited right now",
  "Cannot access a chrome",
  "Debugger is not attached",
  "Target closed",
  "Another debugger is already attached",
];

async function sendToExtension(action, params = {}, timeoutMs = 30000, maxRetries = 3) {
  // When the caller names no tab, target this session's bound tab (use_tab)
  // rather than whatever tab happens to be focused — concurrent sessions each
  // keep their own binding, so they can work in different tabs simultaneously.
  let boundTabInjected = false;
  if (params.tabId == null && sessionTabId != null && action !== "getTabs") {
    params = { ...params, tabId: sessionTabId };
    boundTabInjected = true;
  }

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await sendToExtensionOnce(action, params, timeoutMs);
    } catch (err) {
      lastError = err;
      if (boundTabInjected && /no longer exists|not found in any connected browser/.test(err.message)) {
        const closed = sessionTabId;
        sessionTabId = null;
        throw new Error(
          `This session's bound tab ${closed} no longer exists (it was probably closed); ` +
          `the binding has been cleared. Call get_tabs and use_tab to bind a new tab, ` +
          `or retry to target the active tab.`
        );
      }
      const isRetryable = RETRYABLE_ERRORS.some(msg => err.message.includes(msg));
      if (!isRetryable || attempt === maxRetries - 1) throw err;
      // Wait before retrying (exponential backoff: 500ms, 1000ms, 2000ms)
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      console.error(`[claude-web-bridge] Retrying ${action} (attempt ${attempt + 2}/${maxRetries}): ${err.message}`);
    }
  }
  throw lastError;
}

// ── Shared tabId schema ───────────────────────────────────────────────────
const tabIdParam = zNum.optional().describe(
  "Target tab ID (from get_tabs). Omit to use this session's bound tab (see use_tab) " +
  "or, if none is bound, the active tab of the last-focused browser window. Passing a " +
  "tabId acts on that tab without focusing or switching to it, so it does not disturb " +
  "what the user is looking at. When several browser profiles are connected, the tabId " +
  "is routed to the browser that owns the tab automatically. Tab IDs are not stable " +
  "across reloads — re-check with get_tabs if a tab may have navigated."
);

// ── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "claude-web-bridge",
  version: "1.0.0",
});

// Tool: connection status
server.tool(
  "bridge_status",
  "Check if the browser extension is connected. Also reports this server's role: " +
  "'hub' means it owns the extension connection directly, 'peer' means another " +
  "Claude session owns it and this server forwards tool calls through that one. " +
  "Either way the browser tools work; the role is diagnostic.",
  {},
  async () => {
    const status = { ws_port: WS_PORT, role, pending_requests: pendingRequests.size };
    status.session_bound_tab = sessionTabId;
    if (role === "hub") {
      status.connected = isExtensionLive();
      status.browsers = [...liveExtensions()].length;
      status.peer_sessions = peerSockets.size;
    } else if (role === "peer") {
      status.hub_link = hubSocket && hubSocket.readyState === 1 ? "up" : "down";
      // Extension connectivity is the hub's to report, so ask it.
      try {
        const hub = await requestHubStatus();
        status.connected = hub.connected;
        status.browsers = hub.browsers;
        status.peer_sessions = hub.peers;
      } catch (e) {
        status.connected = false;
        status.error = `Could not reach the hub: ${e.message}`;
      }
    } else {
      status.connected = false;
      status.error = "Still negotiating which session owns the browser.";
    }
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

// Tool: get full page content
server.tool(
  "get_page_content",
  "Get the full text content of a browser tab",
  { tabId: tabIdParam },
  async ({ tabId }) => {
    const result = await sendToExtension("getPageContent", { tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: get page metadata
server.tool(
  "get_page_metadata",
  "Get metadata of a page (URL, title, meta tags, OpenGraph, etc.)",
  { tabId: tabIdParam },
  async ({ tabId }) => {
    const result = await sendToExtension("getPageMetadata", { tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: get page HTML
server.tool(
  "get_page_html",
  "Get the HTML of a page or a specific selector",
  {
    selector: z.string().optional().describe("CSS selector to get HTML of (defaults to full page)"),
    tabId: tabIdParam,
  },
  async ({ selector, tabId }) => {
    const result = await sendToExtension("getPageHtml", { selector, tabId });
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool: query selector
server.tool(
  "query_selector",
  "Query DOM elements matching a CSS selector. Each result includes text, attributes, " +
  "childCount, boundingBox, and a `visible` flag (false for zero-size elements). Use " +
  "`visible` to tell a rendered element from an offscreen template clone — apps often " +
  "keep hidden 0x0 template copies of dialogs in the DOM alongside the live one. " +
  "Returns `matched` (total hits) and `showing` (returned after the limit).",
  {
    selector: z.string().describe("CSS selector to query"),
    limit: zNum.optional().describe("Max results (default 50)"),
    tabId: tabIdParam,
  },
  async ({ selector, limit, tabId }) => {
    const result = await sendToExtension("querySelectorAll", { selector, limit: limit || 50, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: get all links
server.tool(
  "get_page_links",
  "Get all links on a page with their text and URLs",
  { tabId: tabIdParam },
  async ({ tabId }) => {
    const result = await sendToExtension("getPageLinks", { tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: get forms
server.tool(
  "get_page_forms",
  "Get all forms on a page with their inputs and current values",
  { tabId: tabIdParam },
  async ({ tabId }) => {
    const result = await sendToExtension("getPageForms", { tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: get tables
server.tool(
  "get_page_tables",
  "Extract tables from a page as structured data",
  {
    selector: z.string().optional().describe("CSS selector for specific table (defaults to all)"),
    tabId: tabIdParam,
  },
  async ({ selector, tabId }) => {
    const result = await sendToExtension("getPageTables", { selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: click element
server.tool(
  "click_element",
  "Click an element on a page by CSS selector",
  {
    selector: z.string().describe("CSS selector of element to click"),
    tabId: tabIdParam,
  },
  async ({ selector, tabId }) => {
    const result = await sendToExtension("clickElement", { selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: fill input
server.tool(
  "fill_input",
  "Fill a form input with a value",
  {
    selector: z.string().describe("CSS selector of the input"),
    value: z.string().describe("Value to fill"),
    tabId: tabIdParam,
  },
  async ({ selector, value, tabId }) => {
    const result = await sendToExtension("fillInput", { selector, value, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: select option
server.tool(
  "select_option",
  "Select an option in a <select> dropdown",
  {
    selector: z.string().describe("CSS selector of the <select> element"),
    value: z.string().describe("Value of the option to select"),
    tabId: tabIdParam,
  },
  async ({ selector, value, tabId }) => {
    const result = await sendToExtension("selectOption", { selector, value, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: scroll
server.tool(
  "scroll_page",
  "Scroll a page in a direction or to a specific element",
  {
    direction: z.enum(["up", "down", "top", "bottom"]).optional().describe("Scroll direction"),
    selector: z.string().optional().describe("CSS selector to scroll to (overrides direction)"),
    amount: zNum.optional().describe("Pixels to scroll (for up/down)"),
    tabId: tabIdParam,
  },
  async ({ direction, selector, amount, tabId }) => {
    const result = await sendToExtension("scrollPage", { direction, selector, amount, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: navigate
server.tool(
  "navigate",
  "Navigate a tab to a URL, or open a URL in a new tab. Waits for the page to fully load before returning.",
  {
    url: z.string().describe("URL to navigate to"),
    newTab: z.boolean().optional().describe("Open in a new tab instead of the current one (returns the new tabId)"),
    tabId: tabIdParam,
  },
  async ({ url, newTab, tabId }) => {
    const result = await sendToExtension("navigate", { url, newTab, tabId }, 30000);
    // A tab this session just created becomes its default target, so parallel
    // sessions can each open and drive their own tab without extra plumbing.
    if (result?.newTab && typeof result.tabId === "number") {
      sessionTabId = result.tabId;
      result.note = `This session now targets tab ${result.tabId} by default (use_tab to change).`;
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: execute JavaScript
server.tool(
  "execute_js",
  "Execute custom JavaScript in a page and return a structured result.\n" +
  "\n" +
  "Realm: runs in the page's MAIN world, so it sees the page's own globals, " +
  "frameworks, and functions — not an isolated sandbox.\n" +
  "\n" +
  "State: values you set on `window.*` PERSIST across separate execute_js calls, so " +
  "instrumentation can be installed in one call and read in a later one. This state " +
  "does NOT survive a page load; a reload silently discards it.\n" +
  "\n" +
  "Result shape: `{ok: true, value, navigationId, documentChanged}` on success, or " +
  "`{ok: false, error: {reason, message, stack}, ...}` on failure. `reason` is one of " +
  "exception | syntax | evaluation | no_result. Errors are never reported as a " +
  "successful null.\n" +
  "\n" +
  "Detecting lost state: `navigationId` increments when the document is replaced, and " +
  "`documentChanged: true` means the page navigated since your previous call — treat " +
  "anything you injected earlier as gone rather than assuming it is still installed.\n" +
  "\n" +
  "Return values must be JSON-serializable; non-serializable values come back as " +
  "`{__unserializable: \"...\"}` instead of being silently dropped. Output is not " +
  "size-capped, so avoid returning large DOM dumps (e.g. mapping every element in " +
  "document.body) — select and shape the data in-page instead.",
  {
    code: z.string().describe("JavaScript code to execute. `await` is available at top level; return a value or a Promise."),
    tabId: tabIdParam,
  },
  async ({ code, tabId }) => {
    const result = await sendToExtension("executeJs", { code, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: set contenteditable text
server.tool(
  "set_content_editable",
  "Replace the text content of a contenteditable element (rich text editors, LinkedIn About, etc.)",
  {
    selector: z.string().describe("CSS selector of the contenteditable element"),
    text: z.string().describe("New text content to set"),
    tabId: tabIdParam,
  },
  async ({ selector, text, tabId }) => {
    const result = await sendToExtension("setContentEditable", { selector, text, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: take screenshot
server.tool(
  "take_screenshot",
  "Capture a screenshot of a browser tab (returns PNG image)",
  { tabId: tabIdParam },
  async ({ tabId }) => {
    const result = await sendToExtension("takeScreenshot", { tabId });
    return {
      content: [{
        type: "image",
        data: result.dataUrl.replace(/^data:image\/png;base64,/, ""),
        mimeType: "image/png",
      }],
    };
  }
);

// Tool: get tab info
server.tool(
  "get_tabs",
  "List all open browser tabs with their IDs, titles, and URLs — merged across every " +
  "connected browser profile/window (each tab's browserId says which browser owns it). " +
  "Use tab IDs to target specific tabs in other tools; they are routed to the right " +
  "browser automatically. A Chrome profile only appears here if the extension is " +
  "installed and connected in that profile.",
  {},
  async () => {
    const result = await sendToExtension("getTabs");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: switch tab
server.tool(
  "switch_tab",
  "Switch to a different browser tab (makes it the active/visible tab and focuses its " +
  "window — this disturbs what the user is looking at). Also makes it this session's " +
  "default tab. To work on a tab in the background instead, use use_tab.",
  { tabId: zNum.describe("Tab ID to switch to (get IDs from get_tabs)") },
  async ({ tabId }) => {
    const result = await sendToExtension("switchTab", { tabId });
    sessionTabId = tabId;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: bind this session to a tab
server.tool(
  "use_tab",
  "Bind this Claude session to a tab: every later tool call that omits tabId targets " +
  "the bound tab instead of the focused one, without focusing or switching to it. This " +
  "lets several Claude sessions work in different tabs of the same browser at the same " +
  "time without interfering. Call with no tabId to clear the binding and go back to " +
  "targeting the active tab.",
  { tabId: zNum.optional().describe("Tab ID to bind (from get_tabs). Omit to clear the binding.") },
  async ({ tabId }) => {
    if (tabId == null) {
      const previous = sessionTabId;
      sessionTabId = null;
      return { content: [{ type: "text", text: JSON.stringify({ cleared: true, previous }, null, 2) }] };
    }
    const tabs = await sendToExtension("getTabs");
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} was not found in any connected browser. Use get_tabs to list current tabs.`);
    }
    sessionTabId = tabId;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ bound: tabId, title: tab.title, url: tab.url, browserId: tab.browserId }, null, 2),
      }],
    };
  }
);

// Tool: wait for element
server.tool(
  "wait_for_element",
  "Wait for an element matching a selector to be present in the DOM. Note this tests " +
  "presence, not visibility: it resolves immediately for a hidden 0x0 template that " +
  "matches the selector. To wait for something the user can actually see, poll " +
  "query_selector and check its `visible` flag.",
  {
    selector: z.string().describe("CSS selector to wait for"),
    timeout: zNum.optional().describe("Max wait time in ms (default 10000)"),
    tabId: tabIdParam,
  },
  async ({ selector, timeout, tabId }) => {
    const result = await sendToExtension("waitForElement", { selector, timeout: timeout || 10000, tabId }, (timeout || 10000) + 5000);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: type text with keyboard events
server.tool(
  "type_text",
  "Type text into the focused element using keyboard events (simulates real typing)",
  {
    text: z.string().describe("Text to type"),
    selector: z.string().optional().describe("CSS selector to focus first"),
    tabId: tabIdParam,
  },
  async ({ text, selector, tabId }) => {
    const result = await sendToExtension("typeText", { text, selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: press key
server.tool(
  "press_key",
  "Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.)",
  {
    key: z.string().describe("Key to press (e.g., 'Enter', 'Escape', 'Tab')"),
    modifiers: z.array(z.enum(["ctrl", "shift", "alt", "meta"])).optional().describe("Modifier keys to hold"),
    tabId: tabIdParam,
  },
  async ({ key, modifiers, tabId }) => {
    const result = await sendToExtension("pressKey", { key, modifiers, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: play media
server.tool(
  "play_media",
  "Play a video or audio element on the page. Uses muted autoplay trick to bypass browser restrictions, then unmutes.",
  {
    selector: z.string().optional().describe("CSS selector of the media element (defaults to first video/audio on page)"),
    tabId: tabIdParam,
  },
  async ({ selector, tabId }) => {
    const result = await sendToExtension("playMedia", { selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: pause media
server.tool(
  "pause_media",
  "Pause a video or audio element on the page",
  {
    selector: z.string().optional().describe("CSS selector of the media element (defaults to first video/audio on page)"),
    tabId: tabIdParam,
  },
  async ({ selector, tabId }) => {
    const result = await sendToExtension("pauseMedia", { selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: get media state
server.tool(
  "get_media_state",
  "Get the current state of a video/audio element (playing, paused, volume, time, etc.)",
  {
    selector: z.string().optional().describe("CSS selector of the media element (defaults to first video/audio on page)"),
    tabId: tabIdParam,
  },
  async ({ selector, tabId }) => {
    const result = await sendToExtension("getMediaState", { selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: set volume
server.tool(
  "set_volume",
  "Set the volume of a video/audio element (0.0 to 1.0) and unmute it",
  {
    volume: zNum.describe("Volume level from 0.0 (silent) to 1.0 (full)"),
    selector: z.string().optional().describe("CSS selector of the media element (defaults to first video/audio on page)"),
    tabId: tabIdParam,
  },
  async ({ volume, selector, tabId }) => {
    const result = await sendToExtension("setVolume", { volume, selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: seek media
server.tool(
  "seek_media",
  "Seek a video/audio element to a specific time in seconds",
  {
    time: zNum.describe("Time in seconds to seek to"),
    selector: z.string().optional().describe("CSS selector of the media element (defaults to first video/audio on page)"),
    tabId: tabIdParam,
  },
  async ({ time, selector, tabId }) => {
    const result = await sendToExtension("seekMedia", { time, selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: click at coordinates
server.tool(
  "click_at_coordinates",
  "Click at specific x,y coordinates on the page. Useful when CSS selectors are hard to determine but you can see the element in a screenshot.",
  {
    x: zNum.describe("X coordinate (pixels from left)"),
    y: zNum.describe("Y coordinate (pixels from top)"),
    tabId: tabIdParam,
  },
  async ({ x, y, tabId }) => {
    const result = await sendToExtension("clickAtCoordinates", { x, y, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool: wait for navigation / page load
server.tool(
  "wait_for_page_load",
  "Wait for the current page to finish loading (useful after clicks that trigger navigation)",
  {
    timeout: zNum.optional().describe("Max wait time in ms (default 15000)"),
    tabId: tabIdParam,
  },
  async ({ timeout, tabId }) => {
    const result = await sendToExtension("waitForPageLoad", { timeout: timeout || 15000, tabId }, (timeout || 15000) + 5000);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[claude-web-bridge] MCP server started");
