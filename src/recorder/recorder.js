const activeSessions = new Map();

const DB_NAME = "TabVaultRecordings";
const DB_VERSION = 1;
const CHUNKS_STORE = "chunks";
const SESSIONS_STORE = "sessions";
const CHUNK_TIMESLICE_MS = 5000;

const QUALITY_PROFILES = {
  standard: {
    id: "standard",
    label: "Standard",
    videoBitsPerSecond: 4_000_000,
    audioBitsPerSecond: 128_000
  },
  high: {
    id: "high",
    label: "High",
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 192_000
  },
  low: {
    id: "low",
    label: "Low CPU",
    maxWidth: 1280,
    maxHeight: 720,
    maxFrameRate: 10,
    videoBitsPerSecond: 1_000_000,
    audioBitsPerSecond: 128_000
  },
  minimal: {
    id: "minimal",
    label: "Minimal",
    maxWidth: 854,
    maxHeight: 480,
    maxFrameRate: 5,
    videoBitsPerSecond: 400_000,
    audioBitsPerSecond: 96_000
  }
};

function resolveQualityProfile(profileId) {
  return QUALITY_PROFILES[profileId] || QUALITY_PROFILES.standard;
}

function chooseMimeType(profileId = "standard") {
  const lowLoad = profileId === "low" || profileId === "minimal";
  const candidates = lowLoad
    ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
    : [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function sanitizeFilename(value = "TabVault recording") {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "TabVault recording";
}

function sanitizeFolderPath(value = "TabVault") {
  const parts = String(value || "TabVault")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => sanitizeFilename(part))
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || "TabVault";
}

function renderFilenameTemplate(meta = {}) {
  const started = new Date(meta.startedAt || Date.now());
  const date = [
    started.getFullYear(),
    String(started.getMonth() + 1).padStart(2, "0"),
    String(started.getDate()).padStart(2, "0")
  ].join("-");
  const time = [
    String(started.getHours()).padStart(2, "0"),
    String(started.getMinutes()).padStart(2, "0"),
    String(started.getSeconds()).padStart(2, "0")
  ].join("-");

  const replacements = {
    title: sanitizeFilename(meta.title || "TabVault recording"),
    date,
    time,
    source: sanitizeFilename(meta.sourceType || "generic")
  };

  const template = String(meta.filenameTemplate || "{title} - {date}");
  const rendered = template.replace(
    /\{(title|date|time|source)\}/g,
    (_match, key) => replacements[key]
  );

  return sanitizeFilename(rendered) || replacements.title;
}

function buildFilename(meta = {}) {
  const folder = sanitizeFolderPath(meta.destinationFolder || "TabVault");
  return `${folder}/${renderFilenameTemplate(meta)}.webm`;
}

function openRecordingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunks = db.createObjectStore(CHUNKS_STORE, {
          keyPath: ["sessionId", "index"]
        });
        chunks.createIndex("sessionId", "sessionId", { unique: false });
      }

      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: "sessionId" });
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function withStore(storeName, mode, operation) {
  const db = await openRecordingDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;

      try {
        result = operation(store);
      } catch (error) {
        reject(error);
        return;
      }

      transaction.addEventListener("complete", () => resolve(result));
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  } finally {
    db.close();
  }
}

async function createPersistedSession(sessionId, meta, mimeType) {
  const session = {
    sessionId,
    title: meta.title || "TabVault recording",
    sourceType: meta.sourceType || "generic",
    qualityProfile: meta.qualityProfile || "standard",
    captureMode: meta.captureMode || "tab",
    filenameTemplate: meta.filenameTemplate || "{title} - {date}",
    destinationFolder: meta.destinationFolder || "TabVault",
    startedAt: meta.startedAt || Date.now(),
    mimeType,
    status: "recording",
    chunkCount: 0,
    bytesPersisted: 0,
    updatedAt: Date.now()
  };

  await withStore(SESSIONS_STORE, "readwrite", (store) => store.put(session));
}

async function persistChunk(sessionId, index, blob) {
  await withStore(CHUNKS_STORE, "readwrite", (store) => {
    store.put({
      sessionId,
      index,
      blob,
      size: blob.size,
      createdAt: Date.now()
    });
  });

  const db = await openRecordingDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(SESSIONS_STORE, "readwrite");
      const store = transaction.objectStore(SESSIONS_STORE);
      const request = store.get(sessionId);

      request.addEventListener("success", () => {
        const session = request.result;
        if (session) {
          session.chunkCount = Math.max(Number(session.chunkCount || 0), index + 1);
          session.bytesPersisted = Number(session.bytesPersisted || 0) + blob.size;
          session.updatedAt = Date.now();
          store.put(session);
        }
      });
      request.addEventListener("error", () => reject(request.error));
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    db.close();
  }
}

