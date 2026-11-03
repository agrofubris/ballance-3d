# Original graph runtime handoff (2026-10-22)

This is the historical continuation plan for replacing the hand-ported Ballance module logic
with the generic Virtools graph runtime. The hand-ports and their engine runtime were removed
after the graph session reached full harness parity; current state and commands live in
`docs/original-graph-runtime.md` and `docs/harness.md`. Read `AGENTS.md` first. This document
records the repository state at handoff, the work completed so far, the ordered work queue,
per-module recovered details, and the subagent/verification playbook. Its commands that pass
`--runtime engine` or `--sources` are historical and no longer accepted.

## 0. Hard constraints

- Work in the repository root on the current branch.
- Never reset, clean, or discard the working tree. Do not launch the original `Player.exe`.
- Do not commit unless the user explicitly asks.
- Original data and generated artifacts stay under `.local/` (served as `/original/`).
  `tests/` is local-only and gitignored. Never add NMO/CMO/DLL/EXE/ISO, extracted graphs,
  Data Arrays, UI strings, decompiled listings, or release archives to git.
- Correctness is measured against the recovered original. Do not invent behavior or tune
  empirically. Unsupported data must fail loudly.
- The repo already has hand-ports that simulate all stages. The goal is not "make the game
  playable"; it is "prove the authored graphs replace the hand-ports exactly."

## 1. Repository state at handoff

- `HEAD` = `a18fb81 Add arms and partial chain graph support` (the arms/chain WIP from
  the previous thread was committed on request).
- Previous: `8929d65` (lift), `fdda612` (sack), `75f3bb0` (swing on native IVP),
  `5c5e22e` (Rapier swing), `d4c58bf` (graph host/bindings).
- Phase 1 (shared sector lifecycle) is complete in the working tree but **not yet
  committed**. Modified files: `original-engine.ts` and
  `original-graph-module-instance.ts` (both removed in 502bd84),
  `src/game/original-graph-physics-rapier.ts`, `docs/original-graph-runtime.md`.
  `docs/original-graph-handoff.md` is untracked. `tests/` is gitignored.
- Run `git diff` before editing. Do not revert these changes.

Uncommitted Phase 1 changes:

| File | Change |
| --- | --- |
| `original-engine.ts` (removed in 502bd84) | Pass `sectorLifecycle: true`; each tick calls `module.setActive(module.sector === checkpoint + 1)` before stepping. |
| `original-graph-module-instance.ts` (removed in 502bd84) | `setActive`/`active`; dormant bodies until activation; script restart only when the runtime state was reset; activate/deactivate restores poses, controllers and body kinds while preserving handles. |
| `src/game/original-graph-physics-rapier.ts` | `suspended` lifecycle (construct disabled, defer joints), `activate()`/`suspend()`, authored body-kind restore, activation-time WakeUp releases survive the Physicalize pass. Removed the chain-only `deferJoints`/`enableAtFirstStep` options. |
| `docs/original-graph-runtime.md` | Documents the lifecycle and current parity. |
| `original-graph-module-instance.test.ts` (local, removed) | New regression: dormant at load, hinge only after activation, restored/removed on deactivation, rebuilt on reactivation. |

Current verification (after Phase 1):

- `npx tsc -b` passes.
- `npm test` 490/490 pass.
- `npm run lint` 0 warnings.
- `npm run build` passes (bundle-size warning only).
- `npm run check:hygiene` passes.

Harness state (both sources, `--repeat 2`, all graph repeats bit-identical):

| Scenario group | Rapier | IVP |
| --- | --- | --- |
| `stage8_swing` | exact 0 | exact 0 |
| `stage8_sack` | exact 0 | exact 0 |
| `stage7/9/10/12_lift` | exact 0 | `LIFT_VARIANT`; stage12 exact |
| `stage7_arm`, `stage9_arm`, `stage9_arm_2` | exact 0 | exact 0 |
| `stage2/3/4/8/9/10/11_bridge` | exact 0 | exact 0 |
| `stage2_bridge_stone` | exact 0 | exact 0 |
| `stage2_hinge_25`, `stage2_hinge_30`, `stage7_hinge_37`, `stage7_hinge_41`, `stage9_hinge_19` | exact 0 | exact 0 |
| `stage1_slider` | exact 0 | exact 0 |
| `stage3..12_fan_lift` | exact 0 | exact 0 |
| `stage1_pusher` | exact 0 | small residual (max pose 0.0059) |
| `stage6/7_bridge` | exact 0 | pre-existing small residual (max pos 0.0028/0.0047, orientation 0.0092/0.0845) |

Phase 2 (chain finish) is also complete in the working tree: ActiveBall rows,
string-aware `Test` with the live active-ball substitution, live-target
`Wave Player`, the IVP original-unit object binding fix, and
`stage2_bridge_stone` (Platte07-Platte06 hinge released at the same tick on
both solvers, repeat-2 deterministic).

