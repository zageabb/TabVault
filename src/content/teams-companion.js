(() => {
  if (globalThis.__tabVaultTeamsInspectorInstalled) {
    return;
  }

  globalThis.__tabVaultTeamsInspectorInstalled = true;

  function normalize(value) {
    return String(value || "").toLowerCase();
  }

  function inspectControl(kind) {
    const buttons = [...document.querySelectorAll("button")];

    for (const button of buttons) {
      const text = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.textContent
      ].map(normalize).join(" ");

      if (!text.includes(kind)) {
        continue;
      }

      const pressed = button.getAttribute("aria-pressed");
      const disabled = button.disabled || button.getAttribute("aria-disabled") === "true";

      if (kind === "microphone") {
        if (text.includes("unmute") || text.includes("turn on microphone")) {
          return { detected: true, off: true, disabled, label: button.getAttribute("aria-label") || button.title || "" };
        }
        if (text.includes("mute") || text.includes("turn off microphone")) {
          return { detected: true, off: false, disabled, label: button.getAttribute("aria-label") || button.title || "" };
        }
      }

      if (kind === "camera") {
        if (text.includes("turn on camera") || text.includes("start camera")) {
          return { detected: true, off: true, disabled, label: button.getAttribute("aria-label") || button.title || "" };
        }
        if (text.includes("turn off camera") || text.includes("stop camera")) {
          return { detected: true, off: false, disabled, label: button.getAttribute("aria-label") || button.title || "" };
        }
      }

      if (pressed === "false") {
        return { detected: true, off: true, disabled, label: button.getAttribute("aria-label") || button.title || "" };
      }

      if (pressed === "true") {
        return { detected: true, off: false, disabled, label: button.getAttribute("aria-label") || button.title || "" };
      }
    }

    return { detected: false, off: null, disabled: false, label: "" };
  }

  function inspect() {
    return {
      microphone: inspectControl("microphone"),
      camera: inspectControl("camera")
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TABVAULT_GET_TEAMS_STATE") {
      return false;
    }

    sendResponse({ ok: true, state: inspect() });
    return false;
  });
})();
