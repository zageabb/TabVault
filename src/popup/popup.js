function decodeSharePointTitle(parsed, fallbackTitle = "") {
  const candidates = [];

  for (const key of ["id", "file"]) {
    const value = parsed.searchParams.get(key);
    if (!value) continue;
    try {
      candidates.push(decodeURIComponent(value));
    } catch {
      candidates.push(value);
    }
  }

  candidates.push(parsed.pathname);

  for (const candidate of candidates) {
    const filename = String(candidate || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop();

    if (!filename) continue;

    const decoded = filename
      .replace(/%([0-9A-Fa-f]{2})/g, (match) => {
        try {
          return decodeURIComponent(match);
        } catch {
          return match;
        }
      })
      .replace(/\.mp4$/i, "")
      .replace(/[-_]?Meeting Recording$/i, "")
      .replace(/[-_]?\d{8}_\d{6}$/i, "")
      .replace(/%20/g, " ")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (decoded && decoded.toLowerCase() !== "stream.aspx") {
      return decoded;
    }
  }

  return fallbackTitle || "SharePoint recording";
}

function classifySource(url = "", pageTitle = "") {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return {
      type: "generic",
      label: "Generic tab",
      title: pageTitle || "Untitled tab",
      mode: "Generic tab recording",
      hint: "Records only this browser tab and its tab audio."
    };
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
    return {
      type: "teams",
      label: "Microsoft Teams",
      title: pageTitle || "Microsoft Teams",
      mode: "Teams companion recording",
      hint: "Designed for a passive browser meeting while you interact through Teams desktop."
    };
  }

  const isSharePointHost =
    host.endsWith(".sharepoint.com") ||
    host.endsWith(".sharepoint-df.com");
  const isStreamPage =
    path.includes("/_layouts/15/stream.aspx") ||
    path.includes("/stream.aspx");
  const looksLikeRecording =
    /\/recordings?\//i.test(parsed.pathname) ||
    /meeting[%20 _-]*recording/i.test(url);

  if (isSharePointHost || isStreamPage || looksLikeRecording) {
    return {
      type: "sharepoint",
      label: "SharePoint / Stream",
      title: decodeSharePointTitle(parsed, pageTitle),
      mode: isStreamPage ? "SharePoint recording playback" : "SharePoint media",
      hint: "Optimised for recording SharePoint/Stream playback locally."
    };
  }

  return {
    type: "generic",
    label: "Generic tab",
    title: pageTitle || "Untitled tab",
    mode: "Generic tab recording",
    hint: "Records only this browser tab and its tab audio."
  };
}

const MAX_CONCURRENT_RECORDINGS = 3;

let activeTab = null;
let activeSource = null;
let recordings = [];
let currentRecording = null;
let elapsedTimer = null;

function setError(message = "") {
  const node = document.getElementById("errorMessage");
  node.textContent = message;
  node.classList.toggle("hidden", !message);
}

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

function startElapsedTimer() {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    if (currentRecording) {
      document.getElementById("elapsedTime").textContent = formatElapsed(currentRecording);
    }

    document.querySelectorAll("[data-session-elapsed]").forEach((node) => {
      const recording = recordings.find(
        (item) => item.sessionId === node.dataset.sessionElapsed
      );
      if (recording) {
        node.textContent = formatElapsed(recording);
      }
    });
  }, 1000);
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function formatDurationMs(durationMs) {
  if (durationMs === null || durationMs === undefined) {
    return "Unknown duration";
  }

  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function getState() {
  const response = await chrome.runtime.sendMessage({ type: "TABVAULT_GET_STATE" });
  if (!response?.ok) {
    throw new Error(response?.error || "Unable to read TabVault state.");
  }
  return response.state;
}

function renderTeamsControlState(node, control) {
  if (!control?.detected) {
    node.textContent = "Check manually";
    return;
  }
  node.textContent = control.off ? "Off" : "On";
}

async function refreshTeamsCompanionState() {
  if (activeSource?.type !== "teams" || !activeTab?.id) return;

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_GET_TEAMS_STATE",
    tabId: activeTab.id
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to inspect Teams controls.");
  }

  renderTeamsControlState(
    document.getElementById("teamsMicState"),
    response.state?.microphone
  );
  renderTeamsControlState(
    document.getElementById("teamsCameraState"),
    response.state?.camera
  );
}

