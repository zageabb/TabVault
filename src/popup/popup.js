function decodeSharePointTitle(parsed, fallbackTitle = "") {
  const candidates = [];

  const id = parsed.searchParams.get("id");
  if (id) {
    try {
      candidates.push(decodeURIComponent(id));
    } catch {
      candidates.push(id);
    }
  }

  const file = parsed.searchParams.get("file");
  if (file) {
    try {
      candidates.push(decodeURIComponent(file));
    } catch {
      candidates.push(file);
    }
  }

  candidates.push(parsed.pathname);

  for (const candidate of candidates) {
    const normalized = String(candidate || "").replace(/\\/g, "/");
    const filename = normalized.split("/").filter(Boolean).pop();

    if (!filename) {
      continue;
    }

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

function renderTeamsControlState(node, control) {
  if (!node) {
    return;
  }

  if (!control?.detected) {
    node.textContent = "Check manually";
    return;
  }

  node.textContent = control.off ? "Off" : "On";
}

async function refreshTeamsCompanionState() {
  if (activeSource?.type !== "teams" || !activeTab?.id) {
    return;
  }

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

function renderRecordingState(recording) {
  const status = document.getElementById("status");
  const button = document.getElementById("recordButton");
  const pauseButton = document.getElementById("pauseButton");
  const videoStatus = document.getElementById("videoStatus");
  const audioStatus = document.getElementById("audioStatus");
  const localPlayback = document.getElementById("localPlayback");
  const qualityProfile = document.getElementById("qualityProfile");
  const sharePointOptions = document.getElementById("sharePointOptions");
  const teamsCompanion = document.getElementById("teamsCompanion");
  const teamsSpeakerState = document.getElementById("teamsSpeakerState");
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
    qualityProfile.value = recording.qualityProfile || "standard";
    qualityProfile.disabled = true;
  } else {
    localPlayback.checked = activeSource?.type !== "teams";
    localPlayback.disabled = false;
    qualityProfile.disabled = false;
  }

  sharePointOptions.classList.toggle("hidden", activeSource?.type !== "sharepoint");
  teamsCompanion.classList.toggle("hidden", activeSource?.type !== "teams");

  if (activeSource?.type === "teams") {
    const speakerMuted = active
      ? !Boolean(recording.localPlaybackEnabled)
      : !Boolean(localPlayback.checked);
    teamsSpeakerState.textContent = speakerMuted ? "Muted" : "On";
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

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRecoveryDate(timestamp) {
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

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
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
      formatRecoveryDate(entry.endedAt || entry.startedAt),
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
      formatRecoveryDate(session.startedAt),
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
      } catch (error) {
        setError(error.message);
      } finally {
        recoverButton.disabled = false;
        discardButton.disabled = false;
      }
    });

    discardButton.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Discard this recoverable recording? This permanently removes its saved chunks."
      );

      if (!confirmed) {
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
    title: activeSource.title || activeTab.title,
    url: activeTab.url,
    sourceType: activeSource.type,
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
  const qualityProfile = document.getElementById("qualityProfile");
  const destinationFolder = document.getElementById("destinationFolder");
  const filenameTemplate = document.getElementById("filenameTemplate");
  const clearHistoryButton = document.getElementById("clearHistoryButton");

  [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeSource = classifySource(activeTab?.url, activeTab?.title);

  const sourceMode = document.getElementById("sourceMode");
  const sourceHint = document.getElementById("sourceHint");

  sourceType.textContent = activeSource.label;
  sourceType.dataset.sourceType = activeSource.type;

  sourceMode.textContent = activeSource.mode || "";
  sourceMode.classList.toggle("hidden", !activeSource.mode);

  pageTitle.textContent = activeSource.title || activeTab?.title || "Untitled tab";
  pageUrl.textContent = activeTab?.url || "URL unavailable";

  sourceHint.textContent = activeSource.hint || "";
  sourceHint.classList.toggle("hidden", !activeSource.hint);

  const state = await getState();
  destinationFolder.value = state.settings?.destinationFolder || "TabVault";
  filenameTemplate.value = state.settings?.filenameTemplate || "{title} - {date}";
  renderRecordingState(state.recording);
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

  destinationFolder.addEventListener("change", async () => {
    try {
      await saveSettings();
    } catch (error) {
      setError(error.message);
    }
  });

  filenameTemplate.addEventListener("change", async () => {
    try {
      await saveSettings();
    } catch (error) {
      setError(error.message);
    }
  });

  clearHistoryButton.addEventListener("click", async () => {
    const confirmed = window.confirm("Clear TabVault recording history? This removes metadata only, not downloaded videos.");

    if (!confirmed) {
      return;
    }

    setError("");
    clearHistoryButton.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "TABVAULT_CLEAR_HISTORY"
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Unable to clear recording history.");
      }

      renderHistory([]);
    } catch (error) {
      setError(error.message);
    } finally {
      clearHistoryButton.disabled = false;
    }
  });

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
