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

## Scout, the guide (branch `codetown-scout`)
- **Who:** an original little guide made for Code Town and not based on any existing character or game asset: a small round cream block with big friendly eyes, rosy cheeks, a warm red cap and scarf, and a lantern whose colour shows its mood.
- **Where it goes** (`src/town/scout.ts`, pure: no VS Code, no Three.js, no clock):
  - Scout's place, speech bubble and mood come only from town events.
  - It walks to each building as the agent plans, reads, proposes, has a change accepted or rejected, changes, reverts or fails a test.
  - On failover or recovery it goes to the power plant and says what happened in plain words. Bubbles never repeat provider error text or key values.
- **Clicks:** clicking a building, or **Open file** in the inspector, sends a typed `navigate` request (a relative path, no extra fields). The host also requires the path to be a building in the town. It then journals the click as `scout_navigate`, Scout walks there, and the file opens. Because clicks are journaled too, a replay reproduces Scout exactly.
- **Movement:** Scout hops from roof to roof, so it stays visible from any angle. With reduced motion it doesn't walk: it fades out and back in at the new place. In the 2D view a Scout bar shows the bubble text and the target building is outlined.
- **Mute:** setting `codecraft.scout` (`on` | `muted`) hides Scout, its bubble and its tips. Scout never edits files, runs tasks or calls a model.

## Ask Scout (built-in help, no model calls)
- **What it is:** the **Ask Scout** box in the Code Town panel. It answers from a static knowledge base plus the live town state (`src/town/help.ts`) using keyword and intent matching. It never calls a model and never touches the network; the page's CSP has no `connect-src`, and a test asserts that no `fetch`, XHR or WebSocket call happens.
- **What it covers:** building colours and states, reviewing and accepting or rejecting hunks, undo and rollback, stopping a run, failover, switching models, running the three tasks, Journey, Architecture and Replay, the cost panel, Scout itself, what is happening now, and test marks and confidence tags.
- **When it doesn't know:** it offers six suggested questions, and otherwise says plainly that it doesn't know and points to the README.
- **Tips:** short, dismissible tips (failover, recovery, the first review, a failing test) appear once each and never block the editor.

## Colour (original style)
- **Palette:** each district gets wall and rooftop colours from a warm palette (terracotta, mustard, teal, plum, coral, sage, sky, rose, apricot, mint), chosen by a stable hash of its name.
- **Buildings:** idle buildings wear their district's colours; a building the agent touches switches to its bright state colour with a beacon.
- **Lights and celebrations:** string lights are multicoloured, and festival lanterns float over applied and recovered buildings.
- **Replay:** the journey path turns rainbow, with a rainbow REPLAY tag.
- **Contrast:** every state still has a colour, an icon and a text label. A test enforces that state colours are distinct and have at least 3:1 contrast on the panels; idle was raised from 2.4:1 to 5.4:1.

## Rendering
- The renderer (`src/webview/town/graph.ts`) uses one `InstancedMesh` for all buildings, plus instanced roof beacons and district slabs.
- Only a new index rebuilds the scene; every journal event updates just the instances it touches.
- The layout (`src/town/layout.ts`) reserves spare slots, so a new file never moves the rest of the town.
- Every geometry, material and texture is owned by the graph and disposed when replaced or when the panel closes.
- The webview is read-only. It can only send `open_file` (a relative path) and `replay_run` (an optional 16-hex run ID), and the host validates both.
- The CSP allows no inline scripts or inline style attributes.

## Frame-rate and memory check (measured 2026-11-21)
`npm run town-perf` opens the real webview in headless Edge with the 234-file Flask fixture town. It streams in the events of the recorded task2 run (`docs/results/task2-2026-11-21T12-28-18-245Z.json`): 28 reads, 3 planned files, 4 proposed and applied changes, 3 test runs, 5 retries and 1 failover, 54 events in all. The recorded run took 542 s; it is streamed over 60 s of real time, a heavier load than the live run. Samples are taken every 5 s over the DevTools protocol, in wall-clock time.

**Clean re-measure (2026-11-22), `main` against `codetown-scout`, same harness, same recorded run, one browser at a time:**