function renderHistory(history = []) {
  const card = document.getElementById("historyCard");
  const list = document.getElementById("historyList");
  const entries = Array.isArray(history) ? history.slice(0, 10) : [];

  list.textContent = "";
  card.classList.toggle("hidden", entries.length === 0);

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "history-item";

    const title = document.createElement("strong");
    title.textContent = entry.title || "Untitled recording";

    const meta = document.createElement("div");
    meta.className = "footnote";
    meta.textContent = [
      formatDate(entry.endedAt || entry.startedAt),
      formatDurationMs(entry.durationMs),
      entry.result === "recovered" ? "Recovered" : "Saved",
      entry.filename || ""
    ].filter(Boolean).join(" · ");

    item.append(title, meta);
    list.append(item);
  }
}

async function listRecoverableSessions() {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_LIST_RECOVERABLE"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to inspect recoverable recordings.");
  }

  return response.sessions || [];
}

async function refreshRecoveryPanel() {
  const card = document.getElementById("recoveryCard");
  const list = document.getElementById("recoveryList");
  const sessions = await listRecoverableSessions();

  list.textContent = "";
  card.classList.toggle("hidden", sessions.length === 0);

  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "recovery-item";

    const title = document.createElement("strong");
    title.textContent = session.title || "Interrupted recording";

    const meta = document.createElement("div");
    meta.className = "footnote";
    meta.textContent = [
      formatDate(session.startedAt),
      `${Number(session.chunkCount || 0)} chunks`,
      formatBytes(session.bytesPersisted)
    ].filter(Boolean).join(" · ");

    const actions = document.createElement("div");
    actions.className = "recovery-actions";

    const recoverButton = document.createElement("button");
    recoverButton.type = "button";
    recoverButton.className = "secondary";
    recoverButton.textContent = "Recover";

    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "secondary";
    discardButton.textContent = "Discard";

    recoverButton.addEventListener("click", async () => {
      setError("");
      recoverButton.disabled = true;
      discardButton.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TABVAULT_RECOVER_SESSION",
          sessionId: session.sessionId
        });
        if (!response?.ok) {
          throw new Error(response?.error || "Unable to recover recording.");
        }
        setError(`Recovered ${response.recording?.filename || "recording"}`);
        await refreshRecoveryPanel();
        const state = await getState();
        renderHistory(state.history);
      } catch (error) {
        setError(error.message);
      } finally {
        recoverButton.disabled = false;
        discardButton.disabled = false;
      }
    });

    discardButton.addEventListener("click", async () => {
      if (!window.confirm(
        "Discard this recoverable recording? This permanently removes its saved chunks."
      )) {
        return;
      }

      setError("");
      recoverButton.disabled = true;
      discardButton.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TABVAULT_DISCARD_RECOVERY",
          sessionId: session.sessionId
        });
        if (!response?.ok) {
          throw new Error(response?.error || "Unable to discard recording.");
        }
        await refreshRecoveryPanel();
      } catch (error) {
        setError(error.message);
      } finally {
        recoverButton.disabled = false;
        discardButton.disabled = false;
      }
    });

    actions.append(recoverButton, discardButton);
    item.append(title, meta, actions);
    list.append(item);
  }
}

async function setPaused(sessionId, paused) {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_SET_PAUSED",
    sessionId,
    paused
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to change pause state.");
  }

  return response.recording;
}

async function setLocalPlayback(sessionId, enabled) {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_SET_LOCAL_PLAYBACK",
    sessionId,
    enabled
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to change speaker playback.");
  }

  return response.recording;
}

async function stopCapture(sessionId) {
  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_STOP_CAPTURE",
    sessionId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to stop tab capture.");
  }

  if (response.recording?.saved) {
    setError(`Saved ${response.recording.filename}`);
  }

  return response.recording;
}

async function openRecordingTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
}

