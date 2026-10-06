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

async function updateBadge(recording) {
  if (recording?.status === "capturing") {
    await chrome.action.setBadgeText({ text: "REC" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setTitle({ title: `TabVault — recording ${recording.title || "tab"}` });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "TabVault" });
}

async function writeState(patch) {
  const current = await readState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ tabVault: next });
  await updateBadge(next.recording);
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

  const startedAt = Date.now();
  const localPlaybackEnabled =
    typeof message.localPlaybackEnabled === "boolean"
      ? message.localPlaybackEnabled
      : message.sourceType !== SOURCE_TYPES.TEAMS;

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_START",
    streamId,
    tabId: message.tabId,
    localPlaybackEnabled,
    meta: {
      title: message.title || "Untitled tab",
      startedAt
    }
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
    startedAt,
    localPlaybackEnabled,
    recorder: response.recorder || null,
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
  return response?.recording || null;
}

async function setLocalPlayback(enabled) {
  const current = await readState();

  if (!current.recording) {
    throw new Error("No active TabVault capture.");
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_SET_LOCAL_PLAYBACK",
    enabled: Boolean(enabled)
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to change local playback.");
  }

  const recording = {
    ...current.recording,
    localPlaybackEnabled: Boolean(enabled),
    audio: {
      ...(current.recording.audio || {}),
      localPlayback: Boolean(response.audio?.localPlayback)
    }
  };

  await writeState({ recording });
  return recording;
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    tabVault: {
      version: chrome.runtime.getManifest().version,
      recording: null
    }
  });
  await updateBadge(null);
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
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_SET_LOCAL_PLAYBACK") {
    setLocalPlayback(message.enabled)
      .then((recording) => sendResponse({ ok: true, recording }))
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
