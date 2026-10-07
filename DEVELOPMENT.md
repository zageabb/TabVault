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
**Status:** Complete

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
- Runtime loading in Chrome verified on 2026-10-06.
- Initial runtime test exposed the current Teams host `teams.cloud.microsoft`, which was misclassified as Generic; detection was updated to support `teams.cloud.microsoft` (plus existing `teams.microsoft.com` and `teams.live.com`).
- User runtime revalidation confirmed Teams detection and popup behaviour working on 2026-10-06.
- DEV-001 complete.

### DEV-002 — Tab capture
**Status:** Complete

Acceptance criteria:
- Start capture from the popup.
- Capture only the selected tab.
- Capture continues after popup closes.
- Switching to other tabs/windows does not change the selected capture source.

Evidence:
- `manifest.json` now requests `tabCapture` and `offscreen` and requires Chrome 116+.
- The popup starts/stops capture and records the selected `tabId`.
- The service worker obtains a media stream ID for that exact `targetTabId`.
- `src/recorder/recorder.html` and `recorder.js` consume the stream in an offscreen document, so the capture lifecycle is independent of the popup.
- Capture state is stored in `chrome.storage.local`, allowing the popup to reopen and show the active source.
- Stop/error lifecycle handling clears capture state.
- User runtime verification passed on 2026-10-06: capture remained bound to the original tab after popup closure and while switching elsewhere.
- DEV-002 complete.

### DEV-003 — Audio capture
**Status:** Complete

Acceptance criteria:
- Capture tab audio together with video when available.
- SharePoint playback audio is present in the resulting file.
- Teams incoming audio is present in companion mode.
- No microphone is requested by default.

Evidence:
- Offscreen capture now requests the selected tab's audio and video from the same Chrome tab-capture stream.
- No microphone constraints or microphone permission are requested.
- Audio track availability, sample rate, and channel count are returned to the service worker and stored with active capture state.
- Popup shows tab-audio state as Ready / Active / Unavailable.
- Local audio passthrough is restored with Web Audio while capture is active so ordinary playback remains audible; companion-mode suppression can be added later under DEV-009.
- User runtime verification on 2026-10-06 confirmed the active tab audio track and audible playback path work.
- Local speaker playback is now independently switchable without removing audio from the captured stream; Teams defaults to muted local playback while SharePoint/generic tabs default to audible playback.
- User runtime verification on 2026-10-06 confirmed saved WebM audio remains present even when local speaker playback is muted.
- DEV-003 complete.

### DEV-004 — Local WebM recording
**Status:** Complete

Acceptance criteria:
- Record using MediaRecorder.
- Prefer VP9 + Opus when supported, fall back safely.
- Stop and save locally through browser downloads.
- Generate a safe filename from source metadata.

Evidence:
- The offscreen recorder now starts a MediaRecorder with the captured tab stream.
- Codec preference order is VP9 + Opus, VP8 + Opus, then browser WebM fallback.
- Recorder emits 5-second chunks and finalizes them to a WebM when capture stops.
- A browser download is triggered from the offscreen document.
- Filenames are sanitized and include the source title plus capture date.
- User runtime verification on 2026-10-06 confirmed WebM download, video, audio, filename generation, and muted-speaker capture behaviour.
- DEV-004 complete.

### DEV-005 — Recording status
**Status:** Complete

Acceptance criteria:
- Toolbar badge indicates idle / recording / paused / error.
- Popup shows elapsed duration.
- Stop control remains available after reopening popup.

Evidence:
- Toolbar badge displays REC while capture is active and clears on stop.
- Toolbar title reflects the active recording source.
- Popup calculates elapsed duration from persisted startedAt state.
- Existing persisted state keeps Stop available after reopening the popup.
- Pause/resume is now implemented in the offscreen MediaRecorder and exposed in the popup.
- Toolbar badges now show `REC`, `II`, or `!` for recording, paused, and error states.
- Elapsed time excludes paused duration.
- User runtime verification on 2026-10-06 confirmed pause/resume, `REC`/`II` badge transitions, elapsed-time behaviour, and saved output behaviour.
- DEV-005 complete.

### DEV-006 — SharePoint detection
**Status:** Complete

Acceptance criteria:
- Detect common SharePoint / Stream playback URLs.
- Extract useful meeting title where available.
- Present SharePoint-specific recording mode in UI.