function renderActiveRecordings() {
  const card = document.getElementById("activeRecordingsCard");
  const list = document.getElementById("activeRecordingsList");
  const count = document.getElementById("activeRecordingCount");

  list.textContent = "";
  count.textContent = `${recordings.length} / ${MAX_CONCURRENT_RECORDINGS}`;
  card.classList.toggle("hidden", recordings.length === 0);

  for (const recording of recordings) {
    const item = document.createElement("div");
    item.className = "active-recording-item";

    const title = document.createElement("div");
    title.className = "active-recording-title";
    title.textContent = recording.title || "Untitled tab";

    const meta = document.createElement("div");
    meta.className = "footnote active-recording-meta";

    const elapsed = document.createElement("span");
    elapsed.dataset.sessionElapsed = recording.sessionId;
    elapsed.textContent = formatElapsed(recording);

    const state = document.createElement("span");
    const captureLabel = recording.captureMode === "display" ? "window/screen" : recording.sourceType;
    state.textContent = ` · ${recording.status} · ${captureLabel}`;

    meta.append(elapsed, state);

    const speakerRow = document.createElement("label");
    speakerRow.className = "active-recording-speaker";
    const speakerLabel = document.createElement("span");
    speakerLabel.textContent = "Play through speakers";
    const speakerToggle = document.createElement("input");
    speakerToggle.type = "checkbox";
    speakerToggle.checked = Boolean(recording.localPlaybackEnabled);

    speakerToggle.addEventListener("change", async () => {
      speakerToggle.disabled = true;
      try {
        await setLocalPlayback(recording.sessionId, speakerToggle.checked);
        await refreshState();
      } catch (error) {
        speakerToggle.checked = !speakerToggle.checked;
        setError(error.message);
      } finally {
        speakerToggle.disabled = false;
      }
    });

    speakerRow.append(speakerLabel, speakerToggle);

    const actions = document.createElement("div");
    actions.className = "active-recording-actions";

    const openButton = document.createElement("button");
    openButton.className = "secondary";
    openButton.type = "button";
    openButton.textContent = "Open tab";
    openButton.addEventListener("click", () => {
      openRecordingTab(recording.tabId).catch((error) => setError(error.message));
    });

    const pauseButton = document.createElement("button");
    pauseButton.className = "secondary";
    pauseButton.type = "button";
    pauseButton.textContent = recording.status === "paused" ? "Resume" : "Pause";
    pauseButton.disabled = recording.status === "error";
    pauseButton.addEventListener("click", async () => {
      pauseButton.disabled = true;
      try {
        await setPaused(recording.sessionId, recording.status !== "paused");
        await refreshState();
      } catch (error) {
        setError(error.message);
      } finally {
        pauseButton.disabled = false;
      }
    });

    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.textContent = "Stop";
    stopButton.addEventListener("click", async () => {
      stopButton.disabled = true;
      try {
        await stopCapture(recording.sessionId);
        await refreshState();
      } catch (error) {
        setError(error.message);
      } finally {
        stopButton.disabled = false;
      }
    });

    actions.append(openButton, pauseButton, stopButton);
    item.append(title, meta, speakerRow, actions);
    list.append(item);
  }
}

