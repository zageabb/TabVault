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
  }
};

let config = null;
let recording = null;
let captureStream = null;
let mediaRecorder = null;
let chunkWriteChain = Promise.resolve();
let elapsedTimer = null;
let stopping = false;

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function setMessage(message = "") {
  const node = document.getElementById("message");
  node.textContent = message;
  node.classList.toggle("hidden", !message);
}

function resolveQualityProfile(profileId) {
  return QUALITY_PROFILES[profileId] || QUALITY_PROFILES.standard;
}

function chooseMimeType() {
  const candidates = [
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
    title: sanitizeFilename(meta.title || "Window Screen recording"),
    date,
    time,
    source: "generic"
  };

  return sanitizeFilename(
    String(meta.filenameTemplate || "{title} - {date}").replace(
      /\{(title|date|time|source)\}/g,
      (_match, key) => replacements[key]
    )
  );
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

async function createPersistedSession(meta, mimeType) {
  const db = await openRecordingDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(SESSIONS_STORE, "readwrite");
      transaction.objectStore(SESSIONS_STORE).put({
        sessionId: meta.sessionId,
        title: meta.title,
        sourceType: "generic",
        captureMode: "display",
        qualityProfile: meta.qualityProfile,
        filenameTemplate: meta.filenameTemplate,
        destinationFolder: meta.destinationFolder,
        startedAt: meta.startedAt,
        mimeType,
        status: "recording",
        chunkCount: 0,
        bytesPersisted: 0,
        updatedAt: Date.now()
      });
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    db.close();
  }
}

async function persistChunk(sessionId, index, blob) {
  const db = await openRecordingDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([CHUNKS_STORE, SESSIONS_STORE], "readwrite");
      const chunks = transaction.objectStore(CHUNKS_STORE);
      const sessions = transaction.objectStore(SESSIONS_STORE);

      chunks.put({
        sessionId,
        index,
        blob,
        size: blob.size,
        createdAt: Date.now()
      });

      const request = sessions.get(sessionId);
      request.addEventListener("success", () => {
        const session = request.result;
        if (session) {
          session.chunkCount = Math.max(Number(session.chunkCount || 0), index + 1);
          session.bytesPersisted = Number(session.bytesPersisted || 0) + blob.size;
          session.updatedAt = Date.now();
          sessions.put(session);
        }
      });

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
      const index = transaction.objectStore(CHUNKS_STORE).index("sessionId");
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

async function deletePersistedSession(sessionId) {
  const db = await openRecordingDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([CHUNKS_STORE, SESSIONS_STORE], "readwrite");
      const chunks = transaction.objectStore(CHUNKS_STORE);
      const sessions = transaction.objectStore(SESSIONS_STORE);
      const index = chunks.index("sessionId");
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(sessionId));

      cursorRequest.addEventListener("success", () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          sessions.delete(sessionId);
          return;
        }
        chunks.delete(cursor.primaryKey);
        cursor.continue();
      });

      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("error", () => reject(transaction.error));
      cursorRequest.addEventListener("error", () => reject(cursorRequest.error));
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
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function formatElapsed() {
  if (!recording?.startedAt) return "00:00:00";

  const now = recording.status === "paused"
    ? Number(recording.pausedAt || Date.now())
    : Date.now();
  const pausedMs = Number(recording.totalPausedMs || 0);
  const ms = Math.max(0, now - Number(recording.startedAt) - pausedMs);
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function startTimer() {
  clearInterval(elapsedTimer);
  document.getElementById("elapsed").textContent = formatElapsed();
  elapsedTimer = setInterval(() => {
    document.getElementById("elapsed").textContent = formatElapsed();
  }, 1000);
}

function chooseDesktopSource() {
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(
      ["window", "screen", "audio"],
      (streamId, options = {}) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!streamId) {
          reject(new Error("Window / screen selection was cancelled."));
          return;
        }

        resolve({
          streamId,
          canRequestAudioTrack: Boolean(options.canRequestAudioTrack)
        });
      }
    );
  });
}

async function consumeDesktopStream(selection) {
  return await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: selection.streamId
      }
    },
    audio: selection.canRequestAudioTrack
      ? {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: selection.streamId
          }
        }
      : false
  });
}