Evidence:
- Source classification now recognises SharePoint hosts, Stream player URLs, Recordings paths, and meeting-recording URL patterns.
- SharePoint Stream id/file parameters are decoded to derive a cleaner recording title.
- Common recording suffixes such as .mp4, Meeting Recording, and timestamp suffixes are removed from the display/save title.
- Popup now shows a source-specific mode badge and SharePoint-specific guidance.
- The cleaned SharePoint title is passed into the recording pipeline, improving saved WebM filenames.
- User runtime verification on 2026-10-06 confirmed SharePoint/Stream classification, mode display, and clean recording-title extraction.
- DEV-006 complete.

### DEV-007 — SharePoint playback lifecycle
**Status:** Complete

Acceptance criteria:
- Detect playback start/end where technically available.
- Optional auto-start on playback.
- Optional auto-stop when source playback ends.

Evidence:
- Added a SharePoint playback observer injected only into the selected tab when a SharePoint capture starts.
- The observer tracks the largest video element and reports play, playing, pause, ended, metadata, and current state events.
- "Stop when video ends" is available in the popup and defaults on for SharePoint.
- "Follow video play/pause" is available as an armed mode: the user initiates TabVault once, then recording pauses/resumes with SharePoint playback.
- If follow-playback is enabled while the source video is initially paused, MediaRecorder is paused until playback begins.
- Lifecycle observation is best-effort and recording continues normally if the page structure prevents video inspection.
- User runtime verification on 2026-10-06 confirmed follow-playback pause/resume and automatic stop/save at video end.
- A later extension-reload regression exposed stale SharePoint content scripts raising `Extension context invalidated`; the observer now tears itself down cleanly when its extension context is invalidated.
- User runtime verification on 2026-10-07 confirmed the invalidated content-script error no longer recurs after reload/refresh.
- DEV-007 complete.

### DEV-008 — Teams detection
**Status:** Complete

Acceptance criteria:
- Detect Teams browser meeting pages.
- Present Teams-specific mode in UI.
- Do not request microphone/camera merely to record the tab.

Evidence:
- Teams detection supports teams.cloud.microsoft, teams.microsoft.com, and teams.live.com.
- Popup presents the dedicated "Teams companion recording" mode and Teams-specific guidance.
- TabVault capture requests only the selected tab media stream; no browser microphone/camera media permission is requested.
- Teams detection was runtime verified earlier on 2026-10-06 when teams.cloud.microsoft was corrected and re-tested.
- DEV-008 complete.

### DEV-009 — Companion Recording Mode
**Status:** Complete

Acceptance criteria:
- Explain the recommended dual-client workflow.
- Provide checks for browser mic muted and camera off where detectable.
- Capture browser meeting tab independently from Teams desktop interaction.
- Evaluate whether tab audio can be captured while local playback is suppressed without disrupting recording.

Evidence:
- Teams popup now explains the recommended dual-client workflow: Teams desktop for interaction, browser meeting as the passive TabVault source.
- A passive Teams inspector checks visible meeting controls for microphone/camera state without changing either control.
- If Teams UI state cannot be identified reliably, TabVault shows "Check manually" rather than guessing.
- Teams local speaker playback defaults muted while the captured tab audio track remains in the recording stream.
- Prior runtime verification already confirmed muted local speaker output does not remove captured audio.
- User runtime verification on 2026-10-06 confirmed the Teams companion panel and mic/camera readiness display behave correctly.
- DEV-009 complete.

### DEV-010 — Chunked persistence
**Status:** Complete

Acceptance criteria:
- Recording is emitted in bounded chunks.
- A long recording does not accumulate entirely in JS memory.
- Chunk storage strategy is documented and tested.

Evidence:
- MediaRecorder continues to emit bounded 5-second chunks.
- Each chunk is written immediately to IndexedDB in the offscreen recorder instead of being retained in an in-memory array.
- IndexedDB uses separate sessions and chunks stores; chunks are keyed by session ID plus sequential index.
- Per-session metadata tracks chunk count, persisted bytes, MIME type, and timestamps.
- Chunk writes are serialized so finalization waits for every pending IndexedDB write before assembling the WebM.
- Only finalization loads persisted chunks to create the downloadable Blob; recording duration no longer causes an ever-growing JavaScript chunk array.
- Persisted chunks are deleted after a successful or intentionally discarded finalization.
- The storage shape is intentionally compatible with DEV-011 interrupted-recording recovery.
- User runtime verification on 2026-10-06 confirmed normal recording, pause/resume, speaker mute, saved WebM, and SharePoint auto-stop still work with IndexedDB persistence.
- DEV-010 complete.

