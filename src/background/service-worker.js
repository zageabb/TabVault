const SOURCE_TYPES = {
  SHAREPOINT: "sharepoint",
  TEAMS: "teams",
  GENERIC: "generic"
};

const OFFSCREEN_DOCUMENT_PATH = "src/recorder/recorder.html";
const HISTORY_LIMIT = 50;
const MAX_CONCURRENT_RECORDINGS = 3;

const DEFAULT_SETTINGS = {
  destinationFolder: "TabVault",
  filenameTemplate: "{title} - {date}",
  autoLowCpu: false,
  teamsPriority: false
};

function normalizeRecordings(state) {
  if (Array.isArray(state?.recordings)) {
    return state.recordings;
  }

  if (state?.recording) {
    return [state.recording];
  }

  return [];
}

async function readState() {
  const stored = await chrome.storage.local.get("tabVault");
  const raw = stored.tabVault || {};
  const recordings = normalizeRecordings(raw);

  return {
    ...raw,
    version: raw.version || chrome.runtime.getManifest().version,
    recordings,
    recording: recordings[0] || null,
    history: Array.isArray(raw.history) ? raw.history : [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...(raw.settings || {})
    }
  };
}

async function updateBadge(recordings = []) {
  const active = Array.isArray(recordings) ? recordings : [];
  const count = active.length;

  if (count === 0) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "TabVault" });
    return;
  }

  if (active.some((recording) => recording.status === "error")) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#5f6368" });
    await chrome.action.setTitle({ title: `TabVault — ${count} active, error present` });
    return;
  }

  if (count > 1) {
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setTitle({ title: `TabVault — ${count} active recordings` });
    return;
  }

  const [recording] = active;
  if (recording.status === "paused") {
    await chrome.action.setBadgeText({ text: "II" });
    await chrome.action.setBadgeBackgroundColor({ color: "#f9ab00" });
    await chrome.action.setTitle({ title: `TabVault — paused ${recording.title || "tab"}` });
    return;
  }

  await chrome.action.setBadgeText({ text: "REC" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  await chrome.action.setTitle({ title: `TabVault — recording ${recording.title || "tab"}` });
}

async function writeState(patch) {
  const current = await readState();
  const merged = { ...current, ...patch };
  const recordings = normalizeRecordings(merged);
  const next = {
    ...merged,
    recordings,
    recording: recordings[0] || null
  };

  await chrome.storage.local.set({ tabVault: next });
  await updateBadge(recordings);
  return next;
}

function recordingDurationMs(recording, endedAt = Date.now()) {
  if (!recording?.startedAt) return null;

  let pausedMs = Number(recording.totalPausedMs || 0);
  if (recording.status === "paused" && recording.pausedAt) {
    pausedMs += Math.max(0, endedAt - Number(recording.pausedAt));
  }

  return Math.max(0, endedAt - Number(recording.startedAt) - pausedMs);
}

async function appendHistory(entry) {
  const current = await readState();
  const nextEntry = {
    id: entry.id || crypto.randomUUID(),
    title: entry.title || "Untitled recording",
    sourceType: entry.sourceType || SOURCE_TYPES.GENERIC,
    captureMode: entry.captureMode || "tab",
    startedAt: entry.startedAt || null,
    endedAt: entry.endedAt || Date.now(),
    durationMs: entry.durationMs ?? null,
    result: entry.result || "saved",
    filename: entry.filename || null,
    size: Number(entry.size || 0),
    recovered: Boolean(entry.recovered)
  };

  const history = [nextEntry, ...current.history].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({
    tabVault: {
      ...current,
      history
    }
  });

  return nextEntry;
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
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Keep selected tab captures and persisted recording recovery available after the popup closes."
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

  const current = await readState();
  const activeIds = new Set(current.recordings.map((recording) => recording.sessionId));
  return (response.sessions || []).filter((session) => !activeIds.has(session.sessionId));
}

async function recoverSession(sessionId) {
  await ensureOffscreenDocument();

  const sessions = await listRecoverableSessions();
  const session = sessions.find((item) => item.sessionId === sessionId) || null;

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_RECOVER",
    sessionId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to recover recording.");
  }

  const recording = response.recording;
  if (recording?.saved) {
    const endedAt = Date.now();
    await appendHistory({
      title: session?.title || "Recovered recording",
      sourceType: session?.sourceType || SOURCE_TYPES.GENERIC,
      startedAt: session?.startedAt || null,
      endedAt,
      durationMs: session?.startedAt
        ? Math.max(0, endedAt - Number(session.startedAt))
        : null,
      result: "recovered",
      filename: recording.filename,
      size: recording.size,
      recovered: true
    });
  }

  return recording;
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

function findRecording(state, sessionId) {
  return state.recordings.find((recording) => recording.sessionId === sessionId) || null;
}

async function replaceRecording(sessionId, updater) {
  const current = await readState();
  const recordings = current.recordings.map((recording) =>
    recording.sessionId === sessionId ? updater(recording) : recording
  );
  const updated = recordings.find((recording) => recording.sessionId === sessionId) || null;
  await writeState({ recordings });
  return updated;
}

async function removeRecording(sessionId) {
  const current = await readState();
  const recordings = current.recordings.filter(
    (recording) => recording.sessionId !== sessionId
  );
  await writeState({ recordings });
}


async function registerDisplaySession(message) {
  const current = await readState();

  if (current.recordings.length >= MAX_CONCURRENT_RECORDINGS) {
    throw new Error(
      `TabVault supports up to ${MAX_CONCURRENT_RECORDINGS} simultaneous recordings.`
    );
  }

  if (current.recordings.some((recording) => recording.tabId === message.tabId)) {
    throw new Error("This browser tab is already being recorded.");
  }

  const recording = {
    sessionId: message.sessionId,
    status: "capturing",
    tabId: message.tabId,
    title: message.title || "Window / Screen recording",
    url: message.url || "",
    sourceType: message.sourceType || SOURCE_TYPES.GENERIC,
    captureMode: "display",
    startedAt: message.startedAt || Date.now(),
    totalPausedMs: 0,
    pausedAt: null,
    localPlaybackEnabled: false,
    qualityProfile: message.qualityProfile || "standard",
    recorder: message.recorder || null,
    video: message.video || null,
    audio: message.audio || {
      available: false,
      sampleRate: null,
      channelCount: null,
      localPlayback: false
    },
    lifecycle: {
      autoStopOnEnded: false,
      followPlayback: false
    }
  };

  await writeState({ recordings: [...current.recordings, recording] });
  return recording;
}

async function updateDisplaySession(message) {
  const current = await readState();
  const active = findRecording(current, message.sessionId);

  if (!active) {
    throw new Error("Active display recording was not found.");
  }

  const nextStatus = message.status || active.status;
  const now = Date.now();
  let totalPausedMs = Number(active.totalPausedMs || 0);
  let pausedAt = active.pausedAt || null;

  if (nextStatus === "paused" && active.status !== "paused") {
    pausedAt = now;
  } else if (nextStatus === "capturing" && active.status === "paused" && pausedAt) {
    totalPausedMs += Math.max(0, now - pausedAt);
    pausedAt = null;
  }

  return await replaceRecording(message.sessionId, (recording) => ({
    ...recording,
    status: nextStatus,
    pausedAt,
    totalPausedMs,
    audio: message.audio ? { ...(recording.audio || {}), ...message.audio } : recording.audio,
    video: message.video ? { ...(recording.video || {}), ...message.video } : recording.video
  }));
}

async function completeDisplaySession(message) {
  const current = await readState();
  const active = findRecording(current, message.sessionId);
  const endedAt = Date.now();

  if (active && message.recording?.saved) {
    await appendHistory({
      title: active.title,
      sourceType: active.sourceType,
      captureMode: "display",
      startedAt: active.startedAt,
      endedAt,
      durationMs: recordingDurationMs(active, endedAt),
      result: "saved",
      filename: message.recording.filename,
      size: message.recording.size
    });
  }

  if (active) {
    await removeRecording(active.sessionId);
  }

  return message.recording || null;
}

async function sendDisplayCommand(sessionId, command) {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_DISPLAY_COMMAND",
    target: "display-controller",
    sessionId,
    command
  });

  if (!response?.ok) {
    throw new Error(response?.error || `Unable to ${command} display recording.`);
  }

  return response;
}

