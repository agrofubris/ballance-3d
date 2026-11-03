# Rendering diagnostics (local only — do not copy to shareable until a fix validates)

Running list of renderer findings with confidence. Classes: confirmed global,
likely material/texture-class, effect-specific, unresolved.

## Confirmed global

- Stereo/mono geometry equivalence at separation 0 (prior session).
- Texture decode semantics dominate flat-texel additive response: linear-0.25
  saturates, sRGB-0.25 nearly invisible (prior constant-gray sweep).
- Frozen-frame determinism: background pixels bit-identical across texture
  swaps in the same session (this run, r>25 rings MAD 0.0000).

## Likely material/texture-class (medium confidence on key, low on treatment)

- `ONE,ONE` (`sourceBlend,destBlend` = 2,2) is a 7-material micro-class
  game-wide: `Ball_LightningSphere#185`, `AnimTrafo_Flashfield#79`,
  `M_Keys_Highlight#79`, `I_Laterne_Verlauf#141`, `PE_UFO_Flash#134`,
  `P_Extra_Life_Schatten#62`, `ShadowPolyBig#66` (offline scan of
  `.local/original/*.json`, 642 materials).
- Lightning is the only textured-MODULATE (`textureBlendMode` 2) member of
  that class with black diffuse + white emissive. Candidate data-driven key
  for any future gamma-data rule is `(sourceBlend,destBlend)==(2,2)` on
  extracted material state — NOT filenames. Open: dark-tinted shadow polys
  share the blend key, so the rule may need a diffuse/emissive qualifier.

## Effect-specific: energy-ball frozen age 1.5 (this session)

Rig: one persistent `chrome-headless-shell` lifetime, vite dev, Rapier,
`?spawnDiag=1` temp hook (reverted), mono DPR 1, 800x600, frozen
`begin+update(1.5)` (texture slot 0 = Lightning1), 3 s camera settle,
2x2 decode x filter in one session. ROI: fixed 140x140 box + border-ring
background estimate + fixed 280x280 box; both oracle-independent.

Texture facts (offline PIL): Lightning1-3 are 64x64, bright — raw mean
0.49-0.54, median 0.46-0.60; sRGB decode drops median to 0.18-0.32, mean
only ~18%. The constant-sweep mid-tone-crush premise does NOT transfer
wholesale: this effect lives in bright texels.

Render facts (shell r<25 px, bg ~0.75 sky/track):

| variant | masked mean | frac>0.95 | ring deltas vs A |
|---|---|---|---|
| A srgb/linear (baseline) | 0.8816 | 0.2838 | — |
| B none/linear | 0.8845 | 0.3038 | +0.04..+0.07 |
| C none/nearest | 0.8836 | 0.2983 | +0.02..+0.05 |
| D srgb/nearest | 0.8783 | 0.2751 | -0.02 |

Masked MAD vs A: B 0.0029, C 0.0024, D 0.0040. Captures:
system-temp `spawn-*.png` (gone with reboot).

Reading: NoColorSpace lifts the shell core ~5-7% and expands the white
core ~2 pp — directionally toward "restores intensity" but NOT a halo
rescue. No oracle frames exist locally, so oracle match is unconfirmed.

## Unresolved

- Oracle ground truth for the spawn halo (no local oracle captures).
- Better global exemplar than the energy ball: mid-tone additive FX
  (smoke/flame/UFO flash) where decode deltas should be larger.
- MODULATE (2) vs mode-4 (489 materials) stage semantics; per-stage vs
  final clamping; vertex-color modulation; emissive/ambient/lightmap
  scaling; alpha-channel semantics; filtering/mip; fog ordering;
  framebuffer/output gamma. Probe only when a cheap distinguishing test
  exists — no speculative 30-minute runs.

## Decision

No validated fix yet: effect size is small and oracle confirmation is
missing. Temp `__spawnDiag` hooks reverted; tree clean. Do NOT encode a
global `ONE,ONE` rule on this evidence alone.

## Browser-gate rule (agreed)

No 30-minute browser run without BOTH a promising texture histogram AND
an oracle frame.

## Mid-tone candidate ranking (offline, 72 textures, system-temp script)

Alpha-weighting turned out to be ~plain luminance: only `DomeShadow` and
`Trafo_Shadow_Big` PNGs carry alpha (all-dark masks for `(5,6)` blend).
Mid = fraction of texels in 0.15-0.6 encoded RGB.

