let captureStream = null;
let captureTabId = null;
let playbackAudioContext = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingMeta = null;
let localPlaybackEnabled = true;

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

function stopMediaRecorder({ save = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      const info = {
        saved: false,
        filename: null,
        size: 0,
        mimeType: null
      };
      mediaRecorder = null;
      recordedChunks = [];
      recordingMeta = null;
      resolve(info);
      return;
    }

    const recorder = mediaRecorder;
    const meta = recordingMeta;

    const onStop = () => {
      try {
        const mimeType = recorder.mimeType || chooseMimeType() || "video/webm";
        const blob = new Blob(recordedChunks, { type: mimeType });
        const filename = buildFilename(meta);

        if (save && blob.size > 0) {
          downloadBlob(blob, filename);
        }

        const info = {
          saved: Boolean(save && blob.size > 0),
          filename: save && blob.size > 0 ? filename : null,
          size: blob.size,
          mimeType
        };

        mediaRecorder = null;
        recordedChunks = [];
        recordingMeta = null;
        resolve(info);
      } catch (error) {
        reject(error);
      }
    };

    recorder.addEventListener("stop", onStop, { once: true });
    recorder.stop();
  });
}

function startMediaRecorder(stream, meta) {
  const mimeType = chooseMimeType();
  const options = mimeType ? { mimeType } : undefined;

  recordedChunks = [];
  recordingMeta = meta;
  mediaRecorder = new MediaRecorder(stream, options);

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  });

  mediaRecorder.start(5000);

  return {
    mimeType: mediaRecorder.mimeType || mimeType || "video/webm"
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
  const recorder = startMediaRecorder(captureStream, {
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

  if (message?.type === "TABVAULT_OFFSCREEN_STOP") {
    stopStream({ save: true })
      .then((recording) => sendResponse({ ok: true, recording }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
