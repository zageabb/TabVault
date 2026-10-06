let captureStream = null;
let captureTabId = null;

async function stopStream({ notify = false } = {}) {
  if (!captureStream) {
    captureTabId = null;
    return;
  }

  const previousTabId = captureTabId;

  for (const track of captureStream.getTracks()) {
    track.stop();
  }

  captureStream = null;
  captureTabId = null;

  if (notify) {
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
    audio: false
  });

  captureTabId = tabId;

  const videoTrack = captureStream.getVideoTracks()[0];

  if (!videoTrack) {
    await stopStream();
    throw new Error("Chrome did not provide a video track for this tab.");
  }

  videoTrack.addEventListener("ended", () => {
    stopStream({ notify: true }).catch(() => {});
  }, { once: true });

  const settings = videoTrack.getSettings();

  return {
    width: settings.width || null,
    height: settings.height || null,
    frameRate: settings.frameRate || null
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TABVAULT_OFFSCREEN_START") {
    startStream(message.streamId, message.tabId)
      .then((video) => sendResponse({ ok: true, video }))
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
