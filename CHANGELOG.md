# Changelog

## 0.2.0 - 2026-06-08

- Add macOS desktop support: ship `dmg` builds for both Apple Silicon (arm64)
  and Intel (x64) Macs alongside the existing Windows installer.
- Add Linux desktop support: ship `AppImage` and `deb` builds (x64).
- Add a GitHub Actions release workflow that builds marudesk on native runners
  per platform/arch (macOS arm64, macOS x64, Windows x64, Linux x64) and
  publishes the installers to a GitHub release on every `v*` tag.
- In-app auto-update stays Windows-only for now; the macOS and Linux builds are
  download-and-run until macOS code signing/notarization lands.

## 0.0.1 - 2026-06-04

- Mark the first MaruDesk release baseline across the desktop app, mobile thin client, and relay service.
- Document the initial repository-level release entry.