async function startCapture(message) {
  const current = await readState();

  if (!Number.isInteger(message.tabId)) {
    throw new Error("No valid browser tab was selected for capture.");
  }

  if (current.recordings.length >= MAX_CONCURRENT_RECORDINGS) {
    throw new Error(
      `TabVault supports up to ${MAX_CONCURRENT_RECORDINGS} simultaneous recordings.`
    );
  }

  if (current.recordings.some((recording) => recording.tabId === message.tabId)) {
    throw new Error("This browser tab is already being recorded.");
  }

  await ensureOffscreenDocument();

  const sessionId = crypto.randomUUID();
  const captureMode =
    message.captureMode === "display" && message.sourceType === SOURCE_TYPES.GENERIC
      ? "display"
      : "tab";

  let streamId;
  let canRequestAudioTrack = true;

  if (captureMode === "display") {
    if (!message.desktopStreamId) {
      throw new Error("No window / screen source was selected.");
    }

    streamId = message.desktopStreamId;
    canRequestAudioTrack = Boolean(message.canRequestAudioTrack);
  } else {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: message.tabId
    });
  }

  const startedAt = Date.now();
  const localPlaybackEnabled =
    typeof message.localPlaybackEnabled === "boolean"
      ? message.localPlaybackEnabled
      : message.sourceType !== SOURCE_TYPES.TEAMS;

  if (message.sourceType === SOURCE_TYPES.SHAREPOINT) {
    try {
      await installSharePointLifecycle(message.tabId);
    } catch {
      // Recording still works if lifecycle inspection is unavailable.
    }
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_START",
    sessionId,
    streamId,
    tabId: message.tabId,
    localPlaybackEnabled,
    captureMode,
    canRequestAudioTrack,
    meta: {
      title: message.title || "Untitled tab",
      sourceType: message.sourceType || SOURCE_TYPES.GENERIC,
      captureMode,
      qualityProfile: message.qualityProfile || "standard",
      filenameTemplate:
        message.filenameTemplate ||
        current.settings.filenameTemplate ||
        DEFAULT_SETTINGS.filenameTemplate,
      destinationFolder:
        message.destinationFolder ||
        current.settings.destinationFolder ||
        DEFAULT_SETTINGS.destinationFolder,
      startedAt
    }
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The offscreen recorder did not start.");
  }

  const recording = {
    sessionId,
    status: "capturing",
    tabId: message.tabId,
    title: message.title || "Untitled tab",
    url: message.url || "",
    sourceType: message.sourceType || SOURCE_TYPES.GENERIC,
    captureMode,
    startedAt,
    totalPausedMs: 0,
    pausedAt: null,
    localPlaybackEnabled,
    qualityProfile:
      response.recorder?.quality?.id || message.qualityProfile || "standard",
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

  await writeState({ recordings: [...current.recordings, recording] });

  if (
    recording.captureMode === "tab" &&
    recording.sourceType === SOURCE_TYPES.SHAREPOINT &&
    recording.lifecycle.followPlayback
  ) {
    const mediaState = await getSharePointMediaState(recording.tabId);
    if (mediaState?.media?.paused && !mediaState.media.ended) {
      return await setRecordingPaused(sessionId, true);
    }
  }

  return recording;
}