async function readPersistedChunks(sessionId) {
  const db = await openRecordingDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(CHUNKS_STORE, "readonly");
      const store = transaction.objectStore(CHUNKS_STORE);
      const index = store.index("sessionId");
      const request = index.getAll(IDBKeyRange.only(sessionId));

      request.addEventListener("success", () => {
        resolve(
          (request.result || [])
            .sort((a, b) => a.index - b.index)
            .map((entry) => entry.blob)
        );
      });
      request.addEventListener("error", () => reject(request.error));
    });
  } finally {
    db.close();
  }
}

async function listPersistedSessions() {
  const db = await openRecordingDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(SESSIONS_STORE, "readonly");
      const request = transaction.objectStore(SESSIONS_STORE).getAll();

      request.addEventListener("success", () => {
        resolve(
          (request.result || [])
            .filter((session) => Number(session.chunkCount || 0) > 0)
            .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        );
      });
      request.addEventListener("error", () => reject(request.error));
    });
  } finally {
    db.close();
  }
}

async function deletePersistedSession(sessionId) {
  if (!sessionId) return;

  const db = await openRecordingDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [CHUNKS_STORE, SESSIONS_STORE],
        "readwrite"
      );
      const chunksStore = transaction.objectStore(CHUNKS_STORE);
      const sessionsStore = transaction.objectStore(SESSIONS_STORE);
      const index = chunksStore.index("sessionId");
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(sessionId));

      cursorRequest.addEventListener("success", () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          sessionsStore.delete(sessionId);
          return;
        }
        chunksStore.delete(cursor.primaryKey);
        cursor.continue();
      });
      cursorRequest.addEventListener("error", () => reject(cursorRequest.error));
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    db.close();
  }
}

async function markSessionFinalizing(sessionId) {
  const db = await openRecordingDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(SESSIONS_STORE, "readwrite");
      const store = transaction.objectStore(SESSIONS_STORE);
      const request = store.get(sessionId);

      request.addEventListener("success", () => {
        const session = request.result;
        if (session) {
          session.status = "finalizing";
          session.updatedAt = Date.now();
          store.put(session);
        }
      });
      request.addEventListener("error", () => reject(request.error));
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    db.close();
  }
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TABVAULT_DOWNLOAD_BLOB",
      blobUrl: url,
      filename,
      target: "service-worker"
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Browser download could not be started.");
    }
    return response.downloadId || null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function recoverPersistedSession(sessionId) {
  const sessions = await listPersistedSessions();
  const session = sessions.find((item) => item.sessionId === sessionId);
  if (!session) throw new Error("Recoverable recording session was not found.");

  const chunks = await readPersistedChunks(sessionId);
  if (!chunks.length) {
    throw new Error("No persisted media chunks were found for this recording.");
  }

  const mimeType = session.mimeType || "video/webm";
  const rawBlob = new Blob(chunks, { type: mimeType });
  if (rawBlob.size <= 0) throw new Error("Recovered recording is empty.");

  const estimatedDurationMs = Math.max(
    CHUNK_TIMESLICE_MS,
    Number(session.updatedAt || Date.now()) - Number(session.startedAt || Date.now())
  );
  const blob = await globalThis.TabVaultWebm.repairWebmDuration(
    rawBlob,
    estimatedDurationMs
  );

  const filename = buildFilename(session);
  await downloadBlob(blob, filename);
  await deletePersistedSession(sessionId);

  return {
    saved: true,
    recovered: true,
    filename,
    size: blob.size,
    mimeType,
    chunkCount: chunks.length,
    sessionId
  };
}

function getActiveSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error("Active recording session was not found.");
  return session;
}

async function stopAudioPassthrough(session) {
  if (!session.audioContext) return;

  try {
    await session.audioContext.close();
  } catch {
    // Ignore close errors during teardown.
  }
  session.audioContext = null;
}

async function startAudioPassthrough(session) {
  await stopAudioPassthrough(session);

  if (!session.localPlaybackEnabled || session.stream.getAudioTracks().length === 0) {
    return false;
  }

  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return false;

  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(session.stream);
  source.connect(context.destination);

  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      // Capture remains valid even if local playback cannot resume.
    }
  }

  session.audioContext = context;
  return true;
}

async function setLocalPlayback(sessionId, enabled) {
  const session = getActiveSession(sessionId);
  session.localPlaybackEnabled = Boolean(enabled);

  if (session.localPlaybackEnabled) {
    return { localPlayback: await startAudioPassthrough(session) };
  }

  await stopAudioPassthrough(session);
  return { localPlayback: false };
}