| Build | GPU | Motion | Frames per second during the run | JS heap | GPU resources (start → end) | Draw calls | Frames drawn in 75 s | Rebuilds | Listeners (start / end) |
|---|---|---|---|---|---|---|---|---|---|
| `main` | Intel UHD Graphics (D3D11) | on | 144 (display limit) | 6.4–10.5 MB | 12 → 14 geometries, 50 → 54 textures | 66 | 10,795 | 2 (startup); 54 incremental | 22 / 22 |
| `main` | SwiftShader (software) | on | 15.8–16.8 | 5.9–7.3 MB | same | 66 | 1,221 | 2; 54 | 22 / 22 |
| `main` | Intel UHD Graphics | reduced | 143.8–144.2 (loop ticks only) | 5.5–6.8 MB | same | 66 | **56** | 2; 54 | 22 / 22 |
| `codetown-scout` | Intel UHD Graphics (D3D11) | on | 143.8–144.2 | 8.2–10.1 MB | 25 → 27 geometries, 51 → 54 textures | 83 | 10,783 | 2; 54 | 25 / 25 |
| `codetown-scout` | SwiftShader (software) | on | 14.8–15.6 | 6.4–8.8 MB | same | 83 | 1,130 | 2; 54 | 25 / 25 |
| `codetown-scout` | Intel UHD Graphics | reduced | 143.7–144.2 | 6.2–10.1 MB | same | 83 | 4,751 | 2; 54 | 25 / 25 |

How to read these numbers:
- The heap does not grow on either build.
- Scout adds 13 geometries (its body parts, roofs and lanterns), 17 draw calls and 3 listeners (the Ask Scout box and tips). On the GPU, the frame rate is unchanged.
- **Software rendering:** a first version of the colourful town halved it (8.4–9.2 fps). Two changes brought it back to 14.8–15.6 fps: plain boxes instead of rounded roof caps, and a lantern pool that draws only the lanterns in use (3 for one celebrating building, instead of 3 per building).
- **Reduced motion** draws more frames than on `main` (4,751 against 56). Scout doesn't walk, but each of the 54 moves is a 0.6 s fade, and frames are drawn only during those fades.

**Correction to the first measurement (2026-11-21, below).** The harness used to kill only the browser launcher. On Windows each run therefore left its headless browser running and animating, so the software and reduced-motion rows of that first check ran beside 1–2 leftover browsers. On a clean machine, `main`'s software rendering is 15.8–16.8 fps, not ~14. The harness now asks the browser to close over the DevTools protocol and then ends its process tree; a check after every run found no leftovers. Raw samples: `docs/results/town-perf-main-clean-*.json` and `town-perf-scout-*.json`.

First measurement (2026-11-21, superseded by the clean re-measure above):

| GPU | Motion | Frames per second during the run | JS heap | GPU resources (start → end) | Frames drawn in 75 s | Scene rebuilds | Listeners (start / end) |
|---|---|---|---|---|---|---|---|
| Intel UHD Graphics (D3D11) | on | 143.7–144.2 (display limit) | 6.7–10.4 MB, no growth | 12 → 14 geometries, 50 → 54 textures | 10,770 | 2 (startup only); 54 incremental | 22 / 22 |
| SwiftShader (software, no GPU) | on | 13.8–14.8 (1 leftover browser running) | 5.8–6.9 MB | same | 1,073 | 2; 54 incremental | 22 / 22 |
| Intel UHD Graphics | reduced | 143.2–144.2 (loop ticks, nothing drawn; 2 leftover browsers) | 5.5–6.8 MB | same | **56** (one per event) | 2; 54 incremental | 22 / 22 |

The 4 extra geometries and textures in a run are the journey path line and its stop numbers (at most 40 numbers). Raw samples are in `docs/results/town-perf-task2-*.json`.

Not measured: a live task2 run with a model. Live model runs were paused at the time, so the check replays the recorded run's events into the same code path the live panel uses.

## Clean shutdown
Closing the panel removes its journal listener, its settings listener and the webview message handler (VS Code test: listener count 1 → 0, and back to 1 on reopen). In the webview, every DOM listener is registered through one helper and removed on unload; the animation frame and replay timer are cancelled; and the scene graph and renderer free all GPU resources.
