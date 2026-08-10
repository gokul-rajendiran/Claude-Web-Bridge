// ── Claude Web Bridge - Background Service Worker ──────────────────────────
const WS_URL = "ws://localhost:7862";
let socket = null;
let isConnected = false;
let autoReconnect = true;
let reconnectTimer = null;

// ── WebSocket Connection ───────────────────────────────────────────────────
function connect(opts = {}) {
  const { silent = false, auto = false } = opts;
  if (socket && socket.readyState <= 1) return; // Already connecting or open

  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    if (!silent) console.error("[bridge] Failed to create WebSocket:", e);
    updateBadge(false);
    if (auto) scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log("[bridge] Connected to MCP server");
    isConnected = true;
    autoReconnect = true;
    updateBadge(true);
    clearReconnect();
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      const { id, action, params } = msg;
      let result;
      try {
        result = await handleAction(action, params || {});
        socket.send(JSON.stringify({ id, result }));
      } catch (err) {
        socket.send(JSON.stringify({ id, error: err.message }));
      }
    } catch (e) {
      console.error("[bridge] Failed to handle message:", e);
    }
  };

  socket.onclose = () => {
    const wasConnected = isConnected;
    isConnected = false;
    updateBadge(false);
    socket = null;
    if (wasConnected) console.log("[bridge] Disconnected from MCP server");
    if (autoReconnect) scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after this — avoid noisy logging when server isn't up
    isConnected = false;
    updateBadge(false);
  };
}

