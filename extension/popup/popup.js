const connectBtn = document.getElementById("connectBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

function updateUI(connected) {
  statusDot.className = `status-dot ${connected ? "connected" : "disconnected"}`;
  statusText.textContent = connected ? "Connected" : "Disconnected";
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
  connectBtn.className = `btn ${connected ? "btn-disconnect" : "btn-connect"}`;
}

// Get initial status
chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
  if (res) updateUI(res.connected);
});

connectBtn.addEventListener("click", () => {
  const isConnected = statusDot.classList.contains("connected");
  const action = isConnected ? "disconnect" : "connect";

  chrome.runtime.sendMessage({ type: action }, () => {
    // Poll for status update after a short delay
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
        if (res) updateUI(res.connected);
      });
    }, 500);
  });
});

// Refresh status periodically while popup is open
setInterval(() => {
  chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
    if (res) updateUI(res.connected);
  });
}, 2000);
