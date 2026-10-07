let config = null;
let recording = null;
let elapsedTimer = null;

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function setMessage(message = "") {
  const node = document.getElementById("message");
  node.textContent = message;
  node.classList.toggle("hidden", !message);
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

async function startRecording() {
  setMessage("");
  const chooseButton = document.getElementById("chooseButton");
  chooseButton.disabled = true;

  try {
    const desktop = await chooseDesktopSource();

    const response = await chrome.runtime.sendMessage({
      type: "TABVAULT_START_CAPTURE",
      tabId: config.tabId,
      title: config.title,
      url: config.url,
      sourceType: "generic",
      captureMode: "display",
      desktopStreamId: desktop.streamId,
      canRequestAudioTrack: desktop.canRequestAudioTrack,
      qualityProfile: config.qualityProfile,
      destinationFolder: config.destinationFolder,
      filenameTemplate: config.filenameTemplate,
      localPlaybackEnabled: config.localPlaybackEnabled,
      autoStopOnEnded: false,
      followPlayback: false
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unable to start Window / Screen recording.");
    }

    recording = response.recording;
    renderRecording();
  } catch (error) {
    setMessage(error.message);
    chooseButton.disabled = false;
  }
}

async function togglePause() {
  if (!recording) return;

  const paused = recording.status !== "paused";
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_SET_PAUSED",
    sessionId: recording.sessionId,
    paused
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to change pause state.");
  }

  recording = response.recording;
  renderRecording();
}

async function stopRecording() {
  if (!recording) return;

  const stopButton = document.getElementById("stopButton");
  stopButton.disabled = true;
  setMessage("Saving recording…");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TABVAULT_STOP_CAPTURE",
      sessionId: recording.sessionId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unable to stop recording.");
    }

    clearInterval(elapsedTimer);
    document.getElementById("status").textContent = "Saved";
    document.getElementById("recordingCard").classList.add("hidden");
    document.getElementById("readyCard").classList.remove("hidden");
    document.getElementById("chooseButton").disabled = false;
    setMessage(
      response.recording?.saved
        ? `Saved ${response.recording.filename}`
        : "Recording stopped."
    );
    recording = null;
  } catch (error) {
    setMessage(error.message);
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
    filenameTemplate: qs("template") || "{title} - {date}",
    localPlaybackEnabled: qs("playback") !== "0"
  };

  if (!Number.isInteger(config.tabId)) {
    throw new Error("The original browser tab is no longer available.");
  }

  document.getElementById("sourceTitle").textContent = config.title;
  document.getElementById("sourceUrl").textContent = config.url;
}

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