async function stopCapture(sessionId) {
  const current = await readState();
  const active = findRecording(current, sessionId);
  if (!active) return null;

  if (active.captureMode === "display") {
    const response = await sendDisplayCommand(sessionId, "stop");
    return response.recording || null;
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_STOP",
    sessionId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to stop tab capture.");
  }

  const endedAt = Date.now();
  const result = response.recording || null;

  if (result?.saved) {
    await appendHistory({
      title: active.title,
      sourceType: active.sourceType,
      captureMode: active.captureMode,
      startedAt: active.startedAt,
      endedAt,
      durationMs: recordingDurationMs(active, endedAt),
      result: "saved",
      filename: result.filename,
      size: result.size
    });
  }

  await removeRecording(sessionId);
  return result;
}

async function setRecordingPaused(sessionId, paused) {
  const current = await readState();
  const active = findRecording(current, sessionId);

  if (!active) {
    throw new Error("Active TabVault recording was not found.");
  }

  if (active.captureMode === "display") {
    const response = await sendDisplayCommand(sessionId, paused ? "pause" : "resume");
    return response.recording || await updateDisplaySession({
      sessionId,
      status: paused ? "paused" : "capturing"
    });
  }

  const response = await chrome.runtime.sendMessage({
    type: paused ? "TABVAULT_OFFSCREEN_PAUSE" : "TABVAULT_OFFSCREEN_RESUME",
    sessionId
  });

  if (!response?.ok) {
    throw new Error(paused ? "Unable to pause recording." : "Unable to resume recording.");
  }

  const now = Date.now();
  let totalPausedMs = Number(active.totalPausedMs || 0);
  let pausedAt = active.pausedAt || null;

  if (paused) {
    pausedAt = now;
  } else if (pausedAt) {
    totalPausedMs += Math.max(0, now - pausedAt);
    pausedAt = null;
  }

  return await replaceRecording(sessionId, (recording) => ({
    ...recording,
    status: paused ? "paused" : "capturing",
    pausedAt,
    totalPausedMs
  }));
}

async function setLocalPlayback(sessionId, enabled) {
  const current = await readState();
  const active = findRecording(current, sessionId);

  if (!active) {
    throw new Error("Active TabVault recording was not found.");
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_OFFSCREEN_SET_LOCAL_PLAYBACK",
    sessionId,
    enabled: Boolean(enabled)
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to change local playback.");
  }

  return await replaceRecording(sessionId, (recording) => ({
    ...recording,
    localPlaybackEnabled: Boolean(enabled),
    audio: {
      ...(recording.audio || {}),
      localPlayback: Boolean(response.audio?.localPlayback)
    }
  }));
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await readState();
  await chrome.storage.local.set({
    tabVault: {
      ...current,
      version: chrome.runtime.getManifest().version,
      recordings: [],
      recording: null,
      history: current.history,
      settings: current.settings
    }
  });
  await updateBadge([]);
});

