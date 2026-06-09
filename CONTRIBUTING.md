# Contributing to MaruDesk

MaruDesk is an active desktop-app project. Contributions are welcome when they
keep the app focused on runtime-aware AI development: browser evidence,
DevTools, editor/terminal workflows, provider integration, and the mobile relay.

## Before you start

- Check existing issues and pull requests for related work.
- Keep changes scoped to the package that owns the behavior:
  - `marudesk/` for the Electron desktop app.
  - `mobile/` for the Capacitor thin client.
  - `relay/` for the relay and auth service.
- Read `AGENTS.md` and, for UI work, `marudesk/DESIGN.md`.
- Do not include API keys, OAuth tokens, session data, screenshots with secrets,
  or local workspace paths that should stay private.

## Development setup

Install and run each package from its own directory.

```bash
cd marudesk
npm install
npm run dev
```

Optional companion packages:

```bash
cd mobile && npm install && npm run dev
cd relay && npm install && npm start
```

## Verification

Run the checks that match your change. For desktop changes, prefer:

```bash
cd marudesk
npm run typecheck
npm run build
npm run e2e
```

For targeted main-process or protocol work, use the package harnesses documented
in `README.md` and `marudesk/README.md`.

## Pull requests

- Explain the user-visible behavior or bug being changed.
- Include the verification commands you ran and the result.
- Attach screenshots or short clips for visible UI changes.
- Call out known limitations, follow-up work, or risky assumptions.
- Keep unrelated refactors and generated files out of the PR.

## Project boundaries

- TypeScript stays strict. Avoid broad casts, `any`, and suppression comments.
- Keep shared contracts in `marudesk/shared/*` transport-safe.
- The mobile client is a thin client; it should not run model, tool, or
  workspace logic locally.
- Do not add UI colors outside the design token files called out in
  `marudesk/DESIGN.md`.