Phase 3 (passive hinges) is complete in the working tree: five staged hinge
scenarios are exact on both solvers, and a local node test proves the graph
construction matches the hand-port for all 118 placements (body pose, mass,
hulls, joint anchor). Phase 4 (slider) is also complete: `stage1_slider` is
exact on both solvers with repeat-2 determinism. After the Phase 6 polish,
`npm test` is 502/502 (local-only tests include particle emission, fan script
control/audio and native force retargeting).

The chain Rapier divergence is fixed. Root cause: the module's activation restart
re-executed the authored `Physicalize` chain after the authored WakeUp had released
the frozen planks, so most planks were re-frozen. Phase 1 now (a) does not restart the
script on the first activation when the load-time start is still intact, and (b) keeps
bodies released by a WakeUp during a restart from being re-frozen by later
`Physicalize` nodes. The hand-port reset from `stagePlayer` also resets graph modules,
so `reset()` marks the script state uninitialized and the next activation restarts it.

## 2. What the runtime is

```
.nmo/.cmo chunk dumps
  -> scripts/original_chunks.py + scripts/export-*.py
  -> .local/original/graphs/*.json, frames/*.json, data-arrays.json
  -> OriginalGraphRuntime (activation/data links, compounds, waits, timers)
  -> GraphBinding (objects, frames, arrays, physics, audio, effects)
  -> OriginalSession (src/game/original-session.ts) on Rapier or IVP
```

Current key files:

- `src/game/original-graph.ts` - runtime core, behaviors registry, TimerMini/Delayer.
- `src/game/original-session.ts` - multi-document session host.
- `src/game/original-graph-host.ts` - browser host and bindings.
- `src/game/original-graph-physics.ts` - physics behavior parsing.
- `src/game/original-graph-physics-rapier.ts` / `...-ivp.ts` - backend bindings.
- `src/game/original-graph-module-behaviors.ts` - proximity/restore/particles/volume.
- `src/game/original-graph-bindings.ts` - binding contracts.
- `src/harness/*` - scenarios, observer, comparison, variant tolerance.
- `docs/original-graph-runtime.md` - architectural status; update it after each milestone.

The `OriginalEngine`, `OriginalIvpRuntime`, `OriginalGraphModule*`,
`OriginalFinish`, `OriginalIvpFinish`, `OriginalIvpFan` and other hand-port
classes named below were removed in commit 502bd84; the sections describing
them are historical.

Current module hosting semantics (important):

- Rapier graph modules are constructed during level load so body creation order matches
  the hand-port, but `sectorLifecycle` keeps them dormant: bodies disabled, joints/
  forces/springs deferred, graph not stepped. `OriginalEngine.step` calls
  `module.setActive(module.sector === checkpoint + 1)` every tick.
- Activation enables the bodies, activates or restarts the script as needed, and installs
  the authored joints; deactivation restores poses/body kinds, removes controllers and
  disables bodies while retaining Rapier handles. A module reset by `stagePlayer` marks
  its script uninitialized so the next activation restarts it.
- The native IVP runtime constructs the selected graph module inside `activate(sector)`,
  so IVP is already sector-scoped (one module slot only).
- Hand-ports keep bodies disabled/fixed until their sector activates, then enable/create
  joints, and reset on leaving. Rapier now follows the same lifecycle; the remaining
  `stage6/7_bridge` IVP residual is native-solver ordering, not missing sector gating.

## 3. Completed work and root causes worth remembering

### Swing (P_Modul_08), sack (P_Modul_26), lift (P_Modul_03)

All are committed and exact. Important recovered semantics already encoded:

- TimerMini/Delayer use float32 milliseconds and count the activation frame.
- A `wait()` requested during module construction resumes on the first script frame.
- `OriginalGraphModule.start()` must not advance timers with a fabricated delta; it starts
  at `deltaMs = 0`.
- The sack script re-arms its Delayer on the switch frame; the hand-port interval is
  exactly 1500 ms, not 1500 ms + one tick.
- Rapier joint pivots keep the recovered frame coordinate in double precision until the
  body-local anchor is built.
- IVP sack uses a direct world joint (`fixedJointSupport = false`); swing/lift use a fixed
  sphere support.
- Harness orientation comparison normalizes quaternions before measuring the angle.
- Rapier hand-port and graph must create bodies/colliders in the same order; the lift
  hand-port parts were reordered to the authored Physicalize chain for this reason.
- Shared hull meshes must be keyed by target body, not hull name: the lift's seven walls
  reuse one mesh at different rotations.
- Rapier springs are the recovered per-frame impulse (`src/game/original-spring.ts`), not
  `RAPIER.JointData.spring`.
- `CurrentLevel[0][2]` (`Ball_Pos_Frame`) must be filled with `"Ball_Pos_Frame Frame"` and
  resolved to the live player body.
- IVP proximity needs `coordinateScale = 1`; Rapier needs `SCALE` (0.25).
- Lift IVP residual is documented as `LIFT_VARIANT` in `src/harness/scenarios.ts`.

### Arms (P_Modul_17)