function renderRecording() {
  document.getElementById("readyCard").classList.add("hidden");
  document.getElementById("recordingCard").classList.remove("hidden");
  document.getElementById("status").textContent =
    recording?.status === "paused" ? "Paused" : "Recording";
  document.getElementById("audioState").textContent =
    recording?.audio?.available ? "Active" : "Unavailable";
  document.getElementById("pauseButton").textContent =
    recording?.status === "paused" ? "Resume" : "Pause";
  startTimer();
}

async function notifyDisplayState(status) {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_UPDATE_DISPLAY_SESSION",
    sessionId: recording.sessionId,
    status
  });

  if (response?.ok && response.recording) {
    recording = response.recording;
  }
}

async function startRecording() {
  setMessage("");
  const chooseButton = document.getElementById("chooseButton");
  chooseButton.disabled = true;

  try {
    const selection = await chooseDesktopSource();
    captureStream = await consumeDesktopStream(selection);

    const videoTrack = captureStream.getVideoTracks()[0];
    const audioTrack = captureStream.getAudioTracks()[0];

    if (!videoTrack) {
      throw new Error("Chrome did not provide a video track for the selected surface.");
    }

    const startedAt = Date.now();
    const sessionId = crypto.randomUUID();
    const quality = resolveQualityProfile(config.qualityProfile);
    const mimeType = chooseMimeType();

    recording = {
      sessionId,
      status: "capturing",
      tabId: config.tabId,
      title: config.title,
      url: config.url,
      sourceType: "generic",
      captureMode: "display",
      startedAt,
      totalPausedMs: 0,
      pausedAt: null,
      qualityProfile: quality.id,
      filenameTemplate: config.filenameTemplate,
      destinationFolder: config.destinationFolder,
      audio: {
        available: Boolean(audioTrack),
        localPlayback: false
      },
      video: {
        width: videoTrack.getSettings().width || null,
        height: videoTrack.getSettings().height || null,
        frameRate: videoTrack.getSettings().frameRate || null
      }
    };

    await createPersistedSession(recording, mimeType || "video/webm");

    chunkWriteChain = Promise.resolve();
    let chunkIndex = 0;

    mediaRecorder = new MediaRecorder(captureStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: quality.videoBitsPerSecond,
      audioBitsPerSecond: quality.audioBitsPerSecond
    });

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size <= 0 || !recording) return;
      const index = chunkIndex++;
      const sessionIdForChunk = recording.sessionId;
      chunkWriteChain = chunkWriteChain.then(() =>
        persistChunk(sessionIdForChunk, index, event.data)
      );
    });

    mediaRecorder.start(CHUNK_TIMESLICE_MS);

    const register = await chrome.runtime.sendMessage({
      type: "TABVAULT_REGISTER_DISPLAY_SESSION",
      sessionId,
      tabId: config.tabId,
      title: config.title,
      url: config.url,
      sourceType: "generic",
      startedAt,
      qualityProfile: quality.id,
      audio: recording.audio,
      video: recording.video,
      recorder: {
        mimeType: mediaRecorder.mimeType || mimeType || "video/webm",
        persistence: "indexeddb",
        chunkIntervalMs: CHUNK_TIMESLICE_MS
      }
    });

    if (!register?.ok) {
      throw new Error(register?.error || "Unable to register display recording.");
    }

    recording = {
      ...recording,
      ...register.recording
    };

    videoTrack.addEventListener("ended", () => {
      if (recording && !stopping) {
        stopRecording().catch((error) => setMessage(error.message));
      }
    }, { once: true });

    renderRecording();
  } catch (error) {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    if (captureStream) {
      for (const track of captureStream.getTracks()) track.stop();
    }
    if (recording?.sessionId) {
      await deletePersistedSession(recording.sessionId).catch(() => {});
    }
    mediaRecorder = null;
    captureStream = null;
    recording = null;
    setMessage(`${error.name ? error.name + ": " : ""}${error.message}`);
    chooseButton.disabled = false;
  }
}

async function togglePause() {
  if (!recording || !mediaRecorder) return;

  if (recording.status === "paused") {
    if (mediaRecorder.state === "paused") mediaRecorder.resume();
    await notifyDisplayState("capturing");
  } else {
    if (mediaRecorder.state === "recording") mediaRecorder.pause();
    await notifyDisplayState("paused");
  }

  renderRecording();
}

