# Repository Guidance And README Plan

## TL;DR
> Summary:      Create and reconcile root `README.md`, `AGENTS.md`, and `CLAUDE.md`; replace stale package README content; and add a docs smoke check so future agents can verify guidance without guessing.
> Deliverables:
> - Root `README.md` with workspace map, quick start, verification matrix, and documentation ownership.
> - Root `AGENTS.md` with repo-scoped agent instructions, RTK command rule, package boundaries, and verification expectations.
> - Root `CLAUDE.md` that imports or mirrors `AGENTS.md` without forking project rules.
> - Package README cleanup for `marudesk/`, `mobile/`, and `relay/`.
> - `scripts/verify-docs.mjs` docs smoke check with evidence output from every task.
> Effort:       Short
> Risk:         Medium - Concurrent untracked documentation drafts already exist, so executors must reconcile rather than overwrite.

## Scope
### Must have
- Root `README.md`, `AGENTS.md`, and `CLAUDE.md` committed at repository root.
- Root README must describe the three package surfaces: `marudesk/`, `mobile/`, and `relay/`.
- Root README must make clear there is no root package command and that installs/checks run per package.
- Root `AGENTS.md` must include the RTK command prefix rule, package ownership boundaries, and package-specific verification commands.
- Root `CLAUDE.md` must be Claude-compatible and keep `AGENTS.md` as the source of truth, preferably with `@AGENTS.md` import syntax because Anthropic documents that Claude Code reads `CLAUDE.md` and can import `AGENTS.md`.
- `marudesk/README.md` must no longer contain the stock Vite template and must document the desktop app, stack, commands, design rules, and related packages.
- `mobile/README.md` and `relay/README.md` must remain project-specific, readable as UTF-8, and aligned with root docs.
- A local docs smoke check must verify the required content and stale-template exclusions.
- All task evidence must be captured under `evidence/`.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- Do not change application behavior or product source files outside documentation and the docs verification script.
- Do not add a root `package.json`, npm workspace, monorepo tool, or new runtime dependency.
- Do not add Android/JDK setup automation or run app packaging for this docs-only request.
- Do not make `CLAUDE.md` a divergent duplicate of `AGENTS.md`.
- Do not delete or rewrite concurrent untracked user/agent drafts without first reading and reconciling them.
- Do not add personal local instructions such as `CLAUDE.local.md`; `.gitignore` already excludes `.claude/`.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + Node docs smoke script and git whitespace checks
- QA policy: every task has agent-executed scenarios
- Evidence: `evidence/task-<N>-<slug>.<ext>`

## Execution strategy
### Parallel execution waves
> Target 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks to maximize parallelism.

Wave 1 (no dependencies):
- Task 1: Root README workspace overview
- Task 2: Root AGENTS.md repository instructions
- Task 3: Root CLAUDE.md compatibility instructions
- Task 4: marudesk README replacement
- Task 5: Initial docs smoke script

Wave 2 (after Wave 1):
- Task 6: mobile README consistency polish depends [1, 2]
- Task 7: relay README consistency polish depends [1, 2]
- Task 8: Expand docs smoke coverage depends [1, 2, 3, 4, 5]

Critical path: Task 2 -> Task 8

### Dependency matrix
| Task | Depends on | Blocks | Can parallelize with |
|------|------------|--------|----------------------|
| 1    | none       | 6, 7, 8 | 2, 3, 4, 5 |
| 2    | none       | 6, 7, 8 | 1, 3, 4, 5 |
| 3    | none       | 8 | 1, 2, 4, 5 |
| 4    | none       | 8 | 1, 2, 3, 5 |
| 5    | none       | 8 | 1, 2, 3, 4 |
| 6    | 1, 2       | F1-F4 | 7, 8 |
| 7    | 1, 2       | F1-F4 | 6, 8 |
| 8    | 1, 2, 3, 4, 5 | F1-F4 | 6, 7 |

## Todos
> Implementation + Test = ONE task. Never separate.
> Every task MUST have: References + Acceptance Criteria + QA Scenarios + Commit.

