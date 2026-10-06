# TabVault Development

## Objective

Create a Chrome/Chromium extension capable of recording a specific browser tab and its audio to local storage while the user continues working elsewhere.

Primary supported use cases:

1. SharePoint / Microsoft Stream recording playback.
2. Microsoft Teams browser meetings.
3. Generic browser-tab recording.

## Product Modes

### SharePoint / Stream
- Detect SharePoint Stream playback pages.
- Capture tab video and playback audio.
- No microphone required by default.
- Optionally auto-stop when playback ends.
- Derive a useful filename from the page title.

### Teams Live Meeting
- Detect Teams browser meetings.
- Support a passive browser recording client.
- The user may interact through Teams desktop independently.
- Capture incoming meeting audio and rendered meeting video.
- Browser microphone and camera should remain off for companion mode.

### Generic Tab
- Capture the currently selected browser tab and tab audio.
- Save locally.

## Architecture Principles

- Chrome Manifest V3.
- Local-first; no TabVault cloud service.
- Minimal permissions.
- No Microsoft Graph dependency.
- Do not circumvent source access controls.
- Use Chrome-supported capture APIs.
- Prefer an offscreen recording document so recording survives popup closure.
- Long recordings must use chunked persistence rather than one large in-memory Blob.
- Recovery of interrupted recordings is a target capability.

## Development Order

### DEV-001 — Extension shell
**Status:** Implemented — browser runtime verification pending

Acceptance criteria:
- Manifest V3 extension loads successfully.
- Popup opens and identifies the active tab.
- Service worker is registered.
- Basic source type is shown as Teams, SharePoint/Stream, or Generic.
- No broad host permissions are required just to load the extension.

Evidence:
- `manifest.json` defines a Manifest V3 extension with popup and module service worker.
- Popup identifies the active tab and classifies Teams, SharePoint/Stream, or Generic sources.
- Service worker initializes local extension state.
- Initial implementation committed to `main` on 2026-10-06.
- Runtime loading in Chrome remains to be verified before marking complete.

### DEV-002 — Tab capture
**Status:** Not started

Acceptance criteria:
- Start capture from the popup.
- Capture only the selected tab.
- Capture continues after popup closes.
- Switching to other tabs/windows does not change the selected capture source.

### DEV-003 — Audio capture
**Status:** Not started

Acceptance criteria:
- Capture tab audio together with video when available.
- SharePoint playback audio is present in the resulting file.
- Teams incoming audio is present in companion mode.
- No microphone is requested by default.

### DEV-004 — Local WebM recording
**Status:** Not started

Acceptance criteria:
- Record using MediaRecorder.
- Prefer VP9 + Opus when supported, fall back safely.
- Stop and save locally through browser downloads.
- Generate a safe filename from source metadata.

### DEV-005 — Recording status
**Status:** Not started

Acceptance criteria:
- Toolbar badge indicates idle / recording / paused / error.
- Popup shows elapsed duration.
- Stop control remains available after reopening popup.

### DEV-006 — SharePoint detection
**Status:** Not started

Acceptance criteria:
- Detect common SharePoint / Stream playback URLs.
- Extract useful meeting title where available.
- Present SharePoint-specific recording mode in UI.

### DEV-007 — SharePoint playback lifecycle
**Status:** Not started

Acceptance criteria:
- Detect playback start/end where technically available.
- Optional auto-start on playback.
- Optional auto-stop when source playback ends.

### DEV-008 — Teams detection
**Status:** Not started

Acceptance criteria:
- Detect Teams browser meeting pages.
- Present Teams-specific mode in UI.
- Do not request microphone/camera merely to record the tab.

### DEV-009 — Companion Recording Mode
**Status:** Not started

Acceptance criteria:
- Explain the recommended dual-client workflow.
- Provide checks for browser mic muted and camera off where detectable.
- Capture browser meeting tab independently from Teams desktop interaction.
- Evaluate whether tab audio can be captured while local playback is suppressed without disrupting recording.

### DEV-010 — Chunked persistence
**Status:** Not started

Acceptance criteria:
- Recording is emitted in bounded chunks.
- A long recording does not accumulate entirely in JS memory.
- Chunk storage strategy is documented and tested.

### DEV-011 — Interrupted recording recovery
**Status:** Not started

Acceptance criteria:
- Detect unfinished recording state.
- Recover all safely persisted chunks after extension/browser restart where possible.
- Never silently discard recoverable recording data.

### DEV-012 — Recording history
**Status:** Not started

Acceptance criteria:
- Keep metadata only: title, time, duration, result, filename.
- Do not duplicate video data in extension history.

### DEV-013 — Quality profiles
**Status:** Not started

Acceptance criteria:
- Standard and High presets.
- Sensible bitrate defaults.
- Source resolution preserved where practical.

### DEV-014 — Destination and naming
**Status:** Not started

Acceptance criteria:
- Default save path under Downloads/TabVault where browser policy allows.
- Configurable filename template.
- Sanitize illegal filename characters.

## Later Ideas

- Recording markers/bookmarks.
- Keyboard shortcuts.
- Optional microphone mix.
- MP4 output where browser support permits.
- Local transcription integration.
- Scheduled/automatic recording.
- Meeting-end detection.
- Screenshots and notes tied to timestamps.

## Validation Policy

For every development item:

1. Implement the smallest coherent change.
2. Add or update automated tests where meaningful.
3. Run local validation.
4. Update this file with evidence.
5. Run CI.
6. Resolve failures before progressing.

Do not mark an item complete based only on UI appearance or an agent statement; verify behaviour from source/tests/runtime evidence.
