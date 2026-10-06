let captureStream = null;
let captureTabId = null;
let playbackAudioContext = null;

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

  if (stream.getAudioTracks().length === 0) {
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

async function stopStream({ notify = false } = {}) {
  const previousTabId = captureTabId;

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
      target: "service-worker"
    });
  }
}

async function startStream(streamId, tabId) {
  await stopStream();

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
    await stopStream();
    throw new Error("Chrome did not provide a video track for this tab.");
  }

  videoTrack.addEventListener("ended", () => {
    stopStream({ notify: true }).catch(() => {});
  }, { once: true });

  if (audioTrack) {
    audioTrack.addEventListener("ended", () => {
      // An audio track ending does not necessarily mean the tab capture itself
      // has ended, so keep the video stream alive.
    }, { once: true });
  }

  const videoSettings = videoTrack.getSettings();
  const audioSettings = audioTrack?.getSettings?.() || {};
  const localPlayback = await startLocalAudioPassthrough(captureStream);

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
    }
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TABVAULT_OFFSCREEN_START") {
    startStream(message.streamId, message.tabId)
      .then((media) => sendResponse({ ok: true, ...media }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TABVAULT_OFFSCREEN_STOP") {
    stopStream()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