### DEV-011 — Interrupted recording recovery
**Status:** Complete

Acceptance criteria:
- Detect unfinished recording state.
- Recover all safely persisted chunks after extension/browser restart where possible.
- Never silently discard recoverable recording data.

Evidence:
- Popup queries the offscreen IndexedDB store for unfinished sessions and shows a Recoverable recordings card when persisted chunks exist.
- Each recoverable session displays title, start time, chunk count, and persisted size.
- Recover reconstructs a WebM from the safely persisted chunks, downloads it, and only then removes that session from IndexedDB.
- Recoverable data remains stored if recovery fails.
- Discard is explicit and requires user confirmation; TabVault never silently deletes unfinished-session chunks.
- Browser startup clears only the stale live-capture state, not IndexedDB recovery data.
- The recovery storage model supports multiple unfinished sessions independently, which also prepares for DEV-015.
- User runtime verification on 2026-10-06 confirmed an intentionally interrupted recording is detected and recovered to a playable WebM.
- DEV-011 complete.

### DEV-012 — Recording history
**Status:** Complete

Acceptance criteria:
- Keep metadata only: title, time, duration, result, filename.
- Do not duplicate video data in extension history.

Evidence:
- Recording completion now appends metadata-only entries to chrome.storage.local.
- Stored fields include title, source type, start/end time, effective duration, result, filename, size, and whether the item was recovered.
- Successful recovery also writes a history entry.
- History is capped at the 50 most recent entries.
- Popup shows the 10 most recent recordings with timestamp, duration, saved/recovered result, and filename.
- History does not store video blobs or duplicate IndexedDB recording chunks.
- A Clear action removes only history metadata and explicitly states that downloaded videos are unaffected.
- User runtime verification on 2026-10-07 confirmed completed recordings appear correctly in Recent recordings with the expected metadata.
- DEV-012 complete.

### DEV-013 — Quality profiles
**Status:** Complete

Acceptance criteria:
- Standard and High presets.
- Sensible bitrate defaults.
- Source resolution preserved where practical.

Evidence:
- Popup now offers Standard and High quality presets before a recording starts.
- Standard requests 4 Mbps video and 128 kbps audio.
- High requests 8 Mbps video and 192 kbps audio.
- The selected preset is passed through the service worker into MediaRecorder options.
- Chrome's actual MediaRecorder bitrates are returned in active recorder metadata where exposed by the browser.
- The selected quality profile is locked while a recording is active so bitrate does not change mid-session.
- Tab capture resolution constraints are unchanged, preserving the source tab resolution/frame rate where Chrome provides it.
- User runtime verification on 2026-10-07 confirmed both Standard and High profiles produce valid recordings and High produces the expected larger output.
- DEV-013 complete.

### DEV-014 — Destination and naming
**Status:** Complete

Acceptance criteria:
- Default save path under Downloads/TabVault where browser policy allows.
- Configurable filename template.
- Sanitize illegal filename characters.

Evidence:
- Added the Chrome downloads permission and switched finalized/recovered files to chrome.downloads.download.
- Default destination is Downloads/TabVault.
- Popup exposes a persistent Downloads folder field and filename-template field.
- Supported filename tokens are {title}, {date}, {time}, and {source}.
- Default template is "{title} - {date}".
- Filename and folder segments are sanitized for illegal path characters and traversal-like segments are removed.
- Browser download conflict handling uses "uniquify" to avoid silently overwriting an existing file.
- Destination/template settings are persisted in chrome.storage.local and are also stored with interrupted sessions so recovery uses the original naming configuration.
- User runtime verification on 2026-10-07 confirmed subfolder placement and filename-template expansion work as expected.
- DEV-014 complete.


### DEV-015 — Parallel recording sessions
**Status:** Implemented — browser runtime verification pending

**Rationale / sequencing:**
- Add only after the single-session recording pipeline, chunk persistence, recovery, history, quality, and destination handling are stable.
- Parallel capture multiplies encoder, memory, storage, and failure-recovery load, so it should build on DEV-010 through DEV-014 rather than interrupt current SharePoint/Teams work.
- Existing single-tab behaviour must remain the baseline and must not regress.

