// ── Claude Web Bridge - Content Script ──────────────────────────────────────
// This content script runs on every page and provides a visual indicator
// when the bridge is active. The actual page interaction is done via
// chrome.scripting.executeScript from the background script, so this
// content script is kept minimal.

(() => {
  // Inject a subtle indicator when actions are being performed
  let indicator = null;

  function showIndicator(action) {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "claude-web-bridge-indicator";
      Object.assign(indicator.style, {
        position: "fixed",
        bottom: "12px",
        right: "12px",
        padding: "6px 14px",
        background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
        color: "#fff",
        fontSize: "12px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        borderRadius: "20px",
        zIndex: "2147483647",
        boxShadow: "0 2px 12px rgba(99, 102, 241, 0.4)",
        transition: "opacity 0.3s, transform 0.3s",
        opacity: "0",
        transform: "translateY(8px)",
        pointerEvents: "none",
      });
      document.body.appendChild(indicator);
    }
    indicator.textContent = `Claude: ${action}`;
    indicator.style.opacity = "1";
    indicator.style.transform = "translateY(0)";

    clearTimeout(indicator._hideTimer);
    indicator._hideTimer = setTimeout(() => {
      if (indicator) {
        indicator.style.opacity = "0";
        indicator.style.transform = "translateY(8px)";
      }
    }, 2000);
  }

  // Listen for messages from background script to show indicators
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "bridgeAction") {
      showIndicator(msg.action);
      sendResponse({ ok: true });
    }
  });
})();
