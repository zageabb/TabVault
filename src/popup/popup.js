function classifySource(url = "") {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return { type: "generic", label: "Generic tab" };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (
    host === "teams.microsoft.com" ||
    host.endsWith(".teams.microsoft.com") ||
    host === "teams.cloud.microsoft" ||
    host.endsWith(".teams.cloud.microsoft") ||
    host === "teams.live.com" ||
    host.endsWith(".teams.live.com")
  ) {
    return { type: "teams", label: "Microsoft Teams" };
  }

  if (
    host.endsWith(".sharepoint.com") ||
    path.includes("/stream.aspx")
  ) {
    return { type: "sharepoint", label: "SharePoint / Stream" };
  }

  return { type: "generic", label: "Generic tab" };
}

let activeTab = null;
let activeSource = null;
let currentRecording = null;
let elapsedTimer = null;

function formatElapsed(recording) {
  const startedAt = Number(recording?.startedAt || Date.now());
  const now = recording?.status === "paused"
    ? Number(recording.pausedAt || Date.now())
    : Date.now();
  const pausedMs = Number(recording?.totalPausedMs || 0);
  const elapsedMs = Math.max(0, now - startedAt - pausedMs);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function startElapsedTimer(recording) {
  stopElapsedTimer();
  const elapsed = document.getElementById("elapsedTime");

  const refresh = () => {
    elapsed.textContent = formatElapsed(recording);
  };

  refresh();
  elapsedTimer = setInterval(refresh, 1000);
}

function setError(message = "") {
  const node = document.getElementById("errorMessage");
  node.textContent = message;
  node.classList.toggle("hidden", !message);
}

function renderRecordingState(recording) {
  const status = document.getElementById("status");
  const button = document.getElementById("recordButton");
  const pauseButton = document.getElementById("pauseButton");
  const videoStatus = document.getElementById("videoStatus");
  const audioStatus = document.getElementById("audioStatus");
  const localPlayback = document.getElementById("localPlayback");
  const details = document.getElementById("captureDetails");
  const captureTitle = document.getElementById("captureTitle");
  const captureHint = document.getElementById("captureHint");
  const elapsedTime = document.getElementById("elapsedTime");

  const capturing = recording?.status === "capturing";
  const paused = recording?.status === "paused";
  const errored = recording?.status === "error";
  const active = capturing || paused;
  currentRecording = recording || null;

  status.textContent = capturing ? "Capturing" : paused ? "Paused" : errored ? "Error" : "Idle";
  status.classList.toggle("recording", capturing);
  status.classList.toggle("paused", paused);
  status.classList.toggle("errored", errored);

  button.textContent = active || errored ? "Stop tab capture" : "Start tab capture";
  button.dataset.action = active || errored ? "stop" : "start";

  pauseButton.classList.toggle("hidden", !active);
  pauseButton.textContent = paused ? "Resume" : "Pause";
  pauseButton.dataset.action = paused ? "resume" : "pause";

  videoStatus.textContent = active ? "Active" : errored ? "Error" : "Ready";
  audioStatus.textContent = active
    ? (recording.audio?.available ? "Active" : "Unavailable")
    : errored ? "Error" : "Ready";

  if (active) {
    localPlayback.checked = Boolean(recording.localPlaybackEnabled);
    localPlayback.disabled = false;
  } else {
    localPlayback.checked = activeSource?.type !== "teams";
    localPlayback.disabled = false;
  }

  details.classList.toggle("hidden", !active && !errored);

  if (active || errored) {
    captureTitle.textContent = recording.title || "Untitled tab";
    if (errored) {
      stopElapsedTimer();
      elapsedTime.textContent = formatElapsed(recording);
    } else {
      startElapsedTimer(recording);
    }
    const sourceHint =
      recording.tabId === activeTab?.id
        ? "This tab is the active capture source."
        : "Capture continues from the original tab while you work here.";

    const audioHint = recording.audio?.available
      ? " Tab audio is being captured; microphone is not requested." +
        (recording.localPlaybackEnabled
          ? " Speaker playback is on."
          : " Speaker playback is muted while recording continues.")
      : " No tab audio track is currently available.";

    const stateHint = paused
      ? " Recording is paused."
      : errored
        ? ` ${recording.error || "Recording encountered an error."}`
        : "";

    captureHint.textContent = sourceHint + audioHint + stateHint;
  } else {
    stopElapsedTimer();
    elapsedTime.textContent = "00:00:00";
    captureTitle.textContent = "";
    captureHint.textContent = "";
  }
}

async function getState() {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_GET_STATE"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to read TabVault state.");
  }

  return response.state;
}

async function startCapture() {
  if (!activeTab?.id) {
    throw new Error("No active tab is available to capture.");
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_START_CAPTURE",
    tabId: activeTab.id,
    title: activeTab.title,
    url: activeTab.url,
    sourceType: activeSource.type,
    localPlaybackEnabled: document.getElementById("localPlayback").checked
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to start tab capture.");
  }

  renderRecordingState(response.recording);
}

async function stopCapture() {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_STOP_CAPTURE"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to stop tab capture.");
  }

  renderRecordingState(null);

  if (response.recording?.saved) {
    setError(`Saved ${response.recording.filename}`);
  }
}

async function setPaused(paused) {
  if (!currentRecording) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_SET_PAUSED",
    paused
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to change pause state.");
  }

  renderRecordingState(response.recording);
}

async function setLocalPlayback(enabled) {
  if (!currentRecording) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_SET_LOCAL_PLAYBACK",
    enabled
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to change speaker playback.");
  }

  renderRecordingState(response.recording);
}

async function init() {
  const sourceType = document.getElementById("sourceType");
  const pageTitle = document.getElementById("pageTitle");
  const pageUrl = document.getElementById("pageUrl");
  const recordButton = document.getElementById("recordButton");
  const pauseButton = document.getElementById("pauseButton");
  const localPlayback = document.getElementById("localPlayback");

  [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeSource = classifySource(activeTab?.url);

  sourceType.textContent = activeSource.label;
  sourceType.dataset.sourceType = activeSource.type;
  pageTitle.textContent = activeTab?.title || "Untitled tab";
  pageUrl.textContent = activeTab?.url || "URL unavailable";

  const state = await getState();
  renderRecordingState(state.recording);

  pauseButton.addEventListener("click", async () => {
    if (!currentRecording) {
      return;
    }

    setError("");
    pauseButton.disabled = true;

    try {
      await setPaused(pauseButton.dataset.action === "pause");
    } catch (error) {
      setError(error.message);
    } finally {
      pauseButton.disabled = false;
    }
  });

  localPlayback.addEventListener("change", async () => {
    if (!currentRecording) {
      return;
    }

    setError("");
    localPlayback.disabled = true;

    try {
      await setLocalPlayback(localPlayback.checked);
    } catch (error) {
      localPlayback.checked = !localPlayback.checked;
      setError(error.message);
    } finally {
      localPlayback.disabled = false;
    }
  });

  recordButton.addEventListener("click", async () => {
    setError("");
    recordButton.disabled = true;

    try {
      if (recordButton.dataset.action === "stop") {
        await stopCapture();
      } else {
        await startCapture();
      }
    } catch (error) {
      setError(error.message);
    } finally {
      recordButton.disabled = false;
    }
  });
}

init().catch((error) => {
  document.getElementById("sourceType").textContent = "Unable to inspect tab";
  document.getElementById("pageTitle").textContent = error.message;
  document.getElementById("recordButton").disabled = true;
  setError(error.message);
});


window.addEventListener("unload", stopElapsedTimer);
