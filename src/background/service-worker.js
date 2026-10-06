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

  if (recording?.status === "paused") {
    await chrome.action.setBadgeText({ text: "II" });
    await chrome.action.setBadgeBackgroundColor({ color: "#f9ab00" });
    await chrome.action.setTitle({ title: `TabVault — paused ${recording.title || "tab"}` });
    return;
  }

  if (recording?.status === "error") {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#5f6368" });
    await chrome.action.setTitle({ title: "TabVault — recording error" });
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
    justification: "Keep selected tab capture and persisted recording recovery available after the popup closes."
  });
}

async function listRecoverableSessions() {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_LIST_RECOVERABLE"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to inspect recoverable recordings.");
  }

  return response.sessions || [];
}

async function recoverSession(sessionId) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_RECOVER",
    sessionId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to recover recording.");
  }

  return response.recording;
}

async function discardRecoverableSession(sessionId) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_DISCARD_RECOVERY",
    sessionId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to discard recoverable recording.");
  }
}

async function installTeamsInspector(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/teams-companion.js"]
  });
}

async function getTeamsState(tabId) {
  try {
    await installTeamsInspector(tabId);
    return await chrome.tabs.sendMessage(tabId, {
      type: "TABVAULT_GET_TEAMS_STATE"
    });
  } catch {
    return {
      ok: true,
      state: {
        microphone: { detected: false, off: null },
        camera: { detected: false, off: null }
      }
    };
  }
}

async function installSharePointLifecycle(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/sharepoint-playback.js"]
  });
}

async function getSharePointMediaState(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "TABVAULT_GET_MEDIA_STATE"
    });
  } catch {
    return { ok: true, media: null };
  }
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

  if (message.sourceType === SOURCE_TYPES.SHAREPOINT) {
    try {
      await installSharePointLifecycle(message.tabId);
    } catch {
      // Recording still works if playback lifecycle inspection is unavailable.
    }
  }

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
    },
    lifecycle: {
      autoStopOnEnded: Boolean(message.autoStopOnEnded),
      followPlayback: Boolean(message.followPlayback)
    }
  };

  await writeState({ recording });

  if (recording.sourceType === SOURCE_TYPES.SHAREPOINT && recording.lifecycle.followPlayback) {
    const state = await getSharePointMediaState(recording.tabId);
    if (state?.media?.paused && !state.media.ended) {
      return await setRecordingPaused(true);
    }
  }

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

async function setRecordingPaused(paused) {
  const current = await readState();

  if (!current.recording) {
    throw new Error("No active TabVault recording.");
  }

  const type = paused ? "TABVAULT_OFFSCREEN_PAUSE" : "TABVAULT_OFFSCREEN_RESUME";
  const response = await chrome.runtime.sendMessage({ type });

  if (!response?.ok) {
    throw new Error(paused ? "Unable to pause recording." : "Unable to resume recording.");
  }

  const now = Date.now();
  let totalPausedMs = Number(current.recording.totalPausedMs || 0);
  let pausedAt = current.recording.pausedAt || null;

  if (paused) {
    pausedAt = now;
  } else if (pausedAt) {
    totalPausedMs += Math.max(0, now - pausedAt);
    pausedAt = null;
  }

  const recording = {
    ...current.recording,
    status: paused ? "paused" : "capturing",
    pausedAt,
    totalPausedMs
  };

  await writeState({ recording });
  return recording;
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
  const current = await readState();

  if (current.recording?.tabId !== info.tabId) {
    return;
  }

  if (info.status === "error") {
    await writeState({
      recording: {
        ...current.recording,
        status: "error",
        error: "Chrome reported a tab capture error."
      }
    });
    return;
  }

  if (info.status === "stopped") {
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

  if (message?.type === "TABVAULT_GET_TEAMS_STATE") {
    getTeamsState(message.tabId)
      .then((state) => sendResponse(state))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_LIST_RECOVERABLE") {
    listRecoverableSessions()
      .then((sessions) => sendResponse({ ok: true, sessions }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_RECOVER_SESSION") {
    recoverSession(message.sessionId)
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_DISCARD_RECOVERY") {
    discardRecoverableSession(message.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
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

  if (message?.type === "TABVAULT_SET_PAUSED") {
    setRecordingPaused(Boolean(message.paused))
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

  if (message?.type === "TABVAULT_SHAREPOINT_MEDIA_EVENT") {
    (async () => {
      const current = await readState();
      const recording = current.recording;

      if (!recording || recording.sourceType !== SOURCE_TYPES.SHAREPOINT) {
        return;
      }

      if (message.event === "ended" && recording.lifecycle?.autoStopOnEnded) {
        await stopCapture();
        return;
      }

      if (!recording.lifecycle?.followPlayback) {
        return;
      }

      if ((message.event === "play" || message.event === "playing") && recording.status === "paused") {
        await setRecordingPaused(false);
      } else if (message.event === "pause" && recording.status === "capturing") {
        await setRecordingPaused(true);
      }
    })().catch(async (error) => {
      const current = await readState();
      if (current.recording) {
        await writeState({
          recording: {
            ...current.recording,
            status: "error",
            error: error.message
          }
        });
      }
    });
    return false;
  }

  if (message?.type === "TABVAULT_CAPTURE_ENDED") {
    writeState({ recording: null })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