| rank | texture | mid | users / blend | freeze |
|---|---|---|---|---|
| 1 | `Laterne_Verlauf` (16x16 gradient) | 0.562 | menulevel `(2,2)` + levels `(5,6)` w/ port `emissiveIntensity 2` name-hack | static lamp, trivial |
| 2 | `P_Extra_Life_Shadow` | 0.440 | `(2,2)` decal | static |
| 3 | `Trafo_FlashField` | 0.352 | `(2,2)` transformer flash | transient, hard |
| 4 | `Particle_Smoke` (64x64) | 0.340 | port-side `AdditiveBlending` (no JSON material) | proven (spawn burst) |
| 5 | `FloorGlow` | 0.334 | `(2,2)` ShadowPolyBig | static |
| 6 | `Misc_UFO_Flash` | 0.305 | `(2,2)` | UFO-event, hard |
| 7 | `ExtraParticle` | 0.252 | point-trail `AdditiveBlending` | needs motion history |

Demoted: Lightning ~0.19 (falsified as probe), `Particle_Flames` 0.074
(dark-dominated, hot core saturates either way), `Button01_special` 0.200
(menu UI), `P_Extra_Life_Particle` 0.411 but orphan (no users in code or
JSON), `P_Extra_Life_Oil` 0.414 but `(2,5)` and already `NoColorSpace` in
`original-collectibles.ts` (class-rule precedent, not evidence).

Note: the `Laterne_Verlauf` `emissiveIntensity = 2` hack in
`original-data.ts` is name-matched — exactly the kind of filename
special-case a validated class rule should eventually replace.

## Next run (gated on oracle frame)

Candidates 1 and/or 4. Axes: `SRGBColorSpace` vs `NoColorSpace`, plus one
cheap stage-math variant in the same lifetime (e.g. x2 sampled-texel gain
as MODULATE2X proxy via material color multiplier). Effect-only ROI with
mid-tone area/coverage metric, not p999.

Oracle gap: no oracle frames exist locally. Original media is extracted
(`.local/iso-extract/.../Bin/Player.exe` — Virtools player); getting a
reference screenshot out of it is the gating work item. Energy ball stays
parked — it has yielded what it was going to yield.

## Oracle acquisition log

- Real install found: `C:\Games\Ballance` (registered, ran fine 00:10 today
  per `LogPlayer.csv`: DX 4.9.0.904 OK). Registry
  `HKLM\SOFTWARE\WOW6432Node\Ballance\Settings`: `FullScreen=1`,
  `VideoMode=0x5a00438` (=1440x1080, HIWORD/LOWORD), `TargetDir`,
  `SrcDir=F:\Setup`, `SrcDisc=F:`, `Language=2`.
- Extracted `Player.exe base.cmo`: stays windowed, blocked by CD check
  ("Introduce el CD-ROM..."). No CD-ROM drives present; ISO media dir holds
  only installer cabs.
- Installed `Player.exe`: goes fullscreen-exclusive 1440x1080 then exits;
  outcome unseen (no new `errorPlayer.csv`). Display recovered cleanly.
- Blocker: not elevated, so `FullScreen=0`/`VideoMode` tweak needs the user
  (`.reg` pair in system temp: `ballance-windowed.reg` 800x600 windowed,
  `ballance-restore.reg` restores 1440x1080 fullscreen).
- Render config note: `CK2_3D.ini` `EnableScreenDump` set to 1 on the
  extracted copy (backup `CK2_3D.ini.orig`) — CTRL+ALT+F10 dumps
  screen/depth/stencil to the drive root once the game boots.
- Renderer-wide side finding (keep): alpha carries almost no effect
  intensity in this asset set — only two all-dark mask PNGs use alpha, so
  legacy glow/particle energy is overwhelmingly RGB-encoded.