chrome.runtime.onStartup.addListener(async () => {
  await writeState({ recordings: [] });
});

chrome.tabCapture.onStatusChanged.addListener(async (info) => {
  const current = await readState();
  const matching = current.recordings.filter((recording) => recording.tabId === info.tabId);

  for (const recording of matching) {
    if (info.status === "error") {
      await replaceRecording(recording.sessionId, (item) => ({
        ...item,
        status: "error",
        error: "Chrome reported a tab capture error."
      }));
    } else if (info.status === "stopped") {
      await removeRecording(recording.sessionId);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  if (message?.type === "TABVAULT_PING") {
    sendResponse({
      ok: true,
      sourceTypes: SOURCE_TYPES,
      maxConcurrentRecordings: MAX_CONCURRENT_RECORDINGS
    });
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

  if (message?.type === "TABVAULT_CLEAR_HISTORY") {
    readState()
      .then((state) =>
        chrome.storage.local.set({
          tabVault: {
            ...state,
            history: []
          }
        })
      )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_SAVE_SETTINGS") {
    readState()
      .then((state) =>
        chrome.storage.local.set({
          tabVault: {
            ...state,
            settings: {
              ...state.settings,
              destinationFolder: String(
                message.destinationFolder || DEFAULT_SETTINGS.destinationFolder
              ),
              filenameTemplate: String(
                message.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate
              ),
              autoLowCpu: Boolean(message.autoLowCpu),
              teamsPriority: Boolean(message.teamsPriority)
            }
          }
        })
      )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_DOWNLOAD_BLOB") {
    chrome.downloads.download({
      url: message.blobUrl,
      filename: message.filename,
      saveAs: false,
      conflictAction: "uniquify"
    })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_GET_STATE") {
    readState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_REGISTER_DISPLAY_SESSION") {
    registerDisplaySession(message)
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_UPDATE_DISPLAY_SESSION") {
    updateDisplaySession(message)
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_COMPLETE_DISPLAY_SESSION") {
    completeDisplaySession(message)
      .then((recording) => sendResponse({ ok: true, recording }))
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
    stopCapture(message.sessionId)
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_SET_PAUSED") {
    setRecordingPaused(message.sessionId, Boolean(message.paused))
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_SET_LOCAL_PLAYBACK") {
    setLocalPlayback(message.sessionId, message.enabled)
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_SHAREPOINT_MEDIA_EVENT") {
    (async () => {
      const current = await readState();
      const tabId = sender.tab?.id;
      const recording = current.recordings.find(
        (item) =>
          item.tabId === tabId &&
          item.sourceType === SOURCE_TYPES.SHAREPOINT
      );

      if (!recording) return;

      if (message.event === "ended" && recording.lifecycle?.autoStopOnEnded) {
        await stopCapture(recording.sessionId);
        return;
      }

      if (!recording.lifecycle?.followPlayback) return;

      if (
        (message.event === "play" || message.event === "playing") &&
        recording.status === "paused"
      ) {
        await setRecordingPaused(recording.sessionId, false);
      } else if (
        message.event === "pause" &&
        recording.status === "capturing"
      ) {
        await setRecordingPaused(recording.sessionId, true);
      }
    })().catch(async (error) => {
      const current = await readState();
      const tabId = sender.tab?.id;
      const recording = current.recordings.find((item) => item.tabId === tabId);
      if (recording) {
        await replaceRecording(recording.sessionId, (item) => ({
          ...item,
          status: "error",
          error: error.message
        }));
      }
    });

    return false;
  }

  if (message?.type === "TABVAULT_CAPTURE_ENDED") {
    (async () => {
      const current = await readState();
      const active = findRecording(current, message.sessionId);
      const endedAt = Date.now();

      if (active && message.recording?.saved) {
        await appendHistory({
          title: active.title,
          sourceType: active.sourceType,
          captureMode: active.captureMode,
          startedAt: active.startedAt,
          endedAt,
          durationMs: recordingDurationMs(active, endedAt),
          result: "saved",
          filename: message.recording.filename,
          size: message.recording.size
        });
      }

      if (active) {
        await removeRecording(active.sessionId);
      }

      sendResponse({ ok: true });
    })().catch((error) =>
      sendResponse({ ok: false, error: error.message })
    );

    return true;
  }

  return false;
});
