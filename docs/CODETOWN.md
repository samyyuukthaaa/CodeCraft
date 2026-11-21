# Code Town

Code Town shows the workspace as a night-time town and the agent's run as activity in it. Open it with **CodeCraft: Open Code Town**.

## One source of truth
- **Layout** comes from the repository index: folders are districts, files are buildings, imports are roads.
- **Everything that happens** comes from the append-only journal, through the pure projection `src/town/fromJournal.ts`. That covers plans, reads, proposals, per-hunk review decisions, applied changes, undos and rollbacks, test runs and regressions, provider errors, failover and recovery.
- The town records nothing of its own, so reloading the panel (or VS Code) rebuilds exactly the same scene.
- The scene reducer (`src/town/reducer.ts`) is pure and deterministic: it imports neither VS Code nor Three.js, never reads the clock, and every event carries its own journal timestamp.

## Scene grammar (`src/town/grammar.ts`)
| Workspace | Town |
|---|---|
| folder | district (merged to its top two folder levels above 2,000 files) |
| file | building, height from line count (clamped) |
| test file | lab |
| docs (`.md`, `.rst`, `docs/`) | library |
| config and CLI files (`pyproject.toml`, `*.json`, `cli.py`, `.github/`…) | control centre |
| imports between districts | roads (the 60 heaviest district links) |
| model provider | power plant: healthy, retrying, failed over, recovered |

Building states: idle, planned, read, proposed, applied, rejected, failed, recovered. Each building also shows its real test status. Every state, kind and status has a colour, an icon and a text label. A file that is not in the index is drawn as a small placeholder lot. Provider errors change the power plant, never a building.

## Views
- **Agent Journey**: the run's path as a yellow line with numbered stops, buildings coloured by state, a light shaft over the building the agent is working on.
- **Architecture**: buildings coloured by kind, import roads highlighted.
- **Legend** for the current mode.
- **Inspector** (click a building): status, last agent action and time, reason, plain-English sentence and confidence (from the change group), tests, kind, size, journey stop, and an Open file button.
- **Replay**: any finished run from the journal, through the same reducer. Play, pause, 0.5× to 8×, a position slider, and Back to live.
- **2D view**: used automatically when WebGL is unavailable or the WebGL context is lost, and available any time with a button.
- **Reduced motion**: setting `codecraft.townReducedMotion` (`auto` follows the OS). With reduced motion on, nothing animates and a frame is drawn only when something changes.

## Rendering
- The renderer (`src/webview/town/graph.ts`) uses one `InstancedMesh` for all buildings, plus instanced roof beacons and district slabs.
- Only a new index rebuilds the scene; every journal event updates just the instances it touches.
- The layout (`src/town/layout.ts`) reserves spare slots, so a new file never moves the rest of the town.
- Every geometry, material and texture is owned by the graph and disposed when replaced or when the panel closes.
- The webview is read-only. It can only send `open_file` (a relative path) and `replay_run` (an optional 16-hex run ID), and the host validates both.
- The CSP allows no inline scripts or inline style attributes.

## Frame-rate and memory check (measured 2026-11-21)
`npm run town-perf` opens the real webview in headless Edge with the 234-file Flask fixture town. It streams in the events of the recorded task2 run (`docs/results/task2-2026-11-21T12-28-18-245Z.json`): 28 reads, 3 planned files, 4 proposed and applied changes, 3 test runs, 5 retries and 1 failover, 54 events in all. The recorded run took 542 s; it is streamed over 60 s of real time, a heavier load than the live run. Samples are taken every 5 s over the DevTools protocol, in wall-clock time.

| GPU | Motion | Frames per second during the run | JS heap | GPU resources (start → end) | Frames drawn in 75 s | Scene rebuilds | Listeners (start / end) |
|---|---|---|---|---|---|---|---|
| Intel UHD Graphics (D3D11) | on | 143.7–144.2 (display limit) | 6.7–10.4 MB, no growth | 12 → 14 geometries, 50 → 54 textures | 10,770 | 2 (startup only); 54 incremental | 22 / 22 |
| SwiftShader (software, no GPU) | on | 13.8–14.8 | 5.8–6.9 MB | same | 1,073 | 2; 54 incremental | 22 / 22 |
| Intel UHD Graphics | reduced | 143.2–144.2 (loop ticks, nothing drawn) | 5.5–6.8 MB | same | **56** (one per event) | 2; 54 incremental | 22 / 22 |

The 4 extra geometries and textures are the journey path line and its stop numbers (at most 40 numbers). Raw samples are in `docs/results/town-perf-task2-*.json`.

Not measured: a live task2 run with a model. Live model runs were paused at the time, so the check replays the recorded run's events into the same code path the live panel uses.

## Clean shutdown
Closing the panel removes its journal listener, its settings listener and the webview message handler (VS Code test: listener count 1 → 0, and back to 1 on reopen). In the webview, every DOM listener is registered through one helper and removed on unload; the animation frame and replay timer are cancelled; and the scene graph and renderer free all GPU resources.
