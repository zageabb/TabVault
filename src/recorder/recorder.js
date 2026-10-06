let captureStream = null;
let captureTabId = null;
let playbackAudioContext = null;
let mediaRecorder = null;
let recordingMeta = null;
let localPlaybackEnabled = true;
let activeSessionId = null;
let chunkWriteChain = Promise.resolve();

const DB_NAME = "TabVaultRecordings";
const DB_VERSION = 1;
const CHUNKS_STORE = "chunks";
const SESSIONS_STORE = "sessions";
const CHUNK_TIMESLICE_MS = 5000;

function chooseMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function sanitizeFilename(value = "TabVault recording") {
  return value
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "TabVault recording";
}

function buildFilename(meta = {}) {
  const title = sanitizeFilename(meta.title || "TabVault recording");
  const started = new Date(meta.startedAt || Date.now());
  const stamp = [
    started.getFullYear(),
    String(started.getMonth() + 1).padStart(2, "0"),
    String(started.getDate()).padStart(2, "0")
  ].join("-");

  return `${title} - ${stamp}.webm`;
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
        db.createObjectStore(SESSIONS_STORE, {
          keyPath: "sessionId"
        });
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

async function createPersistedSession(meta, mimeType) {
  const sessionId = crypto.randomUUID();
  const session = {
    sessionId,
    title: meta.title || "TabVault recording",
    startedAt: meta.startedAt || Date.now(),
    mimeType,
    status: "recording",
    chunkCount: 0,
    bytesPersisted: 0,
    updatedAt: Date.now()
  };

  await withStore(SESSIONS_STORE, "readwrite", (store) => {
    store.put(session);
  });

  return sessionId;
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
        const chunks = (request.result || [])
          .sort((a, b) => a.index - b.index)
          .map((entry) => entry.blob);
        resolve(chunks);
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
      const store = transaction.objectStore(SESSIONS_STORE);
      const request = store.getAll();

      request.addEventListener("success", () => {
        const sessions = (request.result || [])
          .filter((session) => Number(session.chunkCount || 0) > 0)
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        resolve(sessions);
      });

      request.addEventListener("error", () => reject(request.error));
    });
  } finally {
    db.close();
  }
}

async function recoverPersistedSession(sessionId) {
  const sessions = await listPersistedSessions();
  const session = sessions.find((item) => item.sessionId === sessionId);

  if (!session) {
    throw new Error("Recoverable recording session was not found.");
  }

  const chunks = await readPersistedChunks(sessionId);

  if (!chunks.length) {
    throw new Error("No persisted media chunks were found for this recording.");
  }

  const mimeType = session.mimeType || "video/webm";
  const blob = new Blob(chunks, { type: mimeType });
  const filename = buildFilename({
    title: session.title || "Recovered TabVault recording",
    startedAt: session.startedAt || Date.now()
  });

  if (blob.size <= 0) {
    throw new Error("Recovered recording is empty.");
  }

  downloadBlob(blob, filename);

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

async function deletePersistedSession(sessionId) {
  if (!sessionId) {
    return;
  }

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
  if (!sessionId) {
    return;
  }

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

async function stopLocalAudioPassthrough() {
  if (!playbackAudioContext) {
    return;
  }

  try {
    await playbackAudioContext.close();
  } catch {
    // Ignore close errors during teardown.
  }

  playbackAudioContext = null;
}

async function startLocalAudioPassthrough(stream) {
  await stopLocalAudioPassthrough();

  if (!localPlaybackEnabled || stream.getAudioTracks().length === 0) {
    return false;
  }

  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;

  if (!AudioContextClass) {
    return false;
  }

  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  source.connect(context.destination);

  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      // Capture itself remains valid even if local playback cannot be resumed.
    }
  }

  playbackAudioContext = context;
  return true;
}

async function setLocalPlayback(enabled) {
  localPlaybackEnabled = Boolean(enabled);

  if (!captureStream) {
    return { localPlayback: false };
  }

  if (localPlaybackEnabled) {
    const active = await startLocalAudioPassthrough(captureStream);
    return { localPlayback: active };
  }

  await stopLocalAudioPassthrough();
  return { localPlayback: false };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function resetRecorderState() {
  mediaRecorder = null;
  recordingMeta = null;
  activeSessionId = null;
  chunkWriteChain = Promise.resolve();
}

function stopMediaRecorder({ save = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resetRecorderState();
      resolve({
        saved: false,
        filename: null,
        size: 0,
        mimeType: null,
        persistence: "indexeddb"
      });
      return;
    }

    const recorder = mediaRecorder;
    const meta = recordingMeta;
    const sessionId = activeSessionId;

    const onStop = async () => {
      try {
        await chunkWriteChain;
        await markSessionFinalizing(sessionId);

        const mimeType = recorder.mimeType || chooseMimeType() || "video/webm";
        const chunks = await readPersistedChunks(sessionId);
        const blob = new Blob(chunks, { type: mimeType });
        const filename = buildFilename(meta);

        if (save && blob.size > 0) {
          downloadBlob(blob, filename);
        }

        const info = {
          saved: Boolean(save && blob.size > 0),
          filename: save && blob.size > 0 ? filename : null,
          size: blob.size,
          mimeType,
          persistence: "indexeddb",
          chunkCount: chunks.length,
          sessionId
        };

        await deletePersistedSession(sessionId);
        resetRecorderState();
        resolve(info);
      } catch (error) {
        reject(error);
      }
    };

    recorder.addEventListener("stop", onStop, { once: true });
    recorder.stop();
  });
}