async function finalizeRecorder() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    throw new Error("Display recorder is not active.");
  }

  return await new Promise((resolve, reject) => {
    mediaRecorder.addEventListener("stop", async () => {
      try {
        await chunkWriteChain;
        await markSessionFinalizing(recording.sessionId);
        const chunks = await readPersistedChunks(recording.sessionId);
        const mimeType = mediaRecorder.mimeType || chooseMimeType() || "video/webm";
        const blob = new Blob(chunks, { type: mimeType });

        if (blob.size <= 0) {
          throw new Error("The display recording contained no media data.");
        }

        const filename = buildFilename(recording);
        await downloadBlob(blob, filename);
        await deletePersistedSession(recording.sessionId);

        resolve({
          saved: true,
          filename,
          size: blob.size,
          mimeType,
          chunkCount: chunks.length,
          sessionId: recording.sessionId
        });
      } catch (error) {
        reject(error);
      }
    }, { once: true });

    mediaRecorder.stop();
  });
}

async function stopRecording() {
  if (!recording || stopping) return null;

  stopping = true;
  const stopButton = document.getElementById("stopButton");
  stopButton.disabled = true;
  setMessage("Saving recording…");

  try {
    const result = await finalizeRecorder();

    if (captureStream) {
      for (const track of captureStream.getTracks()) track.stop();
    }

    const complete = await chrome.runtime.sendMessage({
      type: "TABVAULT_COMPLETE_DISPLAY_SESSION",
      sessionId: recording.sessionId,
      recording: result
    });

    if (!complete?.ok) {
      throw new Error(complete?.error || "Recording saved but state cleanup failed.");
    }

    clearInterval(elapsedTimer);
    document.getElementById("status").textContent = "Saved";
    document.getElementById("recordingCard").classList.add("hidden");
    document.getElementById("readyCard").classList.remove("hidden");
    document.getElementById("chooseButton").disabled = false;
    setMessage(`Saved ${result.filename}`);

    mediaRecorder = null;
    captureStream = null;
    recording = null;
    return result;
  } finally {
    stopping = false;
    stopButton.disabled = false;
  }
}

function loadConfig() {
  config = {
    tabId: Number(qs("tabId")),
    title: qs("title") || "Window / Screen recording",
    url: qs("url") || "",
    qualityProfile: qs("quality") || "standard",
    destinationFolder: qs("folder") || "TabVault",
    filenameTemplate: qs("template") || "{title} - {date}"
  };

  if (!Number.isInteger(config.tabId)) {
    throw new Error("The original browser tab is no longer available.");
  }

  document.getElementById("sourceTitle").textContent = config.title;
  document.getElementById("sourceUrl").textContent = config.url;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "display-controller" || message?.type !== "TABVAULT_DISPLAY_COMMAND") {
    return false;
  }

  if (!recording || message.sessionId !== recording.sessionId) {
    return false;
  }

  if (message.command === "stop") {
    stopRecording()
      .then((result) => sendResponse({ ok: true, recording: result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.command === "pause" || message.command === "resume") {
    const shouldPause = message.command === "pause";

    (async () => {
      if (shouldPause && mediaRecorder?.state === "recording") {
        mediaRecorder.pause();
        await notifyDisplayState("paused");
      } else if (!shouldPause && mediaRecorder?.state === "paused") {
        mediaRecorder.resume();
        await notifyDisplayState("capturing");
      }

      renderRecording();
      sendResponse({ ok: true, recording });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  return false;
});

window.addEventListener("beforeunload", (event) => {
  if (recording && mediaRecorder?.state !== "inactive" && !stopping) {
    event.preventDefault();
    event.returnValue = "";
  }
});

loadConfig();
document.getElementById("chooseButton").addEventListener("click", () => {
  startRecording().catch((error) => setMessage(error.message));
});
document.getElementById("pauseButton").addEventListener("click", () => {
  togglePause().catch((error) => setMessage(error.message));
});
document.getElementById("stopButton").addEventListener("click", () => {
  stopRecording().catch((error) => setMessage(error.message));
});
