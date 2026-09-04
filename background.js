const DEFAULTS = {
  vault: "http://127.0.0.1:4321",
  journal: "http://localhost:3000",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    VAULT_API_BASE: DEFAULTS.vault,
    TRADING_JOURNAL_BASE: DEFAULTS.journal,
  });
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "VAULT_FETCH") return false;

  const options = message.options || {};
  withTimeout(
    fetch(message.url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
      credentials: "include",
    }),
    12000,
  )
    .then(async (response) => {
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      sendResponse({
        ok: response.ok,
        status: response.status,
        text,
        json,
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        error: String(error),
        text: "",
        json: null,
      });
    });
  return true;
});
