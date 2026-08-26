// Integration tests for multi-browser (multi-profile) routing and per-session
// tab binding. Fake extensions stand in for Chrome profiles: each is a plain
// WebSocket client that answers getTabs with its own tab list and echoes every
// other action back with a marker saying which "browser" handled it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 17862;
const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(serverDir, "index.mjs")],
    env: { ...process.env, CWB_PORT: String(PORT) },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1.0" }, { capabilities: {} });
  return { client, transport };
}

async function callJson(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  try { return { isError: !!res.isError, data: JSON.parse(text), text }; }
  catch { return { isError: !!res.isError, data: null, text }; }
}

// A fake browser profile: answers getTabs from `tabs`, everything else echoes.
function fakeExtension(name, tabs) {
  const ext = {
    name,
    tabs,
    ws: null,
    // action -> handler(params) returning {result} or {error}
    overrides: new Map(),
    focus() { ext.ws.send(JSON.stringify({ type: "focus" })); },
    close() { try { ext.ws.close(); } catch {} },
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on("error", reject);
    ws.on("open", () => { ext.ws = ws; resolve(ext); });
    ws.on("message", (raw) => {
      const { id, action, params } = JSON.parse(raw.toString());
      const override = ext.overrides.get(action);
      if (override) {
        const out = override(params);
        ws.send(JSON.stringify({ id, ...out }));
        return;
      }
      if (action === "getTabs") {
        ws.send(JSON.stringify({ id, result: ext.tabs }));
        return;
      }
      ws.send(JSON.stringify({ id, result: { handledBy: ext.name, action, params } }));
    });
  });
}

let hub, peer, extA, extB;

before(async () => {
  hub = makeClient();
  await hub.client.connect(hub.transport);
  // Hub is listening once connect resolves (role negotiation runs before the
  // MCP transport starts answering).
  extA = await fakeExtension("A", [
    { id: 101, title: "A tab 1", url: "https://a.example/1", active: true, windowId: 11 },
    { id: 102, title: "A tab 2", url: "https://a.example/2", active: false, windowId: 11 },
  ]);
  extB = await fakeExtension("B", [
    { id: 201, title: "B tab 1", url: "https://b.example/1", active: true, windowId: 21 },
  ]);
  await sleep(100); // let the hub register both connections
});

after(async () => {
  try { extA.close(); extB.close(); } catch {}
  try { await hub.client.close(); } catch {}
  if (peer) { try { await peer.client.close(); } catch {} }
});

test("bridge_status reports connected browsers", async () => {
  const { data } = await callJson(hub.client, "bridge_status");
  assert.equal(data.connected, true);
  assert.equal(data.role, "hub");
  assert.equal(data.browsers, 2);
});

test("get_tabs merges tabs from every connected browser", async () => {
  const { data: tabs } = await callJson(hub.client, "get_tabs");
  assert.equal(tabs.length, 3);
  const ids = tabs.map((t) => t.id).sort();
  assert.deepEqual(ids, [101, 102, 201]);
  // Tabs are tagged with the browser connection that owns them.
  const byId = new Map(tabs.map((t) => [t.id, t]));
  assert.ok(byId.get(101).browserId != null);
  assert.equal(byId.get(101).browserId, byId.get(102).browserId);
  assert.notEqual(byId.get(101).browserId, byId.get(201).browserId);
});

test("explicit tabId routes to the browser that owns the tab", async () => {
  const b = await callJson(hub.client, "get_page_content", { tabId: 201 });
  assert.equal(b.data.handledBy, "B");
  assert.equal(b.data.params.tabId, 201);

  const a = await callJson(hub.client, "get_page_content", { tabId: 102 });
  assert.equal(a.data.handledBy, "A");
  assert.equal(a.data.params.tabId, 102);
});

test("unknown tabId fails with a clear error instead of hitting the wrong browser", async () => {
  const res = await callJson(hub.client, "get_page_content", { tabId: 999999 });
  assert.equal(res.isError, true);
  assert.match(res.text, /not found in any connected browser/i);
});

test("focus event moves the default (no tabId) target to that browser", async () => {
  extA.focus();
  await sleep(100);
  let res = await callJson(hub.client, "get_page_content");
  assert.equal(res.data.handledBy, "A");
  assert.equal(res.data.params.tabId, undefined);

  extB.focus();
  await sleep(100);
  res = await callJson(hub.client, "get_page_content");
  assert.equal(res.data.handledBy, "B");
});

test("use_tab binds this session's default tab without focusing it", async () => {
  const bind = await callJson(hub.client, "use_tab", { tabId: 102 });
  assert.equal(bind.data.bound, 102);

  // No tabId passed, but the bound tab is injected and routed to browser A
  // even though B was focused last.
  const res = await callJson(hub.client, "get_page_content");
  assert.equal(res.data.handledBy, "A");
  assert.equal(res.data.params.tabId, 102);

  // Clearing the binding returns to active-tab behavior.
  const clear = await callJson(hub.client, "use_tab");
  assert.equal(clear.data.cleared, true);
  const after = await callJson(hub.client, "get_page_content");
  assert.equal(after.data.params.tabId, undefined);
});

test("navigate newTab auto-binds the created tab to this session", async () => {
  extB.overrides.set("navigate", (params) => ({
    result: { navigated: true, url: params.url, tabId: 777, newTab: true },
  }));
  extB.focus();
  await sleep(100);
  const nav = await callJson(hub.client, "navigate", { url: "https://b.example/new", newTab: true });
  assert.equal(nav.data.tabId, 777);

  const res = await callJson(hub.client, "get_page_content");
  assert.equal(res.data.handledBy, "B");
  assert.equal(res.data.params.tabId, 777);
  extB.overrides.delete("navigate");
});

test("a closed bound tab clears the binding with an actionable error", async () => {
  extB.overrides.set("getPageContent", (params) => {
    if (params.tabId === 777) return { error: "Tab 777 no longer exists" };
    return { result: { handledBy: "B", action: "getPageContent", params } };
  });
  const res = await callJson(hub.client, "get_page_content");
  assert.equal(res.isError, true);
  assert.match(res.text, /binding.*cleared|cleared.*binding/i);

  // Binding is gone: the next call falls back to the active tab.
  const after = await callJson(hub.client, "get_page_content");
  assert.equal(after.data.params.tabId, undefined);
  extB.overrides.delete("getPageContent");
});

test("peer sessions see merged tabs and keep their own independent binding", async () => {
  peer = makeClient();
  await peer.client.connect(peer.transport);
  await sleep(200);

  const status = await callJson(peer.client, "bridge_status");
  assert.equal(status.data.role, "peer");
  assert.equal(status.data.connected, true);

  const { data: tabs } = await callJson(peer.client, "get_tabs");
  assert.equal(tabs.length, 3);

  // Peer binds tab 101; the hub session stays unbound.
  const bind = await callJson(peer.client, "use_tab", { tabId: 101 });
  assert.equal(bind.data.bound, 101);

  const viaPeer = await callJson(peer.client, "get_page_content");
  assert.equal(viaPeer.data.handledBy, "A");
  assert.equal(viaPeer.data.params.tabId, 101);

  const viaHub = await callJson(hub.client, "get_page_content");
  assert.equal(viaHub.data.params.tabId, undefined);
});
