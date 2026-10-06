# TabVault

TabVault is a local-first Chrome/Chromium extension for recording a specific browser tab, including its audio, while the user continues working in other tabs, windows, or desktop applications.

Primary use cases:

- Record SharePoint / Microsoft Stream playback.
- Record a live Microsoft Teams meeting in a dedicated browser tab.
- Use Teams desktop independently for microphone, camera, chat, screen sharing, and normal meeting interaction.
- Record any compatible browser tab in generic mode.

## Principles

- Local-first: TabVault does not upload recordings.
- Minimal browser permissions.
- No dependency on Microsoft Graph.
- No attempt to bypass access controls.
- Long recordings must not rely entirely on RAM.
- Recording should remain independent from the user's normal desktop work.

See [DEVELOPMENT.md](DEVELOPMENT.md) for the implementation roadmap and [AGENTS.md](AGENTS.md) for autonomous development rules.