Exact on both solvers for `stage7_arm`, `stage9_arm`, `stage9_arm_2` at handoff.
The fix was `frameAnchor` applying the full authored frame matrix (including the hinge
frame's ~2x scale). `P_Modul_17` also has `authoredAnchors: true`.

### Chain (P_Modul_29) - partial

Done in the dirty tree:

- Hand data part/joint order aligned to authored execution order.
- `sharedAnchor: true` (one fixed body at parent origin, like the hand-port).
- `releaseFrozenOnWake: true` + `releaseFrozenAwake: true` (all planks dynamic+wake).
- `wakeJoints: false`, `deferJoints: true`, `enableAtFirstStep: true` for P_Modul_29.
- IVP `fixedJointSupport: false` for P_Modul_29.
- IVP `activating` flag defers Ball_Pos_Frame until the first script frame (fixes a
  construction-time "Missing IVP body P_Modul_29_Platte04" failure).
- IVP now creates compound bodies for single-hull bodies like the native hand-port.

Local checks show hand vs graph construction is identical: parts/joints order, body/joint
handles, anchors, axes, hull vertices, mass/inertia, friction/restitution/groups. A local
chain simulation with a static ball is bit-identical for wood. The earlier Rapier
divergence at the first ball/plank contact (~tick 30) was the activation-time Physicalize/
WakeUp ordering described in section 1; it is fixed. All nine bridge scenarios are now
exact on Rapier. `stage6/7_bridge` retain a small native IVP residual. `wakeJoints`,
`deferJoints`, and `enableAtFirstStep` were experimental; the lifecycle replaced the
latter two and they were removed.

Not yet done for chain:

- `CurrentLevel[0][1]` (`ActiveBall`) is still `-1`.
- `Test` compares numbers; the chain needs string equality against `"Ball_Stone"`.
- The graph `Test` input A (global `Pout 0`) is unwritten; use the live active ball name
  as the recovered global value.
- `Wave Player` uses `context.node.target` (`"res"`) instead of `context.targetName()`;
  the chain's `Misc_RopeTears` target is a live parameter (`targetSource = 5`).
- Break/release path is therefore not exercised by the graph yet. Bridge scenarios use
  wood and do not break; add a stone break scenario/test.
- `TT Restore IC` was a no-op here; it now restores the load-time scene state (see `original-graph-runtime.md`).

### Phase 7 status (2026-10-23)

`PE_Balloon` graph vs hand-port is now bit-identical on both solvers for every
`stage1..12_finish_ride` scenario with repeat-2 determinism, and all scenario
assertions pass (`stage12` keeps its IVP-only UFO assertions).

Root causes and fixes:

- `enableCollision = false` disabled the Rapier collider, so the
  collider-derived mass of the rope/balloon bodies was zero and the platform
  was pinned through infinite-mass neighbours. The binding now uses the empty
  collision-group mask and keeps the collider enabled for mass, like the
  hand-port.
- The authored proximity local 1 is the saved polling countdown. The behavior
  now seeds `OriginalProximity.remaining` from it, reproducing the ending's
  ten-frame outer delay.
- The finish hand-port applies impulses before its wake update. The graph now
  skips controllers/springs on the frame a body is woken and starts newly
  created controllers on the following tick (both opt-in for `PE_Balloon`).
- The Rapier finish hand-port uses no extra solver iterations and derives
  single-hull mass from colliders; the graph is configured the same way.
- External force referentials are fixed world points (the ending's rope
  forces), not body-local anchors, on both backends.
- The native runtime hosts `PE_Balloon` as a graph module and exposes
  `OriginalIvpGraphFinish` as the presentation view; harness finish scenarios
  select the real `PE_Balloon_01` placement.
- IVP graph modules now cache authored poses for every document object (not
  only static `Physicalize` targets), so Parameter Selector bodies spawn at
  their authored poses; module disposal iterates every registered body.

Verification at this state: `npx tsc -b`, `npm test`, `npm run lint`,
`npm run build`, `npm run check:hygiene` pass. The regression matrix
(swing, sack, lift, arms, chain incl. stone break, hinges, slider, pusher,
fan set and Level 2 transfer) is exact with repeat-2 determinism, except the
pre-existing documented `stage1_pusher` IVP residual.

The finish hand-port is removed. The engine loads the exported `PE_Balloon`
graph on every level load, hosts it beside a harness-selected module graph on
Rapier (per-kind `pendingGraphs`), and passes it to the native runtime as
`finishGraph`. `OriginalFinish` and `OriginalIvpFinish` are deleted; only the
`FinishAdapter`/`IvpFinish` interfaces and the graph presentation views remain.
Harness observers now select graph modules by authored kind rather than
`graphModules[0]`, so the always-hosted ending does not mask slider/hinge/
pusher samples in hand-port runs.

Default hosting is now complete on both backends. The Rapier engine loads every
authored module graph (`DEFAULT_GRAPH_KINDS`) and creates a module for every
placement; the native runtime receives the same set as `defaultGraphs` and
builds each sector assembly from its graph. The hand-port mechanism classes
(lift, slider, arms, swing, sack, chain, hinges, pusher and the IVP lift/fan
adapters) and their inspectors are deleted. The native backend renders graph
bodies from a generic authored-mesh builder; the fan rotor and continuous
particles are driven by the graph effect binding. Lift wall cleanup is implemented for both backends through the depth test and
native `removeOnFall`. The full 87-scenario harness sweep passes on both
solvers; the representative matrix and all `stage1..12_finish_ride` runs are
repeat-2 bit-identical (438 local tests pass). Observers resolve the scenario's
selected module instance before falling back to the first placement of a kind,
so multi-placement sack/hinge/slider scenarios observe the authored instance.

Remaining: only the 2D UI behaviors, intentionally left to the React interface
(see `original-graph-runtime.md`). Restore, proximity, planar particles and
light color are implemented. The recovered OriginalUfo presentation and ending
camera are wired on Rapier as well as IVP, and the Level 12 UFO stage
assertions run on both solvers.

## 4. Ordered work queue

Do not start fan before the shared fan exporter fix and the sector lifecycle are settled.

### Phase 0 - baseline and hygiene (30 min)

1. `git status`, `git log -1`, `git diff` to confirm the 7 uncommitted files.
2. Run the verification commands in section 7.
3. Run the representative harness matrix in section 7 and record exact numbers in this
   document or `.local/reference/`.
4. Ask the user whether to commit the arms/chain WIP before any worktree-based subagent
   work. Worktrees need a commit; the current changes are not in one.

### Phase 1 - shared graph-module sector lifecycle (COMPLETED 2026-10-22)

Status: implemented and verified. Rapier bridge scenarios `stage2/3/4/8/9/10/11` are
exact; `stage6/7` are exact on Rapier and keep the pre-existing native residual. Swing,
sack, lift and arms did not regress. The original design notes below are kept for
context; the implementation details are in section 1.

Problem: Rapier graph modules exist and step in every sector. Hand-ports are inactive,
disabled, and joint-less outside their sector. This is a correctness gap for every
remaining module and the leading suspect for chain Rapier divergence.

Required behavior:

- A module is constructed at level load (so body creation order matches the hand-port) but
  starts suspended: target bodies disabled, no joints/springs/forces active, graph
  proximity not stepped.
- When `engine.state.checkpoint + 1 === module.sector`:
  - enable the hand-port-equivalent bodies/colliders;
  - create deferred joints (and fixed supports) on that tick, before the first world step;
  - run the graph; the first proximity sample uses the staged player position.
- When the active sector changes away:
  - restore target poses/velocities;
  - remove joints/springs/forces;
  - disable bodies;
  - reset runtime state so the next activation starts clean.
- The engine must call an explicit method such as
  `module.setActive(activeSector)` each tick and only step active modules.
- Keep handles across deactivation/re-activation where the hand-port does (do not
  unphysicalize/recreate unless the hand-port does). Re-run `_Init`/MF Start only if the
  hand-port's activation semantics require it; prefer reset/restart that preserves handles.
- IVP already rebuilds per sector; do not regress it. Keep its `activating` deferral.

Suggested API:

```ts
// OriginalGraphModuleInstance
setActive(active: boolean): void
get active(): boolean
// step() returns immediately when !active
```

Engine integration points:

- `OriginalEngine.addGraphModule` (construct with initial active state).
- `OriginalEngine.step` (call `module.setActive(this.state.checkpoint + 1)` before step).
- `OriginalEngine.resetSectorObjects` / checkpoint changes.
- `OriginalIvpRuntime.activate` already handles IVP; leave it.

Acceptance:

- `stage2/3/4/6/7/8/9/10/11_bridge` graph vs hand-port exact or documented residual on
  both solvers, repeat 2 deterministic.
- Existing swing/sack/lift/arms stay exact.
- No graph module for a future sector moves the ball or its own bodies before activation.

### Phase 2 - finish chain (P_Modul_29) - COMPLETED 2026-10-22

Status: implemented and verified. `originalCurrentLevelRows(level, ballFrame, activeBall)`
and `originalBallName` feed both engines; `GraphBinding.activeBall` drives the
string-aware `Test`; `Wave Player` uses `targetName()` and the authored loop input;
the IVP graph object binding now returns original-unit world state for physicalized
parts, which fixed the inner proximity. `stage2_bridge_stone` is exact on both
solvers with repeat-2 determinism.

1. Fill `CurrentLevel[0][1]` (`ActiveBall`) with `Ball_Wood` / `Ball_Stone` /
   `Ball_Paper` from the live player material. Extend `originalCurrentLevelRows(level,
   ballName?)` and both engine/IVP array resolvers.
2. Make `Test` string-aware: when both operands are strings, compare as strings; only use
   numeric comparison otherwise. Null handling must not silently compare `0 == NaN`.
3. Wire the chain's unresolved Test input A (`Pout 0`, source parameter 695) to the live
   active ball name. Preferred: expose a `GraphBinding.activeBall?: () => string |
   undefined` (or equivalent module option) and let `Test` substitute it when the operand
   is null and the other operand starts with `Ball_`. Document that `Pout 0` is the
   recovered global active-ball parameter.
4. Fix `Wave Player` to use `context.targetName()` rather than `node.target`, and pass the
   authored loop input to `audio.play`. The chain's target is `Misc_RopeTears` via
   `targetSource = 5`.
5. Add a stone bridge-break regression: stage stone, cross the inner proximity, verify the
   Platte07-Platte06 hinge is destroyed exactly once and the chain falls; compare hand vs
   graph on both solvers.
6. Re-run all bridge scenarios with repeat 2.

### Phase 3 - hinges (P_Modul_19/25/30/37/41) - COMPLETED 2026-10-22

Status: five staged fixtures (`stage2_hinge_25/30`, `stage7_hinge_37/41`,
`stage9_hinge_19`) are exact on both solvers with repeat-2 determinism, and a
local node test matches graph construction against the hand-port for all 118
placements. `authoredAnchors` and `wakeJoints: false` are enabled for all five;
IVP uses `fixedJointSupport: false`; passive hinges defer external-player
sampling during an activation restart to align their proximity poll with the
hand-port. Original design notes below are kept for context.

1. Add configuration to `src/harness/scenarios.ts` / `.local/original/harness-stages.json` for at least:
   - one P_Modul_41 (dynamic start, no proximity);
   - one each of P_Modul_19, P_Modul_25, P_Modul_30, P_Modul_37 (frozen + proximity wake).
   Use actual level placements from stages 2/7.
2. Add observer fields: hinge angle, joint presence/count, body enabled state. Add matching
   `VARIANT_COMPARE.moduleFields` entries.
3. Enable `authoredAnchors` for all five kinds (already in the uncommitted engine list).
4. IVP: set `fixedJointSupport: false` for these kinds (hand-port uses `attached = 0`).
5. Verify the graph hinge descriptors against the hand-port:
   - all limits disabled; lower/upper -45/+45 are inactive;
   - target/object2/referential/axis;
   - startFrozen true for 19/25/30/37, false for 41;
   - mass centers [1,1,0], [-2.5,.2,0], [0,4,0], [-7.5,0,0], [0,0,0];
   - groups Floor/""/Floor/""/Floor.
6. Consider matching hand-port `createImpulseJoint(..., false)` (`wakeJoints: false`) for
   start-frozen hinges if parity requires it; test before keeping.
7. `TT Restore IC` now restores the load-time visual state; the host reset still owns
   bodies. Do not rely on graph deactivation visuals.
8. Acceptance: each hinge scenario exact or explicitly documented on both solvers,
   repeat 2; then all 118 placements checked by a node test if practical.

### Phase 4 - slider (P_Modul_34) - COMPLETED 2026-10-22

Status: `stage1_slider` is exact on both solvers with repeat-2 determinism and
all assertions pass (crate pushed away, stone drops along the vertical axis,
lateral error bounded). The native frozen crate does support the stone; the
graph uses the same sleep release, direct world joint and no-wake joint
registration. Original design notes below are kept for context.

1. Enable `releaseFrozenOnWake: true` (sleep mode) and `authoredAnchors: true`.
2. Verify the prismatic anchor/axis against `original-slider.ts` (authored double origin,
   Frame01 -> Frame02 axis, limits disabled).
3. IVP: the hand-port currently never wakes the crate; determine whether the native
   `frozen` body supports the stone. Add a native crate-support test first. If it does not,
   fix both the hand-port and graph (explicit crate wake) consistently.
4. Add a harness slider scenario (approach, crate removed, stone travels, lateral error)
   and observer fields (travel, lateral error, joint present).
5. Acceptance exact/residual on both solvers, repeat 2.

### Phase 5 - pusher (P_Modul_01) - COMPLETED 2026-10-22

Status: `stage1_pusher` is exact on Rapier and retains a small native IVP residual (max pose 0.0059); gate travel/assertions pass on both. The Rapier hand-port uses authored fixed guide bodies and four solver iterations. The Phase 6 exporter flag fix (node 293 target class) is also done.


1. Resolve guide representation: graph Physicalize creates fixed bodies for Rinne/Filler;
   Rapier hand-port uses bodyless static colliders. IVP hand-port uses fixed compound
   bodies. Decide per backend and document. For Rapier parity, matching static colliders
   is likely required; add a binding/host option if necessary.
2. Match body creation order per backend:
   - graph: Rinne -> Filler -> Pusher;
   - Rapier hand: Pusher -> Rinne colliders -> Filler collider;
   - IVP hand (data): Filler -> Rinne -> Pusher.
   Prefer reordering the hand-port to the authored order where the body handles matter.
3. Match solver iterations: graph always adds 4; Rapier pusher hand-port does not.
4. Do not render Rinne/Filler helper meshes in the graph host; verify the
   `entry.geometry(!target)` relative flag at `original-graph-module-instance.ts`.
5. Add a gate scenario (closed/open traversal, travel bounds, neighboring gate untouched)
   and observer state.
6. Acceptance exact/residual on both solvers, repeat 2.

### Phase 6 - fan (P_Modul_18) - core COMPLETED 2026-10-22 (polish remains)

Status: complete. The exporter fix, Box Box Intersection, Row Search, live-ball
object/body bindings, fan visuals (collision proxy hidden, authored rotor and
Rotate referential), continuous `PlanarParticleSystem` smoke, per-frame
`TT ProximityVolumeControl` gain, live `Wave Player` loop, Activate/Deactivate
Script particle start/stop, multi-module IVP hosting and the Level 2 two-fan
transfer are implemented. All stage3..12_fan_lift scenarios and the transfer
are exact on both solvers with repeat-2 determinism. The native runtime keeps
the hand fan mesh for visuals, but graph-selected fan physics and sound are
owned by the graph; `activeFanNames` lists every active graph fan. Original
checklist below is kept for context.

First fix the export pipeline:

1. `scripts/original_chunks.py` `definition()` only reads `targetClass` inside the
   `flags & 8` branch. Node 293 (`P_Modul_18_Particle Script`, flags `0x404012`) has the
   `0x10` target-class bit but not `0x8`, so its children/links/inIO are dropped. Decode
   target class independently of the version bit; re-export locally.
   Acceptance: 293 has children [175,188,281,286], links 287-291, inIO 292; roots become
   [82,293,658].
2. Implement missing behaviors:
   - `Box Box Intersection` using `originalBox`/`originalBoxesIntersect`;
   - `Row Search` for the four-slot ActiveSounds array.
3. Wire the player/ball into graph physics:
   - fill `CurrentLevel[0][1]` (ActiveBall);
   - bind `Ball_Pos_Frame Frame` to the live player;
   - make `Get Cell`/`SetPhysicsForce` target the player body (module bodies map alone
     cannot resolve it).
4. Force referentials: `positionRef` is the live ball object (`Cell Value`); treat
   `positionRef === target` as body-local before resolving a frame. Treat unresolved
   `"Direction Ref"` as no referential, not an error.
5. Force controller identity must include the module instance (not target+node alone) so
   multiple fans can overlap and target changes destroy the old controller. Add IVP
   reset/dispose that removes all controllers, and detach graph fan controllers before
   player capture/respawn/material changes.
6. Sector lifecycle and multiple fans: Rapier graph modules must respect sector; native
   IVP currently has one `graphModule` slot and always creates hand-port `OriginalIvpFan`
   even when graph-selected. Refactor IVP to an array of graph modules and skip the
   hand-port fan for the selected placement.
7. Visuals/particles/audio:
   - position all authored module meshes at catalog transforms (not only Physicalize
     targets); respect `visible`;
   - resolve Rotor via its authored frame/axis; `Rotate` currently ignores the referential;
   - implement `PlanarParticleSystem` continuously with authored parameters and no
     effect stub;
   - map `Misc_Ventilator_01..04` to the available sample or extract the slots;
   - extend audio binding with gain; make `TT ProximityVolumeControl` apply it and
     normalize distance by `coordinateScale`;
   - make `Wave Player` use `targetName()`.
8. `Activate Script` / `Deactivate Script`: currently only gate future activations. They
   must start/reset/stop the named particle script (or document a faithful minimal
   implementation).
9. Harness: generated `stageN_fan_lift` scenarios exist for stages 4-12; add a module
   selection to `stage3_fan_lift` and a graph-capable Level 2 two-fan transfer scenario.
   Observer `activeFanNames` must include graph fan state.
10. Acceptance: fan-lift graph vs hand-port exact or documented on both solvers, repeat 2;
    transfer scenario where available.

### Phase 7 - finish/remaining and hand-port removal

1. Migrate `PE_Balloon` finish/ending modules and any remaining gameplay graphs
   (check the behavior matrix and `.local/reference/graph-coverage.md`).
   `PE_Balloon` still needs graph hosting on both backends and a same-solver
   finish/ride comparison; its hand-port remains the oracle.

   Rapier progress: the finish graph now loads. `physicalizeBody` falls back to
   the target's own mesh when a Parameter Selector leaves the Convex input
   unset, all document objects cache their own hull for runtime retargeting,
   missing single-hull inertia falls back to the collider mass path used by the
   finish hand-port, and joints now carry the authored node index so several
   hinges may target one body and a destroy releases only its own hinge (the
   platform has five). The finish graph also creates its bodies, joints,
   forces, spring and wake at the authored ticks. It is not exact yet: the
   platform never departs in the harness (slide/platform constrained at rest),
   so finish harness scenarios still select the hand-port. The graph finish
   adapter (`original-graph-finish.ts`) currently only mirrors the recovered
   approach/boarding presentation transitions. IVP still constructs
   `OriginalIvpFinish`.
2. For each family, after both-solver repeat-2 parity: delete the hand-port branch from
   `original-engine.ts` / `original-ivp-runtime.ts`, remove its data if now unused, and
   update docs.
3. Definition of done:
   - every behavior used by gameplay is decoded and implemented;
   - every level's modules run from authored graphs;
   - all emitted harness scenarios pass on both solvers with repeat-2 determinism;
   - hand-ports are removed;
   - `npx tsc -b`, `npm test`, `npm run lint`, `npm run build`,
     `npm run check:hygiene` pass.

## 5. Subagent playbook

Use subagents where the work is separable. They share the working tree, so writes must be
serialized or isolated.

### Research (parallel, read-only)

Use 2-3 `explore` agents on disjoint modules. Prompt them to:
- not edit files, not run harness/tests, not launch `Player.exe`, not commit;
- map graph execution order, Physicalize/joint/spring/force/proximity payloads, hand-port
  construction/activation/reset, current binding gaps, harness scenarios;
- return file:line references and a dependency-ordered checklist.

This worked well for hinges+pusher/slider, arms+chain, and fan. Keep reports focused; ask
for tables rather than prose.

### Implementation (serial by default)

Because every module touches shared files (`original-graph-physics-*.ts`,
`original-graph-module-*.ts`, `original-engine.ts`, `original-ivp-runtime.ts`,
`original-harness/*`), run one implementation agent at a time in the main tree:

- Give the agent the relevant dossier from this document and the exact acceptance command.
- Require it to run `npx tsc -b` and the module's local test/harness before returning.
- The coordinating thread reviews `git diff`, runs the full verification, and fixes
  integration. Do not let subagents commit.

If true parallel implementation is needed, use isolated worktrees **only after the WIP is
committed**:

```powershell
git worktree add .local/worktrees/<name> -b <name> HEAD
# worktrees lack node_modules and gitignored .local assets:
cmd /c mklink /J .local\worktrees\<name>\node_modules node_modules
cmd /c mklink /J .local\worktrees\<name>\.local\original .local\original
```

Merge back serially; expect conflicts in shared files. Prefer serial main-tree writes.

### Verification ownership

The coordinating thread (not the subagent) must run the final matrix, update
`docs/original-graph-runtime.md` / this handoff, and decide whether a residual is
acceptable. Never loosen the global comparator. A scenario-specific `variant` tolerance is
allowed only when documented with a measured bound (precedent: `LIFT_VARIANT`).

## 6. Per-module recovered details (quick reference)

### P_Modul_29 chain

- Graph roots: `_Init` 49, MF 727.
- Physicalize order: Platte01..Platte09 (Platte09 mass 1, others .5); friction .7,
  restitution .4, group `Modul29`, startFrozen true, damping .1/.3, one hull each.
- Hinge create order: 116,277,259,241,223,205,169,151,133,187; all
  `PlatteNN -> previous` or FixCube, limits disabled.
- Outer proximity: distance 80, object `P_Modul_29_MF`, axes 5, output mask 4, exactness
  85-100, delays 10/60; EnterRange -> WakeUp Platte04 (which wakes the island in IVP).
- Inner proximity: distance 4, object Platte06, axes 7, output mask 4, exactness 8-20,
  delays 2/30; then Get Cell col1 (`ActiveBall`), Test `== "Ball_Stone"`, destroy hinge
  187, play `Misc_RopeTears`.
- Hand-port: fixed body at parent origin; parts data order now authored; joints created on
  sector activation; wake releases all parts dynamic+wake; release uses live Platte06
  position + material.
- Graph bridge trajectory is exact on Rapier (all nine bridge scenarios plus the stone
  break) and on IVP for stage2/3/4/8/9/10/11 and the stone break; stage6/7 keep the
  native ordering residual.
- ActiveBall, string `Test`, live-target `Wave Player` and the stone-break regression are
  complete (Phase 2).

### P_Modul_19/25/30/37/41 hinges

| Kind | Target | Mass | Group | Start frozen | Mass center | Wake |
| --- | --- | ---: | --- | :---: | --- | --- |
| 19 | P_Modul_19_Flaps | 3 | Floor | yes | [1,1,0] | 50 |
| 25 | P_Modul_25_Bridge | 3 | "" | yes | [-2.5,.2,0] | 50 |
| 30 | P_Modul_30_Wippe | 3 | Floor | yes | [0,4,0] | 50 |
| 37 | P_Modul_37_Bridge | 3 | "" | yes | [-7.5,0,0] | 50 |
| 41 | P_Modul_41 | 1 | Floor | no | [0,0,0] | none |

All: friction .7, restitution .4 (25/37 = 1.0), damping 1/.05 (41 = .1/.1), one hinge
target->FixCube with frame `<kind>_HingeFrame`, limits disabled, -45/+45 inactive.
Hand-port IVP uses `attached = 0`; graph must use `fixedJointSupport: false`.

### P_Modul_34 slider

- Bodies: Kiste mass 1.4/friction .8, Schiebestein 1.6/.5, both restitution .4, damping
  .1/.1, group "", startFrozen true, one hull.
- Slider target Schiebestein -> FixCube, Frame01/Frame02, limits disabled (-1/+1 inactive).
- Proximity distance 50, object Schiebestein, axes 5, mask 4; wake Schiebestein.
- Hand-port releases the crate Dynamic+sleep on wake; graph needs
  `releaseFrozenOnWake` (sleep) + `authoredAnchors`.
- No harness scenario yet; add one.

### P_Modul_01 pusher

- Graph order Rinne -> Filler -> Pusher.
- Rinne/Filler fixed, group Ball/Floor; Pusher dynamic mass 3, .6/.4, damping .1/1,
  startFrozen true, group Floor.
- Proximity distance 50, object Pusher, axes 5, mask 4; EnterRange -> WakeUp Pusher.
- No joints/forces/springs.
- Rapier hand-port: Pusher body first, then bodyless static colliders for Rinne/Filler; no
  extra solver iterations. IVP hand data order Filler -> Rinne -> Pusher.
- No harness scenario yet.

### P_Modul_18 fan

- No Physicalize/wake nodes. Physics is one persistent `SetPhysicsForce` on the player,
  driven by an OBB test and three proximities.
- Missing behaviors: `Box Box Intersection`, `Row Search`.
- Exporter bug: node 293's children/links/inIO are dropped because of the `0x10` vs `0x8`
  flag parsing.
- Force target: `CurrentLevel[0][1]` ActiveBall (currently -1). Force positionRef is the
  live ball object; directionRef is the literal `"Direction Ref"`.
- Outer/sound/force proximity settings: distance 80 / 25 / 7; masks 12 / 12 / 5; axes 5 /
  7 / 5; exactness 85-100 / 25-30 / 12-20; delays 10-60 / 1-10 / 1-10.
- Hand-port per-fan force/particles/audio; IVP uses persistent `world.force`.
- No graph fan state in `activeFanNames`; IVP double-applies because hand `OriginalIvpFan`
  is always created.

## 7. Verification commands

```powershell
npx tsc -b
npm test
npm run lint
npm run build
npm run check:hygiene
```

Representative harness matrix (use `--repeat 2` before declaring parity):

```powershell
npm run harness -- stage8_swing --solver both --sources hand-port,graph --repeat 2
npm run harness -- stage8_sack --solver both --sources hand-port,graph --repeat 2
npm run harness -- stage9_lift --solver both --sources hand-port,graph --repeat 2
npm run harness -- stage7_arm --solver both --sources hand-port,graph --repeat 2
npm run harness -- stage9_arm_2 --solver both --sources hand-port,graph --repeat 2
npm run harness -- stage2_bridge --solver both --sources hand-port,graph --repeat 2
npm run harness -- stage6_bridge --solver both --sources hand-port,graph --repeat 2
```

Full bridge set: `stage2/3/4/6/7/8/9/10/11_bridge`.
Lift set: `stage7/9/10/12_lift`.
Fan set: `stage3/4/5/6/7/8/9/10/11/12_fan_lift` (exact both solvers).

Acceptance rules:

- Same-solver graph vs hand-port is the primary gate.
- Prefer exact 0. A residual needs a measured bound and an explicit scenario `variant`;
  never relax `VARIANT_COMPARE`.
- `--repeat 2` must be bit-identical per source/solver.
- Assertions must pass on both solvers.

## 8. Known dead ends / do not repeat

- Reversing sack/lift recovered data without matching the authored execution order did not
  help; order only matters when it matches what the graph actually does.
- `wakeJoints`, `deferJoints`, and `enableAtFirstStep` were tested on the chain and did not
  change the Rapier bridge divergence; the sector lifecycle was the fix. The latter two
  were removed when the lifecycle was added.
- Do not restart an intact load-time module script on first activation: the authored
  `Physicalize` chain re-runs after a WakeUp and re-freezes planks the script just
  released. Restart only when the runtime state was reset (deactivation, `stagePlayer`,
  respawn).
- Do not restore authored start-frozen body kinds after running activation scripts. Restore
  them in `suspend()` and let the script's WakeUp decide which bodies stay dynamic.
- Do not expose IVP visual meshes as graph object positions: they are in render space and
  break original-unit proximities. Physicalized graph parts must sample `IvpWorld.state`.
- Do not use float32 rounding on world pivots before building local anchors.
- Do not use Rapier `JointData.spring` for recovered springs; use `springImpulse`.
- Do not reuse a hull mesh's baked points across differently rotated target bodies.
- Do not silently skip missing Data Arrays; modules become inert via the Not Found branch.
- Do not compare raw quaternions without normalization.
- Do not launch `Player.exe` or use it as a live oracle.

## 9. First actions for the new thread

1. `git status`, `git log -1 --oneline`, `git diff --stat`; confirm the fan core and
   Phase 5 are committed and Phase 6 polish/Phase 7 remain.
2. Run section 7 baseline commands.
3. Run `stage4_fan_lift` both sources/solvers repeat 2 to reproduce the fan numbers.
4. Finish fan polish: smoke particles, rotor/audio gain, Activate/Deactivate Script,
   overlapping fans and the Level 2 two-fan transfer scenario.
5. Phase 7: migrate `PE_Balloon`/finish and remove each matched hand-port.