function renderCurrentTabState() {
  const status = document.getElementById("status");
  const recordButton = document.getElementById("recordButton");
  const pauseButton = document.getElementById("pauseButton");
  const videoStatus = document.getElementById("videoStatus");
  const audioStatus = document.getElementById("audioStatus");
  const localPlayback = document.getElementById("localPlayback");
  const qualityProfile = document.getElementById("qualityProfile");
  const captureMode = document.getElementById("captureMode");
  const captureModeRow = document.getElementById("captureModeRow");
  const captureModeHint = document.getElementById("captureModeHint");
  const details = document.getElementById("captureDetails");
  const elapsed = document.getElementById("elapsedTime");
  const captureTitle = document.getElementById("captureTitle");
  const captureHint = document.getElementById("captureHint");
  const sharePointOptions = document.getElementById("sharePointOptions");
  const teamsCompanion = document.getElementById("teamsCompanion");
  const teamsSpeakerState = document.getElementById("teamsSpeakerState");

  currentRecording =
    recordings.find((recording) => recording.tabId === activeTab?.id) || null;

  status.textContent = recordings.length
    ? `${recordings.length} active`
    : "Idle";

  const active = Boolean(currentRecording);
  const paused = currentRecording?.status === "paused";
  const errored = currentRecording?.status === "error";
  const genericSource = activeSource?.type === "generic";

  captureModeRow.classList.toggle("hidden", !genericSource);
  captureModeHint.classList.toggle("hidden", !genericSource || captureMode.value !== "display");

  recordButton.textContent = active
    ? (currentRecording.captureMode === "display" ? "Stop window / screen" : "Stop this tab")
    : (genericSource && captureMode.value === "display" ? "Start window / screen" : "Start this tab");
  recordButton.dataset.action = active ? "stop" : "start";
  recordButton.disabled = !active && recordings.length >= MAX_CONCURRENT_RECORDINGS;

  pauseButton.classList.toggle("hidden", !active || errored);
  pauseButton.textContent = paused ? "Resume" : "Pause";
  pauseButton.dataset.action = paused ? "resume" : "pause";

  videoStatus.textContent = active
    ? (errored ? "Error" : "Active")
    : "Ready";
  audioStatus.textContent = active
    ? (currentRecording.audio?.available ? "Active" : "Unavailable")
    : "Ready";

  if (active) {
    localPlayback.checked = Boolean(currentRecording.localPlaybackEnabled);
    qualityProfile.value = currentRecording.qualityProfile || "standard";
    qualityProfile.disabled = true;
    captureMode.value = currentRecording.captureMode || "tab";
    captureMode.disabled = true;
  } else {
    localPlayback.checked = activeSource?.type !== "teams";
    qualityProfile.disabled = false;
    captureMode.disabled = !genericSource;
  }

  localPlayback.disabled = false;

  sharePointOptions.classList.toggle("hidden", activeSource?.type !== "sharepoint");
  teamsCompanion.classList.toggle("hidden", activeSource?.type !== "teams");

  if (activeSource?.type === "teams") {
    teamsSpeakerState.textContent = localPlayback.checked ? "On" : "Muted";
  }

  details.classList.toggle("hidden", !active);

  if (active) {
    captureTitle.textContent = currentRecording.title || "Untitled tab";
    elapsed.textContent = formatElapsed(currentRecording);

    const stateHint = paused
      ? " Recording is paused."
      : errored
        ? ` ${currentRecording.error || "Recording encountered an error."}`
        : "";

    const sourceHint = currentRecording.captureMode === "display"
      ? "Window / Screen capture is active. "
      : "This tab is one active capture source. ";

    captureHint.textContent =
      sourceHint +
      (currentRecording.audio?.available
        ? "Audio is being captured."
        : currentRecording.captureMode === "display"
          ? "The selected surface did not provide an audio track."
          : "No tab audio track is currently available.") +
      stateHint;
  } else {
    captureTitle.textContent = "";
    elapsed.textContent = "00:00:00";
    captureHint.textContent = "";
  }

  renderActiveRecordings();
  startElapsedTimer();
}

async function refreshState() {
  const state = await getState();
  recordings = Array.isArray(state.recordings)
    ? state.recordings
    : state.recording
      ? [state.recording]
      : [];

  renderCurrentTabState();
  renderHistory(state.history);
}

function chooseDesktopSourceFromPopup() {
  return new Promise((resolve, reject) => {
    try {
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
    } catch (error) {
      reject(error);
    }
  });
}

