# Security Policy

MaruDesk handles local workspaces, browser runtime data, provider credentials,
OAuth flows, remote pairing, and plugin execution. Please report security issues
privately before publishing details.

## Supported versions

MaruDesk is in active development. Security fixes target the current `master`
branch and the latest published release when a release exists.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting or Security Advisories flow if it is
available for this repository. If that is not available, email the maintainer at
`duct1235@gmail.com`.

Please include:

- A short description of the issue and affected area.
- Reproduction steps or a minimal proof of concept.
- Impact, especially whether credentials, local files, browser data, or remote
  pairing state can be exposed or modified.
- Relevant version, commit, operating system, and configuration.

Do not include real API keys, OAuth tokens, session cookies, private workspace
files, or third-party account data in the report.

## Scope

Security-sensitive areas include:

- Provider secrets and OAuth token storage.
- Browser runtime capture, DevTools, CDP, and embedded-browser automation.
- Agent tools that read, write, execute commands, or access external MCP servers.
- Plugin permissions, isolated-worker execution, filesystem, and network access.
- Remote/mobile pairing, relay traffic, and local server endpoints.
- Update and release packaging.

Issues in undocumented third-party subscription backends should also be reported
to the affected provider when appropriate.