- ORACLE PIPELINE PROVEN: installed `C:\Games\Ballance\Bin\Player.exe`
  `O:\base.cmo` (cwd `O:\`, via `subst O:` so dumps land writable) renders;
  `EnableScreenDump=1` in installed `CK2_3D.ini` (backup `.orig`) +
  CTRL+ALT+F10 writes `CKScreenShot_Color.bmp` to the drive root. First
  frame: Spanish main menu over live MenuLevel backdrop, lamps visible.
- Surprises: dump is 1920x1080 RGB despite registry `VideoMode=0x5a00438`
  (record actuals, not guesses); dump filename is fixed
  (`CKScreenShot_Color.bmp`) — relocate between presses for consecutive
  frames; only color dump appeared (no depth/stencil files).
- Still to do: drive menu to Level 1 start (blind, dumps as eyes),
  consecutive-frame static check on the lamp, fixed lamp ROI + repro steps.
- SAFETY INCIDENT: self-driven fullscreen launch wedged the display (black
  screen, Alt+Tab dead, high GPU, user had to restart Windows). Rules from
  now on: NEVER launch Player.exe from automation; exclusive-fullscreen DX8
  on this machine can seize the session. Oracle capture is user-driven only
  (or windowed mode if the user ever approves the .reg). subst mapping did
  not survive the reboot — re-create per session if needed.
- SECOND INCIDENT: windowed mode (FullScreen=0, 800x600 via user-approved
  .reg) ALSO wedged (black screen over desktop+mouse, Ctrl+Alt+Del to kill).
  Suspects: the 800x600 VideoMode change, my EnableScreenDump=1 ini edit, or
  general DX8-init flakiness (Sept-10 NemoContext errors on record). Both
  ini edits reverted to .orig by me; registry restore left to the user
  (`ballance-restore.reg`). No automation launches until the game boots
  cleanly by hand again. Fallbacks if manual boot stays broken: dgVoodoo2
  wrapper (user-downloaded), or park binary oracle entirely.
- RESOLUTION: manual boot after full restore works fine — the wedges came
  from my side (800x600 mode and/or automation launching). ScreenDump
  re-enabled on the installed ini by file edit; user captures via
  a desktop launcher batch file (CRLF, subst O: + launch so
  dumps land writable in the game dir). Diagnostics rule stands: no
  automation launches of Player.exe, ever.
- THIRD INCIDENT: manual boot with ONLY EnableScreenDump=1 as delta wedged
  again (black fullscreen, session kill). Hook is now off for good
  (installed ini reverted to `= 0`, verified; launcher .bat deleted).
  Note Sept-10 NemoContext init errors predate all my edits, so some boot
  flakiness may be inherent — but my edits correlate with 3/3 wedges, so no
  more game-file modifications, period.
- New capture plan: zero-modification OS-level screenshots (Win+PrtScn to
  Pictures\Screenshots) of the Esc-paused Level 1 lamps. Slightly less
  exact than framebuffer dumps, plenty for an ROI decode comparison.
- ORACLE IN HAND: `.local/oracle/oracle-lamp-01.png` (1440x1080 RGBA,
  Win+PrtScn, user-captured, Level 1 tutorial start). Fixed ROIs carved by
  saturated-yellow connected components +60px margin:
  lamp-left (232,200,384,352) mean 0.566 median 0.526 midband(0.15-0.6)
  0.578 frac>0.85 0.164; lamp-right (1076,200,1224,352) mean 0.550 median
  0.518 midband 0.539 frac>0.85 0.078. ROI crops `roi-lamp-*.png` alongside.
  The oracle lamp glow lives exactly in the decode-sensitive mid-range.
- Lamp material facts (level_01 #271): diffuse black, emissive 0.231 gray
  (exact, both files), AlphaBlend+AlphaTest, TwoSided, (5,6) SRC_ALPHA blend
  in levels but (2,2) ONE,ONE in menulevel (#141, same texture/mode-4).
  Source is .TGA but converted PNG has no alpha (pipeline preserves alpha
  elsewhere, so the TGA is 24-bit). Port name-hack forces AdditiveBlending
  + emissiveIntensity 2 + alphaTest 0 — i.e. current render follows the
  MENU blend path with a x2 gain of unknown provenance. Mode 4 (489 mats)
  is a MODULATE2X suspect for that x2. The (5,6)-vs-additive deviation is
  queued as its own hypothesis AFTER the decode question.
- LAMP VERDICT (demotion branch): one-lifetime 3-variant batch
  (A sRGB/x2, B NoCS/x2, C NoCS/x1) on frozen Level-1 spawn view, 800x600
  mono. Port lamp ROI found by the same yellow detector as oracle. Deltas:
  decode A->B +0.008 mean / +0.02 f085; gain B->C -0.004 mean (core
  clipped p99=1.0, x2 only moves the fringe). Nested oracle boxes show the
  lamp core at mean ~0.63 both sides; port core matches on mean but carries
  a hotter white tail (left f085 0.36 vs 0.25) and cooler hue (R-B 0.12 vs
  0.25, blue 0.49 vs 0.36). NoCS moves away from oracle, minutely.
  DEMOTED: texture color-space semantics -> "known mathematical difference
  the assets don't depend on." Remaining lamp suspects, in order:
  additive-vs-(5,6) port hack, Laterne_Glas emissive-1.0 core, 16-bit
  _16_ARGB1555 output quantization.   Temp lamp hooks reverted, tree verified
  (tsc/oxlint/spawn+stereo tests green). Captures in system temp.
- BMap probe (read-only, the installed game): lamp #271 AlphaFunc=5 (GREATER)
  AlphaRef=1/255; textureBlendMode=4 in BOTH files (mode 4 is the default
  textured mode, 489 mats — NOT a x2; the port's emissiveIntensity=2 is an
  ungrounded guess); UVs span U[-0.125,1.0] V[-0.98,1.84] with WRAP (Repeat
  correct); Verlauf lives inside big tower meshes (A01..A04_Tower, up to
  1304 verts, 10 material slots) — opaque gradient surfaces, not floating
  quads. No vertex-color API in BMap (untestable); no color-key API.
- Video formats decoded via LibCmo21 VxEnums: lamp TGA=1=_32_ARGB8888
  (full precision — lamp exempt from quantization); ordinary BMP
  diffuse=6=_16_ARGB1555 (5-bit/channel quantized). 16-bit stays third
  priority, for diffuse — not lamps.
- Batch queued (one lifetime): A current additive-hack x2; B extracted
  (5,6)+x1+alphaTest0.4+depthWrite (full hack removal; predicts opaque
  gradient columns); C (5,6)+x2 (blend isolated, gain held); D A with
  Laterne_Glas emissive off (glass-core test).
- BLEND VERDICT: B renders the lamps as dim opaque gradient columns (no
  black-box disaster). Numbers, same-pixel boxes, oracle-anchored — left
  (oracle mean 0.566 f085 0.164): A 0.625/0.363, B 0.545/0.281, C
  0.553/0.281, D ~= A. Right (oracle 0.550/0.078): A 0.548/0.159, B
  0.476/0.089, C 0.484/0.089, D ~= A. So (5,6) fixes f085 (+0.20->+0.12
  left, +0.08->+0.01 right) and midband, at the price of mean -0.01..-0.07.
  Glass-off ~= hack: the white core is NOT the tail driver (clean
  negative). B vs C indistinguishable: x2 is dead weight, drop it.
  PROPOSED PATCH (not applied): delete the `Laterne_Verlauf` name-hack in
  `original-data.ts` so extracted (5,6)/alphaTest0.4/ZWrite/intensity-1
  apply. Residual right-side dimness stays open (composition noise vs real;
  needs pixel-registered comparison). Hooks reverted, tree green.
- PATCH APPLIED ("Use recovered lantern material state"): name-hack line
  deleted from `OriginalMaterials.create`; extracted state now flows
  through (NormalBlending=(5,6), alphaTest 0.4, depthWrite true, gain 1).
  Glass untouched, no dimness compensation. tsc/oxlint/import+spawn+stereo
  tests green. Residual right-side dimness is a NEW bug with its own tree
  (lighting vs stage vs geometry) — fresh baseline capture required.
- ISOLATION MATRIX (P/G/T/L, one lifetime, patched tree, hooks reverted):
  T == P to 3 decimals (specular/lighting contribute ~0; texture stage
  introduces no asymmetry — T branch clean, stop spoke respected).
  L shows no independent asymmetry. G carries the same left-right gap as P
  (0.075 vs 0.068) under uniform white input with zero texture/lights.
  Coverage fractions equal (13.2% vs 12.2%) but hot-pixel share halves on
  the right (G f085 0.40 vs 0.20): from the port spawn-cam the right lamp
  presents less Verlauf area (rail occlusion/perspective), while the oracle
  tutorial-cam frames both evenly. Centroids match everywhere (0.48-0.51).
  VERDICT: G fires -> geometry/coverage, i.e. the residual is a viewpoint
  comparison artifact between two different camera shots, not a material,
  lighting, texture-stage, or glass bug. No renderer change indicated.
  METHODOLOGY NOTE (do not rediscover): oracle tutorial framing is NOT
  camera-equivalent to the port spawn view. Left/right lamp brightness is
  not a valid fidelity metric unless viewpoint is matched — the port
  spawn-cam partially rails the right lamp while the oracle tutorial-cam
  frames both evenly. Lamp branch closed: blend fixed via extracted (5,6),
  glass/gamma/gain cleared, residual assigned to comparison methodology.

## Stone-bridge probe (Level 1 ending bridge, stone full-throttle)

- Oracle (native IVP, node, scripted): wood boards at tick 356; stone
  leaves the deck at tick ~233 and falls to -917. Throttle sensitivity:
  stone release@100 still falls (deck@250), release@60 rests short.
  Falling is consistent original behavior, not yet a mismatch.
- Rig lessons (staged browser, reverted): raw NMO units vs scaled Rapier
  units (x*4/y*4/-z*4 duality in moveNativeCaptured/syncNativePlayer) —
  stage in raw, convert per backend; native staging must go through
  native.reset (Rapier-body teleports get dragged back by syncNativePlayer);
  native drive is camera-relative (arrowup=+x here, rapier arrowdown=+x);
  SwiftShader clock skew is large (native ~3x fast-forward, rapier
  slow-motion) — compare spatial paths, never wall time.
- FIRST DIVERGENCE at x~711-714 (gap 2.79 at 713, same start pose all
  three runs): native stone sinks/slides -z off the deck; rapier stone
  stays centered at deck height. Drive is pure +x (balloon frame), so the
  -z slide is contact/rolling dynamics, not drive.
- Geometry: A04_Floor_03 deck is a narrow CROWN (ridge z~-873.9, flanks
  (0,0.963,+-0.27) ~15.7 deg, 5 wide, ball diameter 4). mu-eff stone .35
  vs wood .56.
- Friction isolation (native, mutated table, no source edit): stone/mu.8
  falls identically (deck@232, z -880.8); wood/mu.5 still boards (445).
  Drift follows MATERIAL, not friction magnitude. Branch: NOT
  geometry-values, NOT material-values -> SOLVER/INTEGRATION
  (crown-slide/ridge-seam friction dynamics under stone mass/drive).
- Open within-branch: drive-strength-per-physics-second in Rapier (no time
  base was captured — needs a step counter) vs solver iteration count vs
  ridge-seam normal handling. No tuning. Hooks reverted, temp node probes
  deleted, tree green (tsc/oxlint/physics+player tests).
- GEOMETRY-SET FINDING (code + geometry, no runtime needed): the Rapier
  engine bakes ALL generic module visuals as permanent static colliders at
  load (`addModule` fallthrough: everything except Shadow/PE_UFO/
  PE_Box_slide/trafo/flames). For PE_Balloon_01 that means the 8 entry
  plates (x 710.1-723.0, y -14.0..-13.4, z -876.4..-871.4 — exactly
  continuing the A04 deck that ends at 709.7), the platform, the balloons
  and the ropes. Native spawns them as managed bodies on final-sector
  activation only (ropes/balloons collision-disabled; platform departs via
  hinge release). Rapier reachedFinish is pure proximity -> completeCourse
  (no ride). So Rapier has ghost floors where native has void-or-managed,
  and no departure. This contaminates any crossing comparison past x~710
  independently of the solver branch. Fix decision needs a Rapier-ending
  audit first (what, if anything, relies on the baked statics).
- Bridge verdict: FIRST DIVERGENCE x~711-714 (gap 2.79 at 713, identical
  starts). Chain: geometry-data crown confirmed (15.7 deg flanks) ->
  material-values cleared (mu-matrix) -> SOLVER/INTEGRATION for the crown
  slide + GEOMETRY-ASSEMBLY for ghost PE_Balloon statics. No tuning done.
- SOLVER TREE (all in order, all temp, all reverted): speed parity CONFIRMED
  (rapier x@310 = 731.5 vs node x@330 = 733 — drive out); wood validation
  PARTIAL (boards+departs in-engine via adapter, falls at speed — sustained
  slow ride still unshown); epsilon: rapier neutral (offsets +/-1e-3 persist
  unchanged, flanks roll downhill into grooves and settle — healthy lateral
  physics, no active stabilization); native microperturbation DETERMINISTIC
  -z walk from ANY start in +/-1e-2 (not chaos); native vz=+5 goes +z and
  stays (seed-sensitive, not forced); rapier vz=+/-5 preserved symmetric
  (no centering). Contacts: rapier nz=0 persistent pair; native single -z
  tilt at step 0, symmetric cruise with creep, -z edge contacts on exit.
  Iterations 1/2/8/16 invariant. FIRST ACTUAL MISMATCH = step-0 contact
  resolution: single tilted contact (IVP, -z seed, walks) vs balanced pair
  (Rapier, neutral seed, locks); both solvers then propagate seeds
  faithfully. Likely mechanical cause flagged (not proven): f32 vs f64
  penetration rounding at identical placement. No manifold surgery, no
  tuning. Hooks + all probe files removed; tree green.
- PROCESS HYGIENE (do not rediscover): `taskkill /F /IM chrome-headless-shell.exe`
  WITHOUT `/T` leaves renderer/GPU child processes behind across sessions
  (a 629 MB SwiftShader session spun the fans); always kill with `/T`,
  verify with tasklist, and kill vite (by PID, never blanket node.exe)
  plus headless chrome after EVERY browser run, not just at phase end.
- SPLIT (work order): mismatch A = collider lifetime/scene assembly
  (deterministic structural bug, fix exactly, own commit, no solver
  changes); mismatch B = crown-slide outcome on correct geometry
  (solver/manifold discrepancy, investigate don't tune). Priority 1 =
  Rapier-ending audit (map every generic visual to permanent-static /
  managed-on-activation / non-colliding; trace platform activation->ride->
  departure->removal; find dependents on ghost statics; compare RENDER vs
  COLLIDER ownership separately — no invisible duplicates). Priority 2 =
  rerun same probe post-fix, then speed->epsilon->contacts->iterations.
  Awaiting audit checklist.
- ADAPTER SHIPPED + PROBE RERUN: Rapier finish adapter implemented
  (managed plates/platform-proxy/balloons/ropes/slide, joints, forces,
  spring, approach/boarding/departure/reset, boarding ride + sky fade +
  timed complete), 3 lifecycle tests green, full suite 233 pass (only the
  3 pre-existing replay-build failures), build green. Post-fix rerun:
  ghost ride GONE (stone falls, no 40 s deck cruise); managed plates
  support to x=723; approach/boarding triggers fire in-engine (drive keys
  cleared at x~726, departure begins); residual vs node is now ONLY the
  crown-slide lateral (node veers -z from 711, rapier straight, falls
  ~726+). Clean solver-branch baseline established. Open next: wood
  ride-through validation in Rapier, then speed->epsilon->contacts->
  iterations. Temp probe hooks reverted and verified out of tree.
- ENDING AUDIT (deliverable): 17 corridor objects + Box_slide control.
  Native classes from finish-data.json: 8 plates = managed-static
  (mass .5, Floor, frozen, enabled, own convex mesh); platform =
  moving-managed (mass 4, Floor, frozen->wake->departing->removed, SIX
  PROXY hulls Col_01..06, COM(0,2,0), ride by contact, hinge 524 release);
  4 balloons + 4 ropes = visual-only (mass .2, collision DISABLED, forces
  move them); Box_slide = hidden control (collision disabled).
  Activation: approach 70XZ (10-frame countdown) -> wake platform + 8
  forces (ready); boarding 1-unit XYZ -> departure force + destroy hinge
  524 (departing, input stops, ball rides contact); reset/sector-leave
  removes all bodies. Visuals always visible both paths EXCEPT Box_slide
  (hidden native via syncVisuals, VISIBLE in Rapier = minor visual bug).
  Rapier bake (`addModule` generic fallthrough, per-object trimesh at
  level load, NOT monolithic): all 17 baked SOLID permanent (incl.
  balloons/ropes that must never collide; platform baked from VISUAL mesh
  instead of proxy hulls). No Rapier managed bodies exist (proximity ->
  completeCourse, no ride). No duplicates — worse: missing lifecycle
  (never depart) + ghost presence pre-activation.
  Downstream deps on ghosts: grounded/support castShape + rolling surface
  (REAL gameplay: the bridge probe itself); reachedFinish/completeCourse/
  death/camera/checkpoint/pickups are trigger/location-based (clean).
  3-state map — before activation: native NONE, Rapier 16 baked
  (VIOLATED); active: native 8 plates + platform-proxies, Rapier 16 baked
  visuals (VIOLATED: shape + disabled-made-solid); departed: native plates
  only, Rapier all 16 at origin (VIOLATED: platform ghost); visuals:
  Box_slide shown in Rapier (minor).
  FIX ARCHITECTURE (proposed, not applied): route pe_balloon through a new
  Rapier finish adapter like the other P_Modul_* kinds (kind-routing, not
  name-hack): managed bodies per finish-data (plates frozen-static on
  activation; platform dynamic via proxy hulls + forces + hinge + reset;
  balloons/ropes dynamic-moved with colliders disabled; Box_slide hidden);
  generic bake then excludes it naturally. Deletion alone is WRONG (ball
  would fall where plates belong). Solver branch untouched throughout.
  Remaining AdditiveBlending overrides in production (transformer flash,
  flames, fan, collectibles, spawn FX) are future blend-audit candidates
  only — no action. Captures in system temp; tree green.
