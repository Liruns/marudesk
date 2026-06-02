# toy-prj

`toy-prj` is a three-package workspace for **marudesk**, a desktop-first AI
developer tool with a companion mobile client and a relay service.

## Workspace Map

| Path | Role | Primary surface |
|---|---|---|
| `marudesk/` | Electron desktop app | Browser stage, DevTools, agent chat, patch review, local workspace integration |
| `mobile/` | Capacitor thin client | Phone UI for sending commands and rendering PC-owned agent state |
| `relay/` | Node TypeScript relay | Auth plus same-account host/client WebSocket brokering |

The desktop app owns the model/tool/workspace loop. The mobile app never runs
the model or tools; it talks through the relay to a PC host signed into the same
account.

## Quick start

There is no root package.json and no root package command. Install and run
checks per package:

```bash
cd marudesk
npm install

cd ../mobile
npm install

cd ../relay
npm install
```

Run the desktop app:

```bash
cd marudesk
npm run dev
```

Run the relay locally:

```bash
cd relay
npm start
```

Run the mobile web/PWA client:

```bash
cd mobile
npm run dev
```

The relay defaults to port `8788`. For local development, the mobile client can
use its stub transport without a relay/PC host, or point at the relay when bridge
work is being tested.

## Verification

Run the checks that match the package you touched:

```bash
cd marudesk
npm run typecheck
npm run build
npm run e2e

cd ../mobile
npm run typecheck
npm run build
npm run smoke

cd ../relay
npm run typecheck
npm test
```

Agent sessions should prefix shell commands with `rtk`; see `AGENTS.md` for the
project workflow and command rules.

## Documentation

- Root agent guidance: `AGENTS.md`
- Claude-compatible guidance pointer: `CLAUDE.md`
- Desktop app docs: `marudesk/README.md`
- Mobile client docs: `mobile/README.md`
- Relay docs: `relay/README.md`
- Desktop design system: `marudesk/DESIGN.md`
- Product roadmap and architecture notes: `marudesk/docs/`

Update the root README when the workspace shape, setup commands, or verification
workflow changes. Update package READMEs when package-specific behavior changes.
