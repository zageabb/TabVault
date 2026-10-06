const SOURCE_TYPES = {
  SHAREPOINT: "sharepoint",
  TEAMS: "teams",
  GENERIC: "generic"
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    tabVault: {
      version: "0.1.0",
      recording: null
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TABVAULT_PING") {
    sendResponse({ ok: true, sourceTypes: SOURCE_TYPES });
  }
});