async function startMediaRecorder(session) {
  const quality = resolveQualityProfile(session.meta.qualityProfile);
  const mimeType = chooseMimeType(quality.id);
  const options = {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: quality.videoBitsPerSecond,
    audioBitsPerSecond: quality.audioBitsPerSecond
  };

  session.meta = {
    ...session.meta,
    qualityProfile: quality.id
  };
  session.chunkWriteChain = Promise.resolve();

  await createPersistedSession(
    session.sessionId,
    session.meta,
    mimeType || "video/webm"
  );

  let chunkIndex = 0;
  const recorder = new MediaRecorder(session.recordStream, options);
  session.mediaRecorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size <= 0) return;

    const index = chunkIndex++;
    session.chunkWriteChain = session.chunkWriteChain.then(() =>
      persistChunk(session.sessionId, index, event.data)
    );
  });

  recorder.start(CHUNK_TIMESLICE_MS);

  return {
    mimeType: recorder.mimeType || mimeType || "video/webm",
    persistence: "indexeddb",
    chunkIntervalMs: CHUNK_TIMESLICE_MS,
    sessionId: session.sessionId,
    quality: {
      id: quality.id,
      label: quality.label,
      videoBitsPerSecond: recorder.videoBitsPerSecond || quality.videoBitsPerSecond,
      audioBitsPerSecond: recorder.audioBitsPerSecond || quality.audioBitsPerSecond
    }
  };
}

async function finalizeRecorder(session, save = true) {
  const recorder = session.mediaRecorder;

  if (!recorder || recorder.state === "inactive") {
    return {
      saved: false,
      filename: null,
      size: 0,
      mimeType: null,
      persistence: "indexeddb",
      sessionId: session.sessionId
    };
  }

  return await new Promise((resolve, reject) => {
    recorder.addEventListener("stop", async () => {
      try {
        await session.chunkWriteChain;
        await markSessionFinalizing(session.sessionId);

        const mimeType = recorder.mimeType || chooseMimeType() || "video/webm";
        const chunks = await readPersistedChunks(session.sessionId);
        const rawBlob = new Blob(chunks, { type: mimeType });
        const now = Date.now();
        const livePauseMs = session.pauseStartedAt
          ? Math.max(0, now - session.pauseStartedAt)
          : 0;
        const durationMs = Math.max(
          1,
          now - session.recordingStartedAt - session.totalPausedMs - livePauseMs
        );
        const blob = await globalThis.TabVaultWebm.repairWebmDuration(
          rawBlob,
          durationMs
        );
        const filename = buildFilename(session.meta);

        if (save && blob.size > 0) {
          await downloadBlob(blob, filename);
        }

        const info = {
          saved: Boolean(save && blob.size > 0),
          filename: save && blob.size > 0 ? filename : null,
          size: blob.size,
          mimeType,
          persistence: "indexeddb",
          chunkCount: chunks.length,
          sessionId: session.sessionId
        };

        await deletePersistedSession(session.sessionId);
        resolve(info);
      } catch (error) {
        reject(error);
      }
    }, { once: true });

    recorder.stop();
  });
}

async function stopSession(sessionId, { notify = false, save = true } = {}) {
  const session = getActiveSession(sessionId);
  const result = await finalizeRecorder(session, save);

  await stopAudioPassthrough(session);
  await session.audioMix?.cleanup();
  for (const track of session.stream.getTracks()) {
    track.stop();
  }

  activeSessions.delete(sessionId);

  if (notify) {
    await chrome.runtime.sendMessage({
      type: "TABVAULT_CAPTURE_ENDED",
      sessionId,
      tabId: session.tabId,
      recording: result,
      target: "service-worker"
    });
  }

  return result;
}

function pauseSession(sessionId) {
  const session = getActiveSession(sessionId);
  if (!session.mediaRecorder || session.mediaRecorder.state !== "recording") {
    return false;
  }
  session.pauseStartedAt = Date.now();
  session.mediaRecorder.pause();
  return true;
}

function resumeSession(sessionId) {
  const session = getActiveSession(sessionId);
  if (!session.mediaRecorder || session.mediaRecorder.state !== "paused") {
    return false;
  }
  if (session.pauseStartedAt) {
    session.totalPausedMs += Math.max(0, Date.now() - session.pauseStartedAt);
    session.pauseStartedAt = null;
  }
  session.mediaRecorder.resume();
  return true;
}

