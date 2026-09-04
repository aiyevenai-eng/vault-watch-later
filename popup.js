const JOURNAL = "http://localhost:3000";
const statusEl = document.getElementById("status");

async function ping() {
  try {
    const response = await fetch(JOURNAL, { method: "GET" });
    if (response.ok || response.status === 307 || response.status === 302) {
      statusEl.textContent = "已检测到 Trading Journal（localhost:3000）。可以保存视频了。";
      return;
    }
  } catch {
    /* offline */
  }
  statusEl.textContent = "还没连上网站。请先在本机启动 Trading Journal（localhost:3000）。";
}

document.getElementById("open-learning").addEventListener("click", () => {
  chrome.tabs.create({ url: `${JOURNAL}/learning` });
});
document.getElementById("open-watch-later").addEventListener("click", () => {
  chrome.tabs.create({ url: `${JOURNAL}/learning/watch-later` });
});

ping();
