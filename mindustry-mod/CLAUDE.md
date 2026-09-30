# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

This directory contains the Mindustry-side Java Mod. The control-plane and edge-node server are maintained at the monorepo root (`../src/`); protocol changes should update both components.

This repository contains:

- `mod/` — Gradle Java project for the Mindustry Mod.
- `proto/PROTOCOL.md` — wire protocol contract shared by Mod, control plane, and edge nodes.
- Build with an installed JDK 17; Gradle downloads its wrapper and dependencies as needed.

There is no root Gradle or npm project. Run Gradle with `-p mod` or from the `mod/` directory.

## Common commands

Use an installed JDK 17. The following build commands run from `mindustry-mod/`:

Build the desktop Mod jar for the default/v7 target:

```powershell
& ".\mod\gradlew.bat" -p ".\mod" clean jar "-PgameVersion=v146"
```

Build against the v8 dependency set:

```powershell
& ".\mod\gradlew.bat" -p ".\mod" jar "-PgameVersion=v159.7"
```

Create the combined desktop+Android distribution jar:

```powershell
& ".\mod\gradlew.bat" -p ".\mod" deploy "-PgameVersion=v146"
```

`deploy` requires `ANDROID_HOME` or `ANDROID_SDK_ROOT` with an installed Android platform and build-tools `d8`. It writes `mod/build/libs/LanLink.jar`; normal `jar` writes `mod/build/libs/LanLinkDesktop.jar`.

There is no Mod-side test suite or lint task in this repository. For protocol/control-plane changes, run the server tests from the monorepo root:

```bash
npm --prefix .. test
```

Run a single server test file:

```bash
cd .. && node --test tests/control.test.js
```

Run matching server tests:

```bash
cd .. && node --test --test-name-pattern "create_room" tests/control.test.js
```

Start the related server stack for manual testing:

```bash
cd .. && node src/app.js
cd .. && node src/node/agent.js
```

Useful manual smoke endpoints while the server is running:

```text
http://127.0.0.1:5100/api/health
http://127.0.0.1:5100/api/nodes/available
```

## Mod architecture

- `lanlink.LanLinkMod` is the Mindustry Mod entry point. It creates one `TunnelManager`, creates `LanLinkDialog` after client load, and injects LanLink buttons into the host and paused menus.
- `lanlink.ui.LanLinkDialog` is the user-facing panel. It stores settings in `Core.settings`, lets the host choose the control plane, refreshes relay nodes, offers parallel list/manual relay selection modes, starts/stops rooms, and displays/copies the public room info.
- `lanlink.net.ControlPlaneApi` is a small HTTP client for pre-room control-plane queries. It normalizes `ws://`/`wss://` control URLs to HTTP(S) for `/api/nodes/available`, and normalizes back to WebSocket base URLs for room creation.
- `lanlink.net.ControlClient` wraps the Mod ↔ control-plane WebSocket channel. It should stay focused on WS lifecycle and JSON message delivery.
- `lanlink.tunnel.TunnelManager` owns the room lifecycle: connect control plane, send `hello`, send `create_room`, handle `room_ok`/`room_closed`, then open TCP and UDP tunnels to the selected node. Use `TunnelManager.OpenOptions` rather than adding more positional `open(...)` parameters.
- `lanlink.tunnel.TcpBridge` splices one node data-chain TCP socket to one local Mindustry TCP socket.
- `lanlink.tunnel.UdpBridge` implements the UDP tunnel. Keep the existing ArcNet constraint: each remote UDP `sessionId` must use its own local UDP socket to `127.0.0.1:gamePort`; sharing one socket causes Mindustry UDP session routing problems.
- `lanlink.Compat` is the place for Mindustry v7/v8 API differences.

## Protocol and compatibility notes

`proto/PROTOCOL.md` is the shared contract. Update it whenever changing WS JSON fields, HTTP endpoints, or tunnel frame formats.

The current Mod/control-plane protocol is v2; follow the shared contract and keep fields marked optional compatible:

- `hello.mod_version`, `hello_ok.server_version`, `room_ok.display_name`, and `node.name` are display/diagnostic fields and must remain optional for compatibility.
- `create_room.node_id`, `relay_addr`, and `relay_tunnel_port` are optional explicit node-selection fields. If absent, the control plane should continue automatic node selection.
- Manual relay entry is not a bypass around the control plane. It matches an online node registered to the current control plane by address/tunnel port; unmatched selections should fail clearly rather than silently falling back to a different node.

For protocol changes across these components, also update and run tests in `..`, especially `tests/control.test.js`.

## Build details that matter

- `mod/build.gradle` compiles Java 17 source syntax to Java 8 bytecode using Jabel and `--release 8` so the jar can run on v7 and v8 runtimes.
- `-PgameVersion=v146` uses JitPack Mindustry/Arc dependencies; v8 targets such as `v159.7` use Mindustry release `dependencies.jar` via the Ivy repository block.
- `generateBuildInfo` writes `lanlink.BuildInfo.MOD_VERSION` from the Gradle project version; use it for Mod version display instead of hardcoding versions in Java.
- `mod/mod.hjson` declares this as a hidden Java utility Mod with `legacyCompatible: true`, allowing v7/v8 dual compatibility.