function scheduleReconnect() {
  clearReconnect();
  reconnectTimer = setTimeout(() => connect({ silent: true, auto: true }), 1500);
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function disconnect() {
  autoReconnect = false;
  clearReconnect();
  if (socket) {
    socket.close();
    socket = null;
  }
  isConnected = false;
  updateBadge(false);
}

function updateBadge(connected) {
  const color = connected ? "#22c55e" : "#ef4444";
  const text = connected ? "ON" : "";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

// ── execute_js document tracking ───────────────────────────────────────────
// A page reload destroys everything execute_js injected into window.*, and
// nothing in a plain result would reveal that. We stamp a token on the page
// realm and compare it across calls, so each response can tell the caller
// whether it is still talking to the same document.
const docTokens = new Map();  // tabId -> last token seen in the page
const navCounters = new Map(); // tabId -> monotonic document epoch

function trackDocument(tabId, token) {
  const previous = docTokens.get(tabId);
  let navigationId = navCounters.get(tabId) ?? 1;

  if (previous !== token) {
    // First call against this tab, or the document was replaced.
    if (previous !== undefined) navigationId += 1;
    docTokens.set(tabId, token);
    navCounters.set(tabId, navigationId);
    return { navigationId, documentChanged: previous !== undefined };
  }
  return { navigationId, documentChanged: false };
}

// Forget tracking for tabs that no longer exist, so ids never go stale.
chrome.tabs.onRemoved.addListener((tabId) => {
  docTokens.delete(tabId);
  navCounters.delete(tabId);
});

// ── Get Active Tab ─────────────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

// ── Execute in content script context ──────────────────────────────────────
async function executeInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (results && results[0]) {
    if (results[0].error) throw new Error(results[0].error.message);
    return results[0].result;
  }
  return null;
}

// ── Action Router ──────────────────────────────────────────────────────────
async function handleAction(action, params) {
  // Multi-tab support: use params.tabId if provided, otherwise fall back to active tab
  let tabId;
  if (params.tabId) {
    tabId = params.tabId;
    // Verify the tab still exists
    try { await chrome.tabs.get(tabId); } catch {
      throw new Error(`Tab ${tabId} no longer exists`);
    }
  } else {
    const tab = await getActiveTab();
    tabId = tab.id;
  }

  switch (action) {
    case "getPageContent":
      return executeInTab(tabId, () => {
        return {
          url: document.URL,
          title: document.title,
          text: document.body.innerText,
          readableLength: document.body.innerText.length,
        };
      });

    case "getPageMetadata":
      return executeInTab(tabId, () => {
        const metas = {};
        document.querySelectorAll("meta").forEach((m) => {
          const key = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv");
          if (key) metas[key] = m.getAttribute("content");
        });
        const links = {};
        document.querySelectorAll("link[rel]").forEach((l) => {
          links[l.getAttribute("rel")] = l.getAttribute("href");
        });
        return {
          url: document.URL,
          title: document.title,
          description: metas["description"] || metas["og:description"] || "",
          metas,
          links,
          lang: document.documentElement.lang,
          charset: document.characterSet,
        };
      });

    case "getPageHtml":
      return executeInTab(tabId, (sel) => {
        if (sel) {
          const el = document.querySelector(sel);
          return el ? el.outerHTML : `No element found for selector: ${sel}`;
        }
        return document.documentElement.outerHTML;
      }, [params.selector || null]);

    case "querySelectorAll": {
      const qsResult = await executeInTab(tabId, (sel, limit) => {
        var elements;
        try {
          elements = Array.from(document.querySelectorAll(sel)).slice(0, limit);
        } catch (e) {
          throw new Error(`Invalid CSS selector: "${sel}" — ${e.message}`);
        }
        if (elements.length === 0) {
          return { matched: 0, selector: sel, elements: [] };
        }
        return {
          matched: document.querySelectorAll(sel).length,
          showing: elements.length,
          elements: elements.map((el, i) => {
            const rect = el.getBoundingClientRect();
            const attrs = {};
            for (const attr of el.attributes) {
              attrs[attr.name] = attr.value;
            }
            // Include a snippet of innerHTML for context (first 300 chars)
            var htmlSnippet = el.innerHTML?.substring(0, 300) || "";
            // Count direct children
            var childSummary = Array.from(el.children).slice(0, 5).map(function(c) {
              return c.tagName.toLowerCase() + (c.id ? "#" + c.id : "") + (c.className ? "." + c.className.split(" ")[0] : "");
            });
            return {
              index: i,
              tag: el.tagName.toLowerCase(),
              text: el.innerText?.substring(0, 500) || "",
              attributes: attrs,
              innerHTML: htmlSnippet,
              children: childSummary,
              childCount: el.children.length,
              boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              visible: rect.width > 0 && rect.height > 0,
            };
          }),
        };
      }, [params.selector, params.limit || 50]);
      return qsResult;
    }

    case "getPageLinks":
      return executeInTab(tabId, () => {
        return Array.from(document.querySelectorAll("a[href]")).map((a) => ({
          text: a.innerText.trim().substring(0, 200),
          href: a.href,
          target: a.target || "_self",
        }));
      });

    case "getPageForms":
      return executeInTab(tabId, () => {
        return Array.from(document.querySelectorAll("form")).map((form, fi) => {
          const inputs = Array.from(form.querySelectorAll("input, textarea, select, button")).map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || "",
            name: el.name || "",
            id: el.id || "",
            value: el.value || "",
            placeholder: el.placeholder || "",
            required: el.required || false,
            options: el.tagName === "SELECT"
              ? Array.from(el.options).map((o) => ({ value: o.value, text: o.text, selected: o.selected }))
              : undefined,
          }));
          return {
            index: fi,
            id: form.id || "",
            action: form.action || "",
            method: form.method || "get",
            inputs,
          };
        });
      });

    case "getPageTables":
      return executeInTab(tabId, (sel) => {
        const tables = sel
          ? Array.from(document.querySelectorAll(sel))
          : Array.from(document.querySelectorAll("table"));
        return tables.map((table, ti) => {
          const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map((th) => th.innerText.trim());
          const rows = Array.from(table.querySelectorAll("tbody tr, tr")).slice(headers.length ? 0 : 1).map((tr) =>
            Array.from(tr.querySelectorAll("td, th")).map((td) => td.innerText.trim())
          );
          return { index: ti, headers, rows, rowCount: rows.length };
        });
      }, [params.selector || null]);

    case "clickElement": {
      // Get element position for trusted click via debugger
      const clickInfo = await executeInTab(tabId, (sel) => {
        const el = document.querySelector(sel);
        if (!el) {
          // Provide helpful error with count of partial matches
          var matchCount = 0;
          try { matchCount = document.querySelectorAll(sel).length; } catch (e) {
            throw new Error(`Invalid CSS selector: "${sel}" — ${e.message}`);
          }
          // Suggest similar elements if selector looks like it targets a tag/class/id
          var hint = "";
          var parts = sel.split(/\s+/);
          var lastPart = parts[parts.length - 1];
          if (lastPart) {
            var tagMatch = lastPart.match(/^(\w+)/);
            if (tagMatch) {
              var similar = document.querySelectorAll(tagMatch[1]);
              if (similar.length > 0) {
                hint = ` Found ${similar.length} <${tagMatch[1]}> elements on the page — try a broader selector or use query_selector to inspect them.`;
              }
            }
          }
          throw new Error(`Element not found: "${sel}" matched 0 elements.${hint}`);
        }
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          tag: el.tagName.toLowerCase(),
          text: el.innerText?.substring(0, 100) || "",
        };
      }, [params.selector]);

      // Use chrome.debugger for trusted click (isTrusted: true)
      const clickTarget = { tabId };
      try {
        await chrome.debugger.attach(clickTarget, "1.3");
        await chrome.debugger.sendCommand(clickTarget, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: clickInfo.x, y: clickInfo.y, button: "left", clickCount: 1,
        });
        await chrome.debugger.sendCommand(clickTarget, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x: clickInfo.x, y: clickInfo.y, button: "left", clickCount: 1,
        });
        await chrome.debugger.detach(clickTarget);
      } catch (e) {
        try { await chrome.debugger.detach(clickTarget); } catch {}
        // Fallback to regular click
        await executeInTab(tabId, (sel) => {
          document.querySelector(sel)?.click();
        }, [params.selector]);
      }
      return { clicked: true, tag: clickInfo.tag, text: clickInfo.text };
    }

    case "fillInput":
      return executeInTab(tabId, (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: true, selector: sel, value };
      }, [params.selector, params.value]);

    case "selectOption":
      return executeInTab(tabId, (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { selected: true, value };
      }, [params.selector, params.value]);

    case "scrollPage":
      return executeInTab(tabId, (direction, sel, amount) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            return { scrolledTo: sel };
          }
          throw new Error(`Element not found: ${sel}`);
        }
        const px = amount || 500;
        switch (direction) {
          case "up": window.scrollBy(0, -px); break;
          case "down": window.scrollBy(0, px); break;
          case "top": window.scrollTo(0, 0); break;
          case "bottom": window.scrollTo(0, document.body.scrollHeight); break;
        }
        return { scrolled: direction, pixels: px, scrollY: window.scrollY };
      }, [params.direction || null, params.selector || null, params.amount || null]);

    case "navigate": {
      const waitForLoad = (targetTabId, timeoutMs = 15000) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve({ loaded: false, reason: "timeout" }); // Don't reject, just note timeout
          }, timeoutMs);
          const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === targetTabId && changeInfo.status === "complete") {
              clearTimeout(timeout);
              chrome.tabs.onUpdated.removeListener(listener);
              resolve({ loaded: true });
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      };

      if (params.newTab) {
        const newTab = await chrome.tabs.create({ url: params.url, active: false });
        await waitForLoad(newTab.id);
        return { navigated: true, url: params.url, tabId: newTab.id, newTab: true };
      }
      await chrome.tabs.update(tabId, { url: params.url });
      await waitForLoad(tabId);
      return { navigated: true, url: params.url, tabId };
    }

    case "executeJs": {
      // chrome.debugger Runtime.evaluate runs in the page's MAIN world, which is
      // what makes window.* state persist across calls. There is deliberately no
      // chrome.scripting fallback: that runs in an ISOLATED world, so falling
      // back would silently relocate the caller's code to a realm where its own
      // injected state does not exist, and report success.
      const jsTarget = { tabId };
      // The caller's code is wrapped so a page-thrown error comes back as data
      // rather than collapsing into an indistinguishable null.
      const wrappedCode = `(async () => {
        if (!window.__cwbDocToken) {
          window.__cwbDocToken = Math.random().toString(36).slice(2) + "-" + performance.timeOrigin;
        }
        var __token = window.__cwbDocToken;
        function __safe(v) {
          if (v === undefined) return null;
          try {
            // Functions and symbols stringify to undefined WITHOUT throwing, so
            // checking the result is required — a bare try/catch would let them
            // disappear from the envelope entirely.
            if (JSON.stringify(v) === undefined) {
              return { __unserializable: Object.prototype.toString.call(v) };
            }
            return v;
          } catch (e) {
            return { __unserializable: Object.prototype.toString.call(v), reason: String(e && e.message || e) };
          }
        }
        try {
          var __value = await (async () => { ${params.code} })();
          return { token: __token, ok: true, value: __safe(__value) };
        } catch (e) {
          return {
            token: __token,
            ok: false,
            error: {
              reason: "exception",
              message: String((e && e.message) || e),
              stack: (e && e.stack) ? String(e.stack) : null,
            },
          };
        }
      })()`;

      let evalResult;
      try {
        await chrome.debugger.attach(jsTarget, "1.3");
        evalResult = await chrome.debugger.sendCommand(jsTarget, "Runtime.evaluate", {
          expression: wrappedCode,
          awaitPromise: true,
          returnByValue: true,
          timeout: 25000,
        });
      } catch (e) {
        throw new Error(
          `execute_js could not evaluate in tab ${tabId}: ${e.message}. ` +
          `The debugger may be unavailable (DevTools open, another debugger attached, ` +
          `or a restricted page such as chrome:// or the Chrome Web Store).`
        );
      } finally {
        try { await chrome.debugger.detach(jsTarget); } catch {}
      }

      // The wrapper catches page exceptions itself, so exceptionDetails here means
      // the wrapper never ran — a syntax error in the caller's code, or a timeout.
      if (evalResult?.exceptionDetails) {
        const d = evalResult.exceptionDetails;
        return {
          ok: false,
          error: {
            reason: d.exception?.className === "SyntaxError" ? "syntax" : "evaluation",
            message: d.exception?.description || d.text || "JS evaluation failed",
            stack: null,
          },
          tabId,
        };
      }

      const payload = evalResult?.result?.value;
      if (!payload || typeof payload !== "object" || !("token" in payload)) {
        // returnByValue could not serialize the envelope, or the document was
        // torn down mid-call. Either way it is not a successful null.
        return {
          ok: false,
          error: {
            reason: "no_result",
            message: "execute_js returned no usable envelope; the page may have navigated mid-call.",
            stack: null,
          },
          tabId,
        };
      }

      const { navigationId, documentChanged } = trackDocument(tabId, payload.token);
      const out = { ok: payload.ok, navigationId, documentChanged, tabId };
      if (payload.ok) out.value = payload.value;
      else out.error = payload.error;
      return out;
    }

    case "setContentEditable":
      return executeInTab(tabId, (sel, text) => {
        var el = document.querySelector(sel);
        if (!el) throw new Error("Element not found: " + sel);
        el.focus();
        // Select all content
        var range = document.createRange();
        range.selectNodeContents(el);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        // Delete selected and insert new text
        document.execCommand("delete", false, null);
        document.execCommand("insertText", false, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { set: true, length: text.length, preview: el.innerText.substring(0, 80) };
      }, [params.selector, params.text]);

    case "takeScreenshot": {
      // Use chrome.debugger API — captures any tab without switching to it
      const debugTarget = { tabId };
      try {
        await chrome.debugger.attach(debugTarget, "1.3");
        const result = await chrome.debugger.sendCommand(debugTarget, "Page.captureScreenshot", {
          format: "png",
          quality: 90,
        });
        await chrome.debugger.detach(debugTarget);
        return { dataUrl: "data:image/png;base64," + result.data, tabId };
      } catch (e) {
        // Detach on error to avoid lingering debugger sessions
        try { await chrome.debugger.detach(debugTarget); } catch {}
        throw new Error("Screenshot failed: " + e.message);
      }
    }

    case "getTabs":
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      }));

    case "switchTab":
      await chrome.tabs.update(params.tabId, { active: true });
      const targetTab = await chrome.tabs.get(params.tabId);
      await chrome.windows.update(targetTab.windowId, { focused: true });
      return { switched: true, tabId: params.tabId };

    case "waitForElement":
      return executeInTab(tabId, (sel, timeout) => {
        return new Promise((resolve, reject) => {
          const existing = document.querySelector(sel);
          if (existing) {
            resolve({ found: true, tag: existing.tagName.toLowerCase() });
            return;
          }
          const observer = new MutationObserver(() => {
            const el = document.querySelector(sel);
            if (el) {
              observer.disconnect();
              resolve({ found: true, tag: el.tagName.toLowerCase() });
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout: Element ${sel} not found within ${timeout}ms`));
          }, timeout);
        });
      }, [params.selector, params.timeout || 10000]);

    case "typeText":
      return executeInTab(tabId, (text, sel) => {
        let target = document.activeElement;
        if (sel) {
          target = document.querySelector(sel);
          if (!target) throw new Error(`Element not found: ${sel}`);
          target.focus();
        }
        for (const char of text) {
          target.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
          if (target.value !== undefined) {
            target.value += char;
          }
          target.dispatchEvent(new InputEvent("input", { data: char, inputType: "insertText", bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        }
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { typed: true, length: text.length };
      }, [params.text, params.selector || null]);

    case "pressKey": {
      // Use chrome.debugger for trusted key events (isTrusted: true)
      // This is required for sites like YouTube that ignore synthetic events
      const keyTarget = { tabId };
      const mods = params.modifiers || [];
      const modBits = (mods.includes("alt") ? 1 : 0) | (mods.includes("ctrl") ? 2 : 0)
        | (mods.includes("meta") ? 4 : 0) | (mods.includes("shift") ? 8 : 0);

      // Map common key names to their DOM key codes
      const keyCodeMap = {
        ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
        Enter: 13, Escape: 27, Tab: 9, Space: 32, Backspace: 8, Delete: 46,
      };
      const keyCode = keyCodeMap[params.key] || params.key.charCodeAt(0);

      try {
        await chrome.debugger.attach(keyTarget, "1.3");
        await chrome.debugger.sendCommand(keyTarget, "Input.dispatchKeyEvent", {
          type: "keyDown", key: params.key, windowsVirtualKeyCode: keyCode, modifiers: modBits,
        });
        await chrome.debugger.sendCommand(keyTarget, "Input.dispatchKeyEvent", {
          type: "keyUp", key: params.key, windowsVirtualKeyCode: keyCode, modifiers: modBits,
        });
        await chrome.debugger.detach(keyTarget);
      } catch (e) {
        try { await chrome.debugger.detach(keyTarget); } catch {}
        // Fallback to synthetic events
        return executeInTab(tabId, (key, modifiers) => {
          const opts = { key, bubbles: true, ctrlKey: (modifiers||[]).includes("ctrl"),
            shiftKey: (modifiers||[]).includes("shift"), altKey: (modifiers||[]).includes("alt"),
            metaKey: (modifiers||[]).includes("meta") };
          const target = document.activeElement || document.body;
          target.dispatchEvent(new KeyboardEvent("keydown", opts));
          target.dispatchEvent(new KeyboardEvent("keyup", opts));
          return { pressed: key, modifiers: modifiers || [], trusted: false };
        }, [params.key, mods]);
      }
      return { pressed: params.key, modifiers: mods, trusted: true };
    }

    case "clickAtCoordinates": {
      const coordTarget = { tabId };
      try {
        await chrome.debugger.attach(coordTarget, "1.3");
        await chrome.debugger.sendCommand(coordTarget, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: params.x, y: params.y, button: "left", clickCount: 1,
        });
        await chrome.debugger.sendCommand(coordTarget, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x: params.x, y: params.y, button: "left", clickCount: 1,
        });
        await chrome.debugger.detach(coordTarget);
      } catch (e) {
        try { await chrome.debugger.detach(coordTarget); } catch {}
        throw new Error("Click at coordinates failed: " + e.message);
      }
      // Get info about what was at those coordinates
      const elementInfo = await executeInTab(tabId, (x, y) => {
        var el = document.elementFromPoint(x, y);
        if (!el) return { clicked: true, x: x, y: y, element: null };
        return {
          clicked: true, x: x, y: y,
          tag: el.tagName.toLowerCase(),
          text: el.innerText?.substring(0, 100) || "",
          id: el.id || "",
          className: el.className?.substring?.(0, 100) || "",
        };
      }, [params.x, params.y]);
      return elementInfo;
    }

    case "waitForPageLoad": {
      const loadTimeout = params.timeout || 15000;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({ loaded: false, reason: "timeout", timeout: loadTimeout });
        }, loadTimeout);
        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve({ loaded: true });
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        // Check if already loaded
        chrome.tabs.get(tabId).then((tab) => {
          if (tab.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve({ loaded: true, already: true });
          }
        });
      });
    }

    case "playMedia":
      return executeInTab(tabId, (sel) => {
        var video = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
        if (!video) throw new Error("No media element found on page");
        // Muted autoplay trick: mute first, play, then unmute
        var wasMuted = video.muted;
        video.muted = true;
        var playPromise = video.play();
        if (playPromise && playPromise.then) {
          return playPromise.then(function() {
            video.muted = wasMuted;
            return { playing: true, muted: video.muted, currentTime: video.currentTime, duration: video.duration, src: video.currentSrc?.substring(0, 100) };
          }).catch(function(e) {
            return { playing: false, error: e.message };
          });
        }
        video.muted = wasMuted;
        return { playing: !video.paused, muted: video.muted, currentTime: video.currentTime, duration: video.duration };
      }, [params.selector || null]);

    case "pauseMedia":
      return executeInTab(tabId, (sel) => {
        var video = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
        if (!video) throw new Error("No media element found on page");
        video.pause();
        return { paused: true, currentTime: video.currentTime, duration: video.duration };
      }, [params.selector || null]);

    case "getMediaState":
      return executeInTab(tabId, (sel) => {
        var video = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
        if (!video) throw new Error("No media element found on page");
        return {
          paused: video.paused,
          muted: video.muted,
          volume: video.volume,
          currentTime: video.currentTime,
          duration: video.duration,
          readyState: video.readyState,
          networkState: video.networkState,
          src: video.currentSrc?.substring(0, 100) || "",
          error: video.error ? video.error.message : null,
        };
      }, [params.selector || null]);

    case "setVolume":
      return executeInTab(tabId, (vol, sel) => {
        var video = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
        if (!video) throw new Error("No media element found on page");
        video.volume = Math.max(0, Math.min(1, vol));
        video.muted = false;
        return { volume: video.volume, muted: video.muted };
      }, [params.volume, params.selector || null]);

    case "seekMedia":
      return executeInTab(tabId, (time, sel) => {
        var video = sel ? document.querySelector(sel) : (document.querySelector("video") || document.querySelector("audio"));
        if (!video) throw new Error("No media element found on page");
        video.currentTime = time;
        return { currentTime: video.currentTime, duration: video.duration };
      }, [params.time, params.selector || null]);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ── Message handler from popup ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getStatus") {
    sendResponse({ connected: isConnected, wsUrl: WS_URL });
  } else if (msg.type === "connect") {
    connect({ silent: false, auto: false });
    sendResponse({ ok: true });
  } else if (msg.type === "disconnect") {
    disconnect();
    sendResponse({ ok: true });
  }
  return true;
});

// ── Keepalive: prevent MV3 service worker suspension ────────────────────
// Chrome suspends service workers after ~30s of inactivity, killing WebSocket.
// Use chrome.alarms (survives suspension) to wake up and reconnect.
chrome.alarms.create("keepalive", { periodInMinutes: 0.3 }); // every 18 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (socket && socket.readyState === 1) {
      // Send a ping to keep the WebSocket alive
      socket.send(JSON.stringify({ type: "ping" }));
    } else if (!isConnected) {
      // Reconnect if disconnected
      connect({ silent: true, auto: true });
    }
  }
});

// Try to connect silently on startup — no errors if server isn't up yet
connect({ silent: true, auto: true });