**Acceptance criteria:**
- Support more than one independently captured browser tab at the same time.
- Each recording has its own session ID, source tab ID, source metadata, start time, elapsed time, recorder state, audio-playback preference, chunk stream, filename, and result.
- Starting a second recording does not stop, replace, retarget, or corrupt an existing recording.
- Each session can be paused, resumed, stopped, or opened independently.
- Closing/reopening the popup preserves and displays all active sessions.
- The toolbar/popup clearly indicates the number of active recordings and any paused/error sessions.
- Local speaker playback/muting remains configurable per recording without removing audio from the recorded stream.
- Persist chunks independently so one failed/stopped session cannot discard data belonging to another session.
- Interrupted-recording recovery can identify and recover multiple unfinished sessions independently.
- Recording history records each completed session separately.
- Enforce a configurable safe concurrency limit; initial default target is 3 simultaneous recordings, subject to runtime performance validation.
- When the configured limit is reached, refuse additional capture cleanly and explain why rather than disrupting active recordings.
- Validate parallel recording with at least two simultaneous tabs, including independent stop order and successful playable output from both.
- Performance validation should record CPU/memory/storage behaviour for two and three concurrent 1080p-class sources where practical.

**Implementation evidence:**
- Service-worker state now stores an independent recordings array and migrates legacy single-recording state when read.
- Each capture receives a unique session ID before the tab stream is opened.
- The offscreen recorder now maintains a Map of independent session objects, each with its own MediaStream, MediaRecorder, audio passthrough context, chunk-write chain, persisted session metadata, and stop/pause state.
- Starting one session no longer stops or replaces another session.
- Pause, resume, stop, and local-speaker playback messages are addressed by session ID.
- Popup now includes an Active recordings panel with independent Open tab, Pause/Resume, Stop, and speaker-playback controls for every session.
- The current tab retains simple Start/Stop/Pause controls while other sessions continue in the background.
- Toolbar badge shows REC for one capture, II for one paused capture, a numeric count for multiple captures, and ! if any active session reports an error.
- Duplicate capture of the same tab is rejected cleanly.
- A hard concurrency limit of 3 active recordings is enforced before any existing recording is disturbed.
- IndexedDB chunks remain isolated by session ID; recoverable-session listing filters out sessions that are still live.
- SharePoint playback events are routed back to the matching session by sender tab ID.
- Recording history continues to be written independently for each completed session.
- Browser runtime validation with two and three simultaneous tabs, independent stop order, and playable output is pending.


### DEV-016 — Window / screen capture mode
**Status:** Not started

**Rationale / sequencing:**
- Generic tab capture can miss transient browser/native compositor UI such as native select dropdowns, context menus, date pickers, and some browser-level overlays.
- Keep isolated tab capture as the preferred mode for Teams and SharePoint.
- Add a higher-level window/screen capture option for software demonstrations where transient UI must appear in the recording.
- Implement after the current reliability/storage sequence so it can reuse persistence, recovery, history, quality, and destination services.

**Acceptance criteria:**
- Generic recording mode offers a clear choice between Tab capture and Window / Screen capture.
- Tab remains the default and preserves today's isolated-tab behaviour.
- Window / Screen mode uses a Chrome-supported display-capture picker and never selects a screen/window silently.
- Native dropdowns and similar compositor UI are visible in a validated Window / Screen recording where the OS/browser exposes them.
- Audio behaviour and availability are reported clearly because system/window audio support differs by platform and selected surface.
- Window / Screen recording uses the same chunk persistence, recovery, history, quality, and naming pipeline as tab recording.
- Teams and SharePoint continue to recommend Tab capture unless the user explicitly chooses otherwise.
- Runtime validation includes the reported generic-app dropdown case.

## Later Ideas

- Recording markers/bookmarks.
- Keyboard shortcuts.
- Optional microphone mix.
- MP4 output where browser support permits.
- Local transcription integration.
- Scheduled/automatic recording.
- Meeting-end detection.
- Screenshots and notes tied to timestamps.

## CI

- GitHub Actions CI added on 2026-10-06.
- CI validates `manifest.json` and syntax-checks all JavaScript with Node 22.

## Validation Policy

For every development item:

1. Implement the smallest coherent change.
2. Add or update automated tests where meaningful.
3. Run local validation.
4. Update this file with evidence.
5. Run CI.
6. Resolve failures before progressing.

Do not mark an item complete based only on UI appearance or an agent statement; verify behaviour from source/tests/runtime evidence.