function pauseMediaRecorder() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return false;
  }

  mediaRecorder.pause();
  return true;
}

function resumeMediaRecorder() {
  if (!mediaRecorder || mediaRecorder.state !== "paused") {
    return false;
  }

  mediaRecorder.resume();
  return true;
}

async function startMediaRecorder(stream, meta) {
  const mimeType = chooseMimeType();
  const options = mimeType ? { mimeType } : undefined;

  recordingMeta = meta;
  chunkWriteChain = Promise.resolve();
  activeSessionId = await createPersistedSession(
    meta,
    mimeType || "video/webm"
  );

  let chunkIndex = 0;
  mediaRecorder = new MediaRecorder(stream, options);

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size <= 0 || !activeSessionId) {
      return;
    }

    const sessionId = activeSessionId;
    const index = chunkIndex;
    chunkIndex += 1;

    chunkWriteChain = chunkWriteChain.then(() =>
      persistChunk(sessionId, index, event.data)
    );
  });

  mediaRecorder.start(CHUNK_TIMESLICE_MS);

  return {
    mimeType: mediaRecorder.mimeType || mimeType || "video/webm",
    persistence: "indexeddb",
    chunkIntervalMs: CHUNK_TIMESLICE_MS,
    sessionId: activeSessionId
  };
}

async function stopStream({ notify = false, save = true } = {}) {
  const previousTabId = captureTabId;
  const recording = await stopMediaRecorder({ save });

  await stopLocalAudioPassthrough();

  if (captureStream) {
    for (const track of captureStream.getTracks()) {
      track.stop();
    }
  }

  captureStream = null;
  captureTabId = null;

  if (notify && previousTabId !== null) {
    await chrome.runtime.sendMessage({
      type: "TABVAULT_CAPTURE_ENDED",
      tabId: previousTabId,
      recording,
      target: "service-worker"
    });
  }

  return recording;
}

async function startStream(streamId, tabId, meta = {}, playbackEnabled = true) {
  await stopStream({ save: false });
  localPlaybackEnabled = Boolean(playbackEnabled);

  captureStream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  captureTabId = tabId;

  const videoTrack = captureStream.getVideoTracks()[0];
  const audioTrack = captureStream.getAudioTracks()[0];

  if (!videoTrack) {
    await stopStream({ save: false });
    throw new Error("Chrome did not provide a video track for this tab.");
  }

  videoTrack.addEventListener("ended", () => {
    stopStream({ notify: true, save: true }).catch(() => {});
  }, { once: true });

  const videoSettings = videoTrack.getSettings();
  const audioSettings = audioTrack?.getSettings?.() || {};
  const localPlayback = await startLocalAudioPassthrough(captureStream);
  const recorder = await startMediaRecorder(captureStream, {
    title: meta.title,
    startedAt: meta.startedAt || Date.now()
  });

  return {
    video: {
      width: videoSettings.width || null,
      height: videoSettings.height || null,
      frameRate: videoSettings.frameRate || null
    },
    audio: {
      available: Boolean(audioTrack),
      sampleRate: audioSettings.sampleRate || null,
      channelCount: audioSettings.channelCount || null,
      localPlayback
    },
    recorder
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TABVAULT_OFFSCREEN_START") {
    startStream(
      message.streamId,
      message.tabId,
      message.meta,
      message.localPlaybackEnabled
    )
      .then((media) => sendResponse({ ok: true, ...media }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_SET_LOCAL_PLAYBACK") {
    setLocalPlayback(message.enabled)
      .then((audio) => sendResponse({ ok: true, audio }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_PAUSE") {
    try {
      const paused = pauseMediaRecorder();
      sendResponse({ ok: paused });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_RESUME") {
    try {
      const resumed = resumeMediaRecorder();
      sendResponse({ ok: resumed });
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
    stopStream({ save: true })
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