- [ ] 1. Root README workspace overview

  What to do: Create or reconcile root `README.md`. Preserve any current draft content that is accurate. Document `toy-prj` as a three-package workspace, include a table for `marudesk/`, `mobile/`, and `relay/`, explain that the desktop app owns model/tool/workspace state, add per-package install/run snippets, add a verification matrix, and link to root/package docs.
  Must NOT do: Do not imply that root-level `npm install`, `npm run dev`, or `npm test` exists. Do not duplicate package README details beyond quick-start and routing.

  Parallelization: Can parallel: YES | Wave 1 | Blocks: [6, 7, 8] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `README.md:1` - A current untracked root README may already exist; reconcile it instead of overwriting.
  - Pattern:  `README.md:6` - Existing draft workspace map shape.
  - Pattern:  `README.md:18` - Existing draft quick-start flow.
  - Pattern:  `README.md:58` - Existing draft verification matrix.
  - Pattern:  `README.md:81` - Existing draft documentation index.
  - API/Type: `marudesk/package.json:7` - Desktop scripts to cite exactly.
  - API/Type: `mobile/package.json:7` - Mobile scripts to cite exactly.
  - API/Type: `relay/package.json:8` - Relay scripts to cite exactly.
  - Test:     `scripts/verify-docs.mjs:25` - Existing/draft root README smoke check.
  - External: `https://developers.openai.com/codex/guides/agents-md` - OpenAI guidance supports project-level instruction docs for repository context.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('README.md','utf8'); const required=['# toy-prj','marudesk/','mobile/','relay/','Quick start','Verification','AGENTS.md','CLAUDE.md']; const missing=required.filter(x=>!t.includes(x)); if(missing.length){console.error(missing); process.exit(1);}"`
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('README.md','utf8'); if(fs.existsSync('package.json')) throw new Error('unexpected root package.json'); if(!/per package/i.test(t)) throw new Error('README must say commands run per package');"`

  QA scenarios (MANDATORY - task incomplete without these):
  > Name the exact tool AND its exact invocation - not "verify it works". Browser use: use Chrome to drive the page; if Chrome is not available, download and use agent-browser (https://github.com/vercel-labs/agent-browser). Computer use: OS-level GUI automation for a non-browser desktop app.
  ```
  Scenario: root README has workspace overview
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); fs.mkdirSync('evidence',{recursive:true}); const t=fs.readFileSync('README.md','utf8'); const required=['# toy-prj','Workspace Map','marudesk/','mobile/','relay/','Quick start','Verification']; const missing=required.filter(x=>!t.includes(x)); fs.writeFileSync('evidence/task-1-root-readme.json', JSON.stringify({missing},null,2)); if(missing.length) process.exit(1);"
    Expected: command exits 0 and evidence JSON has an empty missing array
    Evidence: evidence/task-1-root-readme.json

  Scenario: root README does not invent root npm workflow
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); const t=fs.readFileSync('README.md','utf8'); const result={rootPackageExists:fs.existsSync('package.json'), saysPerPackage:/per package/i.test(t)}; fs.writeFileSync('evidence/task-1-root-readme-error.json', JSON.stringify(result,null,2)); if(result.rootPackageExists || !result.saysPerPackage) process.exit(1);"
    Expected: command exits 0, `rootPackageExists` is false, and `saysPerPackage` is true
    Evidence: evidence/task-1-root-readme-error.json
  ```

  Commit: YES | Message: `docs(readme): document workspace overview` | Files: [README.md]

- [ ] 2. Root AGENTS.md repository instructions

  What to do: Create or reconcile root `AGENTS.md` as the repository-scoped operating guide for AI agents. Include workspace map, default workflow, RTK command rule, package commands, engineering boundaries, and documentation maintenance policy.
  Must NOT do: Do not paste generic global agent philosophy. Do not contradict the RTK rule from the workspace instructions. Do not put personal secrets or machine-local paths in the committed file.

  Parallelization: Can parallel: YES | Wave 1 | Blocks: [3, 6, 7, 8] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `AGENTS.md:1` - Current untracked AGENTS draft title.
  - Pattern:  `AGENTS.md:6` - Existing workspace map structure.
  - Pattern:  `AGENTS.md:17` - Existing workflow guidance.
  - Pattern:  `AGENTS.md:27` - Existing RTK command rule.
  - Pattern:  `AGENTS.md:46` - Existing package command matrix.
  - Pattern:  `AGENTS.md:86` - Existing engineering and documentation rules.
  - API/Type: `marudesk/package.json:8` - Desktop dev command.
  - API/Type: `marudesk/package.json:15` - Desktop typecheck command.
  - API/Type: `mobile/package.json:11` - Mobile typecheck command.
  - API/Type: `mobile/package.json:12` - Mobile smoke command.
  - API/Type: `relay/package.json:9` - Relay start command.
  - API/Type: `relay/package.json:10` - Relay typecheck command.
  - Test:     `scripts/verify-docs.mjs:10` - Root guidance smoke check.
  - External: `https://developers.openai.com/codex/guides/agents-md` - Codex reads `AGENTS.md` before work, layers global/project guidance, and verifies loaded instructions.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('AGENTS.md','utf8'); const required=['toy-prj','Workspace Map','RTK','marudesk','mobile','relay','npm run typecheck','npm test','Documentation']; const missing=required.filter(x=>!t.includes(x)); if(missing.length){console.error(missing); process.exit(1);}"`
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('AGENTS.md','utf8'); if(!t.includes('Run commands from the package directory')) throw new Error('package-directory command rule missing');"`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: AGENTS.md contains actionable repo guidance
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); fs.mkdirSync('evidence',{recursive:true}); const t=fs.readFileSync('AGENTS.md','utf8'); const required=['Workspace Map','RTK Command Rule','Package Commands','Engineering Rules','Documentation']; const missing=required.filter(x=>!t.includes(x)); fs.writeFileSync('evidence/task-2-agents.json', JSON.stringify({missing},null,2)); if(missing.length) process.exit(1);"
    Expected: command exits 0 and evidence JSON has an empty missing array
    Evidence: evidence/task-2-agents.json

  Scenario: AGENTS.md preserves package command boundaries
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); const t=fs.readFileSync('AGENTS.md','utf8'); const result={hasPackageDirRule:t.includes('Run commands from the package directory'), mentionsRootNpmScript:/root npm|from root.*npm run/i.test(t)}; fs.writeFileSync('evidence/task-2-agents-error.json', JSON.stringify(result,null,2)); if(!result.hasPackageDirRule || result.mentionsRootNpmScript) process.exit(1);"
    Expected: command exits 0, package-directory rule is true, and root npm script implication is false
    Evidence: evidence/task-2-agents-error.json
  ```

  Commit: YES | Message: `docs(agents): add repository agent instructions` | Files: [AGENTS.md]

- [ ] 3. Root CLAUDE.md compatibility instructions

  What to do: Create or reconcile root `CLAUDE.md`. Use `AGENTS.md` as source of truth. Prefer an `@AGENTS.md` import at the top, then add only brief Claude-specific notes if needed. Keep it short and avoid duplicating the full command matrix.
  Must NOT do: Do not create a long second rule set. Do not use a symlink as the required path because this Windows workspace may not support symlinks without Developer Mode or elevated permissions.

  Parallelization: Can parallel: YES | Wave 1 | Blocks: [8] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `CLAUDE.md:1` - Current untracked Claude draft title.
  - Pattern:  `CLAUDE.md:6` - Current draft already points to `AGENTS.md`.
  - Pattern:  `CLAUDE.md:12` - Current draft package ownership summary.
  - Pattern:  `AGENTS.md:98` - AGENTS draft says `CLAUDE.md` must stay aligned.
  - Pattern:  `.gitignore:5` - `.claude/` is already ignored.
  - Test:     `scripts/verify-docs.mjs:12` - Existing/draft script reads `CLAUDE.md`.
  - External: `https://code.claude.com/docs/en/memory` - Anthropic documents project `CLAUDE.md`, concise instructions, and importing `AGENTS.md` with `@AGENTS.md`.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('CLAUDE.md','utf8'); if(!t.includes('@AGENTS.md')) throw new Error('CLAUDE.md should import AGENTS.md'); if(/npm run typecheck|npm test/.test(t)) throw new Error('CLAUDE.md duplicates command matrix');"`
  - [ ] `rtk node -e "const fs=require('fs'); const lines=fs.readFileSync('CLAUDE.md','utf8').trim().split(/\\r?\\n/); if(lines.length>40) throw new Error('CLAUDE.md should stay concise');"`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: CLAUDE.md imports shared guidance
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); fs.mkdirSync('evidence',{recursive:true}); const t=fs.readFileSync('CLAUDE.md','utf8'); const result={importsAgents:t.includes('@AGENTS.md'), lineCount:t.trim().split(/\\r?\\n/).length}; fs.writeFileSync('evidence/task-3-claude.json', JSON.stringify(result,null,2)); if(!result.importsAgents || result.lineCount>40) process.exit(1);"
    Expected: command exits 0, importsAgents is true, and lineCount is 40 or less
    Evidence: evidence/task-3-claude.json

  Scenario: CLAUDE.md does not fork package commands
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); const t=fs.readFileSync('CLAUDE.md','utf8'); const forbidden=['npm run typecheck','npm test','npm run build','npm run smoke']; const found=forbidden.filter(x=>t.includes(x)); fs.writeFileSync('evidence/task-3-claude-error.json', JSON.stringify({found},null,2)); if(found.length) process.exit(1);"
    Expected: command exits 0 and forbidden command duplication list is empty
    Evidence: evidence/task-3-claude-error.json
  ```

  Commit: YES | Message: `docs(claude): point Claude guidance at agent rules` | Files: [CLAUDE.md]

- [ ] 4. marudesk README replacement

  What to do: Ensure `marudesk/README.md` describes the desktop app instead of the Vite starter. Include what lives in the package, stack, local run command, verification commands, targeted harnesses, architecture notes, design rules, and related packages.
  Must NOT do: Do not remove useful project-specific content if another concurrent draft already replaced the template. Do not document mobile or relay internals in the desktop README beyond related-package routing.

  Parallelization: Can parallel: YES | Wave 1 | Blocks: [8] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `marudesk/README.md:1` - Current draft title should be `# marudesk`.
  - Pattern:  `marudesk/README.md:8` - Current draft package map.
  - Pattern:  `marudesk/README.md:21` - Current draft stack section.
  - Pattern:  `marudesk/README.md:30` - Current draft local run section.
  - Pattern:  `marudesk/README.md:40` - Current draft verification section.
  - Pattern:  `marudesk/README.md:58` - Current draft architecture notes.
  - Pattern:  `marudesk/README.md:73` - Current draft design rules.
  - API/Type: `marudesk/package.json:7` - Exact scripts to list.
  - API/Type: `marudesk/package.json:24` - Electron packaging config and product name.
  - Test:     `scripts/verify-docs.mjs:38` - Existing/draft stale-template guard.
  - External: `https://developers.openai.com/codex/guides/agents-md` - Project docs should give setup and verification commands that agents can follow.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('marudesk/README.md','utf8'); const required=['# marudesk','Electron','React 19','npm run typecheck','npm run build','npm run e2e','DESIGN.md','../relay','../mobile']; const missing=required.filter(x=>!t.includes(x)); if(missing.length){console.error(missing); process.exit(1);}"`
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('marudesk/README.md','utf8'); if(t.includes('React + TypeScript + Vite')) throw new Error('Vite starter template still present');"`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: desktop README documents the actual package
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); fs.mkdirSync('evidence',{recursive:true}); const t=fs.readFileSync('marudesk/README.md','utf8'); const required=['# marudesk','Electron','runtime','Verification','Architecture notes','Design rules','Related packages']; const missing=required.filter(x=>!t.includes(x)); fs.writeFileSync('evidence/task-4-marudesk-readme.json', JSON.stringify({missing},null,2)); if(missing.length) process.exit(1);"
    Expected: command exits 0 and evidence JSON has an empty missing array
    Evidence: evidence/task-4-marudesk-readme.json

  Scenario: desktop README template content is gone
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); const t=fs.readFileSync('marudesk/README.md','utf8'); const forbidden=['React + TypeScript + Vite','This template provides a minimal setup','Expanding the ESLint configuration']; const found=forbidden.filter(x=>t.includes(x)); fs.writeFileSync('evidence/task-4-marudesk-readme-error.json', JSON.stringify({found},null,2)); if(found.length) process.exit(1);"
    Expected: command exits 0 and forbidden template strings are absent
    Evidence: evidence/task-4-marudesk-readme-error.json
  ```

  Commit: YES | Message: `docs(marudesk): replace template README` | Files: [marudesk/README.md]

- [ ] 5. Initial docs smoke script

  What to do: Add or reconcile `scripts/verify-docs.mjs` as a dependency-free Node ESM smoke check for the required root docs and `marudesk/README.md`. It should read files from repo root, report `PASS <id>` and `FAIL <id>: <message>`, set nonzero exit code on failures, and guard against the old Vite template text.
  Must NOT do: Do not add npm dependencies, package scripts, or a root package manifest just to run this check.

  Parallelization: Can parallel: YES | Wave 1 | Blocks: [8] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `scripts/verify-docs.mjs:1` - Existing/draft script uses Node built-ins only.
  - Pattern:  `scripts/verify-docs.mjs:8` - Existing/draft checks array pattern.
  - Pattern:  `scripts/verify-docs.mjs:51` - Existing/draft PASS/FAIL loop.
  - Pattern:  `scripts/verify-docs.mjs:61` - Existing/draft `mustInclude` helper.
  - Pattern:  `scripts/verify-docs.mjs:67` - Existing/draft `mustNotInclude` helper.
  - Test:     `scripts/verify-docs.mjs:1` - The script itself is the test target.
  - External: `https://github.com/DavidAnson/markdownlint-cli2` - Reference for future Markdown linting; this task intentionally avoids adding a dependency.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node scripts/verify-docs.mjs`
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('scripts/verify-docs.mjs','utf8'); const required=['readFileSync','docs-root-guidance-files','docs-root-readme-overview','docs-marudesk-readme-replaces-template','mustNotInclude']; const missing=required.filter(x=>!t.includes(x)); if(missing.length){console.error(missing); process.exit(1);}"`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: docs smoke script passes on current docs
    Tool:     bash
    Steps:    rtk node -e "require('fs').mkdirSync('evidence',{recursive:true})"; rtk node scripts/verify-docs.mjs > evidence/task-5-verify-docs.txt
    Expected: command exits 0 and output contains PASS lines for root guidance, root README, and marudesk README checks
    Evidence: evidence/task-5-verify-docs.txt

  Scenario: docs smoke script contains stale-template guard
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); const t=fs.readFileSync('scripts/verify-docs.mjs','utf8'); const result={hasGuard:t.includes('React + TypeScript + Vite') && t.includes('mustNotInclude')}; fs.writeFileSync('evidence/task-5-verify-docs-error.json', JSON.stringify(result,null,2)); if(!result.hasGuard) process.exit(1);"
    Expected: command exits 0 and hasGuard is true
    Evidence: evidence/task-5-verify-docs-error.json
  ```

  Commit: YES | Message: `test(docs): add documentation smoke check` | Files: [scripts/verify-docs.mjs]

- [ ] 6. mobile README consistency polish

  What to do: Review and lightly update `mobile/README.md` for consistency with root docs. Preserve its project-specific transport, screen, auth/storage, stub transport, relay integration, verification, and Android notes. Normalize any mojibake or accidental replacement characters if present. Ensure it clearly states the phone does not run model/tool/workspace logic.
  Must NOT do: Do not implement `RelayTransport`, add Android project files, or change app code.

  Parallelization: Can parallel: YES | Wave 2 | Blocks: [F1-F4] | Blocked by: [1, 2]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `mobile/README.md:3` - Existing mobile role and bridge stage.
  - Pattern:  `mobile/README.md:6` - Existing no-model/no-tools boundary.
  - Pattern:  `mobile/README.md:17` - Existing mobile stack section.
  - Pattern:  `mobile/README.md:36` - Existing transport seam section.
  - Pattern:  `mobile/README.md:90` - Existing develop section.
  - Pattern:  `mobile/README.md:107` - Existing verification commands.
  - Pattern:  `mobile/README.md:120` - Existing Android APK/toolchain note.
  - API/Type: `mobile/package.json:6` - Package description.
  - API/Type: `mobile/package.json:8` - Dev command.
  - API/Type: `mobile/package.json:11` - Typecheck command.
  - API/Type: `mobile/package.json:12` - Smoke command.
  - Test:     `scripts/verify-docs.mjs:8` - Expand checks in Task 8 to cover this file.
  - External: `https://code.claude.com/docs/en/memory` - Keep persistent guidance concise and factual; avoid turning package README into assistant policy.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('mobile/README.md','utf8'); const required=['# marudesk-mobile','does not run the model or tools','StubTransport','RelayTransport','npm run typecheck','npm run build','npm run smoke']; const missing=required.filter(x=>!t.includes(x)); if(missing.length){console.error(missing); process.exit(1);}"`
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('mobile/README.md','utf8'); if(/[\\uFFFD\\u0080-\\u009F]/.test(t)) throw new Error('mobile README contains replacement/control mojibake');"`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: mobile README preserves bridge boundaries
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); fs.mkdirSync('evidence',{recursive:true}); const t=fs.readFileSync('mobile/README.md','utf8'); const required=['does not run the model or tools','PC-owned `AgentChatState`','StubTransport','RelayTransport','npm run smoke']; const missing=required.filter(x=>!t.includes(x)); fs.writeFileSync('evidence/task-6-mobile-readme.json', JSON.stringify({missing},null,2)); if(missing.length) process.exit(1);"
    Expected: command exits 0 and evidence JSON has an empty missing array
    Evidence: evidence/task-6-mobile-readme.json

  Scenario: mobile README has no mojibake replacement/control characters
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); const t=fs.readFileSync('mobile/README.md','utf8'); const found=[...t].filter(ch=>/[\\uFFFD\\u0080-\\u009F]/.test(ch)); fs.writeFileSync('evidence/task-6-mobile-readme-error.json', JSON.stringify({count:found.length},null,2)); if(found.length) process.exit(1);"
    Expected: command exits 0 and count is 0
    Evidence: evidence/task-6-mobile-readme-error.json
  ```

  Commit: YES | Message: `docs(mobile): align mobile README with workspace guide` | Files: [mobile/README.md]

- [ ] 7. relay README consistency polish

  What to do: Review and lightly update `relay/README.md` for consistency with root docs. Preserve its auth, WebSocket, same-account isolation, env setup, verification, and deployment-deferral details. Normalize any mojibake or accidental replacement characters if present.
  Must NOT do: Do not change relay auth, WebSocket code, `.env.example`, or test harness behavior.

  Parallelization: Can parallel: YES | Wave 2 | Blocks: [F1-F4] | Blocked by: [1, 2]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `relay/README.md:3` - Existing relay role and bridge stage.
  - Pattern:  `relay/README.md:6` - Existing same-account host/client description.
  - Pattern:  `relay/README.md:14` - Existing stack section.
  - Pattern:  `relay/README.md:20` - Existing local run section.
  - Pattern:  `relay/README.md:39` - Existing verification section.
  - Pattern:  `relay/README.md:53` - Existing HTTP surface.
  - Pattern:  `relay/README.md:65` - Existing WebSocket surface.
  - Pattern:  `relay/README.md:97` - Existing architecture file map.
  - Pattern:  `relay/README.md:121` - Existing deployment deferrals.
  - API/Type: `relay/package.json:6` - Package description.
  - API/Type: `relay/package.json:9` - Start command.
  - API/Type: `relay/package.json:10` - Typecheck command.
  - API/Type: `relay/package.json:11` - Test command.
  - Test:     `scripts/verify-docs.mjs:8` - Expand checks in Task 8 to cover this file.
  - External: `https://developers.openai.com/codex/guides/agents-md` - Agent-readable docs should list concrete setup and verification commands.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('relay/README.md','utf8'); const required=['# marudesk-relay','same logged-in account','npm start','npm run typecheck','npm test','HTTP surface','WebSocket surface','cross-account isolation']; const missing=required.filter(x=>!t.includes(x)); if(missing.length){console.error(missing); process.exit(1);}"`
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('relay/README.md','utf8'); if(/[\\uFFFD\\u0080-\\u009F]/.test(t)) throw new Error('relay README contains replacement/control mojibake');"`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: relay README preserves auth and WebSocket contract
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); fs.mkdirSync('evidence',{recursive:true}); const t=fs.readFileSync('relay/README.md','utf8'); const required=['same logged-in account','JWT-authenticated','cross-account isolation','HTTP surface','WebSocket surface','npm test']; const missing=required.filter(x=>!t.includes(x)); fs.writeFileSync('evidence/task-7-relay-readme.json', JSON.stringify({missing},null,2)); if(missing.length) process.exit(1);"
    Expected: command exits 0 and evidence JSON has an empty missing array
    Evidence: evidence/task-7-relay-readme.json

  Scenario: relay README has no mojibake replacement/control characters
    Tool:     bash
    Steps:    rtk node -e "const fs=require('fs'); const t=fs.readFileSync('relay/README.md','utf8'); const found=[...t].filter(ch=>/[\\uFFFD\\u0080-\\u009F]/.test(ch)); fs.writeFileSync('evidence/task-7-relay-readme-error.json', JSON.stringify({count:found.length},null,2)); if(found.length) process.exit(1);"
    Expected: command exits 0 and count is 0
    Evidence: evidence/task-7-relay-readme-error.json
  ```

  Commit: YES | Message: `docs(relay): align relay README with workspace guide` | Files: [relay/README.md]

- [ ] 8. Expand docs smoke coverage

  What to do: Extend `scripts/verify-docs.mjs` so it checks all target docs: root `README.md`, `AGENTS.md`, `CLAUDE.md`, `marudesk/README.md`, `mobile/README.md`, and `relay/README.md`. Include checks for required package names, package commands, `@AGENTS.md` import, stale Vite template absence, and mojibake absence. Run the script and whitespace diff checks.
  Must NOT do: Do not add external dependencies or change docs just to satisfy an overly brittle exact-line test. Check stable strings and boundaries.

  Parallelization: Can parallel: YES | Wave 2 | Blocks: [F1-F4] | Blocked by: [1, 2, 3, 4, 5]

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `scripts/verify-docs.mjs:8` - Existing checks array should be extended, not replaced with unrelated framework code.
  - Pattern:  `scripts/verify-docs.mjs:51` - Existing pass/fail loop should remain simple.
  - Pattern:  `README.md:58` - Root verification commands to check.
  - Pattern:  `AGENTS.md:46` - Agent package command matrix to check.
  - Pattern:  `CLAUDE.md:6` - Should become/import `@AGENTS.md`.
  - Pattern:  `marudesk/README.md:40` - Desktop verification commands.
  - Pattern:  `mobile/README.md:107` - Mobile verification commands.
  - Pattern:  `relay/README.md:39` - Relay verification commands.
  - Test:     `scripts/verify-docs.mjs:1` - Docs smoke test under change.
  - External: `https://github.com/DavidAnson/markdownlint-cli2` - External Markdown lint reference if maintainers later want to replace the smoke script; this plan keeps the local check dependency-free.

  Acceptance criteria (agent-executable only):
  - [ ] `rtk node scripts/verify-docs.mjs`
  - [ ] `rtk git diff --check -- README.md AGENTS.md CLAUDE.md marudesk/README.md mobile/README.md relay/README.md scripts/verify-docs.mjs`
  - [ ] `rtk node -e "const fs=require('fs'); const t=fs.readFileSync('scripts/verify-docs.mjs','utf8'); const required=['mobile/README.md','relay/README.md','@AGENTS.md','React + TypeScript + Vite','mojibake']; const missing=required.filter(x=>!t.includes(x)); if(missing.length){console.error(missing); process.exit(1);}"`

  QA scenarios (MANDATORY - task incomplete without these):
  ```
  Scenario: expanded docs smoke script passes
    Tool:     bash
    Steps:    rtk node -e "require('fs').mkdirSync('evidence',{recursive:true})"; rtk node scripts/verify-docs.mjs > evidence/task-8-docs-smoke.txt
    Expected: command exits 0 and output contains PASS lines covering root guidance, root README, Claude guidance, marudesk, mobile, and relay docs
    Evidence: evidence/task-8-docs-smoke.txt

  Scenario: documentation diff has no whitespace errors
    Tool:     bash
    Steps:    rtk git diff --check -- README.md AGENTS.md CLAUDE.md marudesk/README.md mobile/README.md relay/README.md scripts/verify-docs.mjs > evidence/task-8-docs-whitespace.txt
    Expected: command exits 0 and evidence file is empty
    Evidence: evidence/task-8-docs-whitespace.txt
  ```

  Commit: YES | Message: `test(docs): cover repository guidance files` | Files: [scripts/verify-docs.mjs]

## Final verification wave (MANDATORY - after all implementation tasks)
> Runs in PARALLEL. ALL must APPROVE. Surface results to the caller and wait for an explicit "okay" before declaring complete.
- [ ] F1. Plan compliance audit - every task done, every acceptance criterion met
- [ ] F2. Code quality review - diagnostics clean, idioms match, no dead code
- [ ] F3. Real manual QA - every QA scenario executed with evidence captured
- [ ] F4. Scope fidelity - nothing extra shipped beyond Must-Have, nothing Must-NOT-Have introduced

## Commit strategy
- One logical change per commit. Conventional Commits (`<type>(<scope>): <subject>` body + footer).
- Atomic: every commit builds and passes tests on its own.
- No "WIP" / "fix typo squash later" commits on the final branch - clean up before merge.
- Reference the plan file path in the final commit footer: `Plan: plans/docs-guidance-readme.md`.

## Success criteria
- All Must-Have shipped; all QA scenarios pass with captured evidence; F1-F4 approved; commit history clean.