async function startSession({
  sessionId,
  streamId,
  tabId,
  meta = {},
  localPlaybackEnabled = true,
  captureMode = "tab",
  canRequestAudioTrack = true,
  recordMicrophone = false
}) {
  if (!sessionId) throw new Error("A recording session ID is required.");
  if (activeSessions.has(sessionId)) {
    throw new Error("Recording session is already active.");
  }

  const chromeMediaSource = captureMode === "display" ? "desktop" : "tab";
  const audioConstraint = canRequestAudioTrack
    ? {
        mandatory: {
          chromeMediaSource,
          chromeMediaSourceId: streamId
        }
      }
    : false;

  const quality = resolveQualityProfile(meta.qualityProfile);
  const sourceMandatory = { chromeMediaSource, chromeMediaSourceId: streamId };
  const constrainedMandatory = quality.maxWidth
    ? {
        ...sourceMandatory,
        maxWidth: quality.maxWidth,
        maxHeight: quality.maxHeight,
        maxFrameRate: quality.maxFrameRate
      }
    : sourceMandatory;
  let captureConstraintFallback = false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: constrainedMandatory },
      audio: audioConstraint
    });
  } catch (error) {
    // Fall back to unbounded capture only if the browser rejected low-load limits.
    // Other capture failures should retain their original diagnostic.
    if (!quality.maxWidth || !["OverconstrainedError", "ConstraintNotSatisfiedError", "TypeError"].includes(error?.name)) throw error;
    captureConstraintFallback = true;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: sourceMandatory },
      audio: audioConstraint
    });
  }

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];

  if (!videoTrack) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("Chrome did not provide a video track for this tab.");
  }

  const session = {
    sessionId,
    tabId,
    stream,
    audioContext: null,
    audioMix: null,
    recordStream: stream,
    mediaRecorder: null,
    chunkWriteChain: Promise.resolve(),
    recordingStartedAt: Date.now(),
    totalPausedMs: 0,
    pauseStartedAt: null,
    localPlaybackEnabled: Boolean(localPlaybackEnabled),
    meta: {
      ...meta,
      captureMode,
      startedAt: meta.startedAt || Date.now()
    }
  };

  activeSessions.set(sessionId, session);

  videoTrack.addEventListener("ended", () => {
    if (!activeSessions.has(sessionId)) return;
    stopSession(sessionId, { notify: true, save: true }).catch(() => {});
  }, { once: true });

  try {
    const videoSettings = videoTrack.getSettings();
    const audioSettings = audioTrack?.getSettings?.() || {};
    const localPlayback = await startAudioPassthrough(session);
    session.audioMix = await globalThis.TabVaultAudio.prepare(stream, recordMicrophone);
    session.recordStream = session.audioMix.stream;
    const recorder = await startMediaRecorder(session);

    return {
      video: {
        width: videoSettings.width || null,
        height: videoSettings.height || null,
        frameRate: videoSettings.frameRate || null,
        requestedMaxWidth: quality.maxWidth || null,
        requestedMaxHeight: quality.maxHeight || null,
        requestedMaxFrameRate: quality.maxFrameRate || null,
        constraintFallback: captureConstraintFallback,
        constraintsMet: !quality.maxWidth || (
          Number(videoSettings.width) <= quality.maxWidth &&
          Number(videoSettings.height) <= quality.maxHeight &&
          Number(videoSettings.frameRate) <= quality.maxFrameRate
        )
      },
      audio: {
        available: Boolean(audioTrack),
        sampleRate: audioSettings.sampleRate || null,
        channelCount: audioSettings.channelCount || null,
        localPlayback,
        microphone: Boolean(session.audioMix?.microphone)
      },
      recorder
    };
  } catch (error) {
    activeSessions.delete(sessionId);
    await stopAudioPassthrough(session);
    await session.audioMix?.cleanup();
    for (const track of stream.getTracks()) track.stop();
    await deletePersistedSession(sessionId).catch(() => {});
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TABVAULT_OFFSCREEN_START") {
    startSession({
      sessionId: message.sessionId,
      streamId: message.streamId,
      tabId: message.tabId,
      meta: message.meta,
      localPlaybackEnabled: message.localPlaybackEnabled,
      captureMode: message.captureMode || "tab",
      canRequestAudioTrack: message.canRequestAudioTrack !== false,
      recordMicrophone: Boolean(message.recordMicrophone)
    })
      .then((media) => sendResponse({ ok: true, ...media }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_SET_LOCAL_PLAYBACK") {
    setLocalPlayback(message.sessionId, message.enabled)
      .then((audio) => sendResponse({ ok: true, audio }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_PAUSE") {
    try {
      sendResponse({ ok: pauseSession(message.sessionId) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_RESUME") {
    try {
      sendResponse({ ok: resumeSession(message.sessionId) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_LIST_RECOVERABLE") {
    listPersistedSessions()
      .then((sessions) => sendResponse({ ok: true, sessions }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_RECOVER") {
    recoverPersistedSession(message.sessionId)
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_DISCARD_RECOVERY") {
    deletePersistedSession(message.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_STOP") {
    stopSession(message.sessionId, { save: true })
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
