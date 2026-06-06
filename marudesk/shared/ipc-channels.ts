/**
 * Invoke-channel whitelist, grouped by domain. Adding a domain adds one entry
 * here; ipc.ts derives the flat `INVOKE_CHANNELS` whitelist and the
 * `InvokeChannel` union from `typeof CHANNELS`.
 */
export const CHANNELS = {
  browser: [
    'browser:navigate',
    'browser:set-bounds',
    'browser:set-pane-bounds',
    'browser:clear-pane-bounds',
    'browser:set-inspect-mode',
    'browser:set-visible',
    'browser:go-back',
    'browser:go-forward',
    'browser:reload',
    'browser:stop',
    'browser:find',
    'browser:stop-find',
    'browser:zoom',
    'browser:set-audio-muted',
    'browser:capture-page',
    'browser:downloads-list',
    'browser:download-action',
    'browser:downloads-clear',
    'browser:tabs-new',
    'browser:tabs-replace',
    'browser:tabs-close',
    'browser:tabs-reopen',
    'browser:tabs-activate',
    'browser:tabs-snapshot',
    'browser:tabs-reorder',
    'browser:tabs-set-pinned',
    'browser:tabs-bind-path',
    'browser:popup-menu',
  ],
  devtools: [
    'devtools:open',
    'devtools:close',
    'devtools:open-chrome',
    'devtools:cdp-send',
    'devtools:set-dock-bounds',
    'devtools:popout-open',
    'devtools:popout-close',
    'devtools:pull-errors',
  ],
  workspace: [
    'workspace:open',
    'workspace:list',
    'workspace:rank',
    'workspace:read-file',
    'workspace:read-media',
    'workspace:write-file',
    'workspace:save-as',
    'workspace:create',
    'workspace:rename',
    'workspace:delete',
    'workspace:move',
    'workspace:copy',
    'workspace:reveal',
  ],
  workspaces: [
    'workspaces:list',
    'workspaces:create',
    'workspaces:add-root',
    'workspaces:remove-root',
    'workspaces:rename',
    'workspaces:delete',
    'workspaces:set-active',
    'workspaces:set-active-root',
    'workspaces:reindex',
    'workspaces:read-file',
    'workspaces:write-file',
    'workspaces:save-as',
    'workspaces:rank',
    'workspaces:add-ssh-root',
  ],
  // Remote SSH connections (electron/ssh/*). Manage configured hosts and probe
  // them; credentials cross inbound only and never come back to the renderer.
  ssh: [
    'ssh:list-connections',
    'ssh:add-connection',
    'ssh:remove-connection',
    'ssh:test-connection',
    'ssh:list-dir',
  ],
  history: ['history:query', 'history:recent'],
  // Workspace diagnostics (docs/workspace-language-support-design.md, Tier 1).
  // `run` triggers the project's own checker (tsc/eslint/…) and parses its output;
  // `get` is the pull for initial render. Results also push on diagnostics:update.
  diagnostics: ['diagnostics:run', 'diagnostics:get', 'diagnostics:open-config'],
  // Workspace Source Control (electron/git.ts). All run against the open
  // workspace root via execFile git (argv arrays, never a shell). `status`
  // returns isRepo:false cleanly when the folder isn't a repo; discards are
  // destructive and the renderer confirms before calling.
  git: [
    'git:available',
    'git:status',
    'git:init',
    'git:stage',
    'git:stageAll',
    'git:unstage',
    'git:discard',
    'git:diff',
    'git:commit',
    'git:branches',
    'git:checkout',
    'git:createBranch',
    'git:log',
    'git:fetch',
    'git:pull',
    'git:push',
  ],
  // Workspace content search (electron/search.ts). Prefers ripgrep, falls back
  // to a Node walk reusing the workspace IGNORE_DIRS + binary/size skips.
  search: ['search:content'],
  patch: ['patch:preview', 'patch:apply'],
  secrets: [
    'secrets:list-providers',
    'secrets:set-provider-key',
    'secrets:clear-provider-key',
  ],
  providers: [
    'providers:list-models',
    'providers:test-connection',
    'providers:list-custom',
    'providers:add-custom',
    'providers:remove-custom',
  ],
  auth: [
    'auth:oauth-start',
    'auth:oauth-complete',
    'auth:oauth-cancel',
    'auth:oauth-disconnect',
  ],
  agent: [
    'agent:send',
    'agent:abort',
    'agent:respond',
    'agent:approve-tool',
    'agent:accept-edit',
    'agent:revert-edit',
    'agent:snapshot',
    'agent:reset',
    'agent:compact',
    'agent:list-sessions',
    'agent:search-sessions',
    'agent:resume-session',
    'agent:delete-session',
  ],
  // Local data store management — Settings → Data & Storage reads stats, clears
  // saved sessions, and reveals the data folder (docs/data-storage-design).
  storage: ['storage:stats', 'storage:clear-sessions', 'storage:reveal'],
  // The renderer mirrors surfaces main can't observe (unsaved editor buffers, the
  // explorer tree state) to the built-in context MCP — see context-mcp-design §3.
  context: ['context:sync'],
  // External (stdio) MCP connectors — Settings → MCP Servers lists/reloads/toggles
  // user-configured servers (docs/remote-mobile-bridge-design §M3).
  mcp: [
    'mcp:list-servers',
    'mcp:reload',
    'mcp:set-enabled',
    'mcp:add-preset',
    'mcp:open-config',
  ],
  // User plugins running in isolated workers — Settings → Plugins lists/reloads/
  // toggles them, and the composer reads the slash commands they contribute
  // (docs/plugin-runtime-design.md §5, §7 P2).
  plugins: [
    'plugins:list',
    'plugins:reload',
    'plugins:set-enabled',
    'plugins:commands',
    'plugins:open-folder',
  ],
  settings: ['settings:get', 'settings:set', 'settings:reset'],
  // Cloud relay (Bridge Model B §B2): log the PC's cloud account in/out and read
  // the sanitized status (logged-in account + connected-as-host). Tokens never
  // cross IPC — only `{account|null, connected}` does. Auto-connect is driven by
  // settings.server.cloudEnabled + login state in electron/server/relay.ts.
  relay: ['relay:login', 'relay:logout', 'relay:status'],
  // LAN/Tailscale bridge status + device pairing (T2 — docs/remote-mobile-bridge-design
  // §3, docs/t2-secure-pairing-design.md). The Settings → Remote panel reads the
  // running flag + reachable URLs, starts a pairing (QR), approves/rejects an
  // incoming pairing, and lists/revokes paired devices. Never the token or any key.
  server: [
    'server:status',
    'server:pairing-start',
    'server:pairing-approve',
    'server:pairing-reject',
    'server:list-devices',
    'server:revoke-device',
  ],
  terminal: [
    'terminal:create',
    'terminal:input',
    'terminal:resize',
    'terminal:dispose',
    'terminal:ready',
  ],
  clipboard: ['clipboard:write-text', 'clipboard:read-text'],
  app: [
    'app:info',
    'app:open-github',
    'app:open-releases',
    'app:check-for-updates',
  ],
  window: [
    'window:minimize',
    'window:maximize-toggle',
    'window:close',
    'window:is-maximized',
  ],
} as const;