async function startCapture() {
  if (!activeTab?.id) {
    throw new Error("No active tab is available to capture.");
  }

  const captureMode = activeSource.type === "generic"
    ? document.getElementById("captureMode").value
    : "tab";

  let desktopSelection = null;

  if (captureMode === "display") {
    desktopSelection = await chooseDesktopSourceFromPopup();
  }

  const response = await chrome.runtime.sendMessage({
    type: "TABVAULT_START_CAPTURE",
    tabId: activeTab.id,
    title: activeSource.title || activeTab.title,
    url: activeTab.url,
    sourceType: activeSource.type,
    captureMode,
    desktopStreamId: desktopSelection?.streamId || null,
    canRequestAudioTrack: desktopSelection?.canRequestAudioTrack || false,
    qualityProfile: document.getElementById("qualityProfile").value,
    destinationFolder: document.getElementById("destinationFolder").value,
    filenameTemplate: document.getElementById("filenameTemplate").value,
    localPlaybackEnabled: document.getElementById("localPlayback").checked,
    autoStopOnEnded: document.getElementById("autoStopOnEnded")?.checked ?? false,
    followPlayback: document.getElementById("followPlayback")?.checked ?? false
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unable to start tab capture.");
  }

  await refreshState();
}

async function init() {
  const sourceType = document.getElementById("sourceType");
  const pageTitle = document.getElementById("pageTitle");
  const pageUrl = document.getElementById("pageUrl");
  const sourceMode = document.getElementById("sourceMode");
  const sourceHint = document.getElementById("sourceHint");
  const recordButton = document.getElementById("recordButton");
  const pauseButton = document.getElementById("pauseButton");
  const localPlayback = document.getElementById("localPlayback");
  const captureMode = document.getElementById("captureMode");
  const captureModeRow = document.getElementById("captureModeRow");
  const captureModeHint = document.getElementById("captureModeHint");
  const destinationFolder = document.getElementById("destinationFolder");
  const filenameTemplate = document.getElementById("filenameTemplate");
  const clearHistoryButton = document.getElementById("clearHistoryButton");

  [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeSource = classifySource(activeTab?.url, activeTab?.title);

  sourceType.textContent = activeSource.label;
  sourceType.dataset.sourceType = activeSource.type;
  sourceMode.textContent = activeSource.mode || "";
  sourceMode.classList.toggle("hidden", !activeSource.mode);
  pageTitle.textContent = activeSource.title || activeTab?.title || "Untitled tab";
  pageUrl.textContent = activeTab?.url || "URL unavailable";
  sourceHint.textContent = activeSource.hint || "";
  sourceHint.classList.toggle("hidden", !activeSource.hint);

  const genericSource = activeSource.type === "generic";
  captureModeRow.classList.toggle("hidden", !genericSource);
  captureMode.disabled = !genericSource;
  captureModeHint.classList.toggle("hidden", true);

  const state = await getState();
  destinationFolder.value = state.settings?.destinationFolder || "TabVault";
  filenameTemplate.value = state.settings?.filenameTemplate || "{title} - {date}";
  recordings = Array.isArray(state.recordings)
    ? state.recordings
    : state.recording
      ? [state.recording]
      : [];

  renderCurrentTabState();
  renderHistory(state.history);

  try {
    await refreshRecoveryPanel();
  } catch (error) {
    setError(error.message);
  }

  if (activeSource.type === "teams") {
    try {
      await refreshTeamsCompanionState();
    } catch {
      document.getElementById("teamsMicState").textContent = "Check manually";
      document.getElementById("teamsCameraState").textContent = "Check manually";
    }
  }

  const saveSettings = async () => {
    const response = await chrome.runtime.sendMessage({
      type: "TABVAULT_SAVE_SETTINGS",
      destinationFolder: destinationFolder.value,
      filenameTemplate: filenameTemplate.value
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to save settings.");
    }
  };

  destinationFolder.addEventListener("change", () => {
    saveSettings().catch((error) => setError(error.message));
  });

  filenameTemplate.addEventListener("change", () => {
    saveSettings().catch((error) => setError(error.message));
  });

  clearHistoryButton.addEventListener("click", async () => {
    if (!window.confirm(
      "Clear TabVault recording history? This removes metadata only, not downloaded videos."
    )) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "TABVAULT_CLEAR_HISTORY"
    });

    if (!response?.ok) {
      setError(response?.error || "Unable to clear recording history.");
      return;
    }

    renderHistory([]);
  });

  recordButton.addEventListener("click", async () => {
    setError("");
    recordButton.disabled = true;

    try {
      if (currentRecording) {
        await stopCapture(currentRecording.sessionId);
        await refreshState();
      } else {
        await startCapture();
      }
    } catch (error) {
      setError(error.message);
    } finally {
      renderCurrentTabState();
    }
  });

  pauseButton.addEventListener("click", async () => {
    if (!currentRecording) return;

    pauseButton.disabled = true;
    try {
      await setPaused(
        currentRecording.sessionId,
        currentRecording.status !== "paused"
      );
      await refreshState();
    } catch (error) {
      setError(error.message);
    } finally {
      pauseButton.disabled = false;
    }
  });

  captureMode.addEventListener("change", () => {
    captureModeHint.classList.toggle(
      "hidden",
      activeSource.type !== "generic" || captureMode.value !== "display"
    );
    renderCurrentTabState();
  });

  localPlayback.addEventListener("change", async () => {
    if (!currentRecording) return;

    localPlayback.disabled = true;
    try {
      await setLocalPlayback(currentRecording.sessionId, localPlayback.checked);
      await refreshState();
    } catch (error) {
      localPlayback.checked = !localPlayback.checked;
      setError(error.message);
    } finally {
      localPlayback.disabled = false;
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
