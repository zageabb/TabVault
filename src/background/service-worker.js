const SOURCE_TYPES = {
  SHAREPOINT: "sharepoint",
  TEAMS: "teams",
  GENERIC: "generic"
};

const OFFSCREEN_DOCUMENT_PATH = "src/recorder/recorder.html";

async function readState() {
  const stored = await chrome.storage.local.get("tabVault");
  return stored.tabVault || {
    version: chrome.runtime.getManifest().version,
    recording: null
  };
}

async function writeState(patch) {
  const current = await readState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ tabVault: next });
  return next;
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Keep the selected browser tab capture alive after the popup closes."
  });
}

async function startCapture(message) {
  const current = await readState();

  if (current.recording?.status === "capturing") {
    throw new Error("TabVault is already capturing a tab.");
  }

  if (!Number.isInteger(message.tabId)) {
    throw new Error("No valid browser tab was selected for capture.");
  }

  await ensureOffscreenDocument();

  // targetTabId binds the capture to the tab selected when the user pressed
  // Start. Switching to another tab later does not change the capture source.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: message.tabId
  });

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_START",
    streamId,
    tabId: message.tabId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The offscreen recorder did not start.");
  }

  const recording = {
    status: "capturing",
    tabId: message.tabId,
    title: message.title || "Untitled tab",
    url: message.url || "",
    sourceType: message.sourceType || SOURCE_TYPES.GENERIC,
    startedAt: Date.now(),
    video: response.video || null,
    audio: response.audio || {
      available: false,
      sampleRate: null,
      channelCount: null,
      localPlayback: false
    }
  };

  await writeState({ recording });
  return recording;
}

async function stopCapture() {
  const current = await readState();

  if (!current.recording) {
    return null;
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_STOP"
  });

  if (response && response.ok === false) {
    throw new Error(response.error || "Unable to stop tab capture.");
  }

  await writeState({ recording: null });
  return null;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    tabVault: {
      version: chrome.runtime.getManifest().version,
      recording: null
    }
  });
});

chrome.runtime.onStartup.addListener(async () => {
  // An offscreen media stream cannot survive a full browser restart.
  await writeState({ recording: null });
});

chrome.tabCapture.onStatusChanged.addListener(async (info) => {
  if (info.status !== "stopped" && info.status !== "error") {
    return;
  }

  const current = await readState();
  if (current.recording?.tabId === info.tabId) {
    await writeState({ recording: null });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  if (message?.type === "TABVAULT_PING") {
    sendResponse({ ok: true, sourceTypes: SOURCE_TYPES });
    return false;
  }

  if (message?.type === "TABVAULT_GET_STATE") {
    readState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_START_CAPTURE") {
    startCapture(message)
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_STOP_CAPTURE") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_CAPTURE_ENDED") {
    writeState({ recording: null })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
