# AGENTS.md

## Primary Objective

Implement `DEVELOPMENT.md` in priority order.

## Required Workflow

Before coding:

1. Read `DEVELOPMENT.md`.
2. Inspect the existing implementation.
3. Verify current behaviour from source and tests.
4. Work on the highest-priority incomplete objective.

Continue autonomously until one of these happens:

1. the current objective is complete and verified;
2. a genuinely ambiguous product decision is required;
3. progress is blocked by something outside the repository;
4. continuing would risk destructive changes.

Do not stop simply because one implementation step has completed.

## Validation

For each development item:

- implement;
- test locally;
- add/update automated tests where appropriate;
- update `DEVELOPMENT.md` with evidence;
- run CI;
- resolve failures before proceeding.

Completion requires evidence. Do not trust a displayed status without verifying the source of truth.

## Architecture Rules

- Chrome Manifest V3.
- Local-first.
- Minimal permissions.
- No remote recording service.
- No Microsoft Graph dependency.
- Do not circumvent access controls or protected-content restrictions.
- Use documented Chrome capture APIs.
- Keep recording logic independent from popup lifetime.
- Design for multi-hour recordings.
- Avoid retaining an entire long recording in RAM.
- Treat recovery of interrupted recordings as a first-class requirement.

## Product Rules

- SharePoint playback mode should require no microphone by default.
- Teams Companion Recording Mode assumes normal interaction occurs in Teams desktop while Chrome is the passive recording source.
- Generic tab recording must remain available.
- Do not silently change meeting microphone, camera, or user interaction settings.
- Never upload a recording without an explicit future product decision and user action.

## Repository Hygiene

- Keep changes scoped to the current DEVELOPMENT.md objective.
- Prefer small coherent commits.
- Update documentation alongside behaviour changes.
- Do not commit generated recordings, browser profiles, credentials, cookies, or secrets.
