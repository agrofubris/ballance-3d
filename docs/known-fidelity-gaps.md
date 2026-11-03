# Known solver-fidelity gaps

Confirmed behavioral differences between the IVP path (the deployed default)
and the Rapier fallback that are understood, documented, and deliberately left
unfixed. Do not "fix" these by retuning friction, mass, drive strength, or
global solver settings without new evidence.

## Stage 1 crowned bridge — Rapier contact-manifold difference

At the crowned entry bridge of Level 1, a full-throttle stone ball falls
off in the original game and stays centered in this port.

Native IVP resolves the initial centered stone contact with a single
slightly −Z-tilted contact, which seeds a deterministic lateral walk off
the crown (reproducible from any microscopic start offset, and still
present when friction is raised to wood's value). Rapier resolves the same
placement as a balanced two-contact manifold with zero net lateral normal
component and therefore remains centered; tiny lateral offsets persist
unchanged rather than amplifying, and flank starts roll downhill normally.

Longitudinal drive, friction coefficients, geometry, solver iteration
count, and downhill response have been independently ruled out. A forced
lateral seed is preserved faithfully by both solvers, so the entire
divergence reduces to initial contact resolution at placement, not to
sustained dynamics.

No tuning workaround is applied; a future fidelity fix would need to
target contact generation/manifold selection, not material or solver
magnitudes.

### Re-derived against the harness (2026-10-23)

`stage1_stone_crown` (stone, full throttle from the staged crown, 40 settle
ticks) was re-measured on both solvers with the graph-hosted ending. It does
**not** reproduce the original game's walk off the crown on either solver:

- Lateral excursion over ticks 40-450 is tiny on both: max |dz| 0.112 on
  Rapier and 0.259 on IVP original units (start z 218.435). IVP drifts about
  2.3x more, toward -Z, and re-centers; the first lateral pose difference is
  tick 211 at dz 0.001. This agrees in sign with the IVP "-Z tilted contact"
  above but is far too small to leave the deck.
- The late divergence is not the crown. By tick ~340 the stone has rolled down
  to the finish platform. Rapier boards at tick 341 and IVP at tick 446. On
  Rapier the departing platform then drops the rider (`ball.dead` at 454,
  `respawn.begin` at 454, `spawn.begin` at 589); IVP raises no death event in
  900 ticks. That is the finish departure solver-model gap below, not a
  manifold result.
- So the recorded manifold windows only describe the early contact-set and
  lateral differences (ticks 167 and 211). The original's lateral fall-off at
  the crown is not reproduced by either solver here and remains an open
  fidelity question. No tuning was applied.
- Re-verified after regenerating the local pack with the full
  `prepare-original.py` pipeline: `stage1_stone_crown --solver both --repeat 2`
  still passes the recorded windows, is bit-identical per solver, and leaves
  the original crown fall-off unresolved. No solver or material changes were
  made.

## Stage 1 Rapier finish-adapter activation (fixed)

`PE_Balloon_01` is not a member of any `Sector_XX` group in the converted
levels, so the generic sector lookup assigned the Rapier finish adapter to
sector 1. The graph session now scopes `PE_Levelende`-owned objects to the
final reset-point sector, matching the original IVP behavior, and a sector-owned
managed ending takes precedence over the raw level-end proximity shortcut, so
Rapier wakes, boards, rides, departs and completes through the same lifecycle
as native. Verified by `stage1_wood_finish` and `stage1_finish_reset` on both
solvers.

## Stage 1 finish departure — remaining solver-model fidelity gap

Both solvers now survive the recovered departing ride and reach
`level.complete` with near-identical completion timing. The earlier
reconstruction bugs that used to drop the Rapier rider off the platform are
fixed:

- finish parts now use the recovered fixed/`startFrozen` state
- the platform now uses its recovered total mass, authored mass center, and
  native-measured inertia
- finish force directions now include the recovered parent frame

The remaining mismatch is the constraint solver model, not the recovered data:

- Rapier departure travels roughly 22 render units along the ride axis versus
  native ~11
- Rapier support continuity is roughly 92% of ride ticks versus native ~99%
- Rapier platform-local rider drift is roughly 0.49 versus native ~0.05
- Rapier reaches a somewhat deeper vertical sag envelope; its bounded floor is
  represented explicitly in `stage1_finish_ride` as an accepted known gap
  (`platformPosition[1] >= -4.6`), while native remains independently held to
  its recovered envelope (`>= -4.5`)

Recovered cause (IVP 1k10 constraint semantics, verified against the upstream
source and local probes):

- `IVP_Constraint_Local` resolves each constraint's locked axes as a one-shot
  per-PSI controller solve; there is no global iteration across constraints
- actuator, spring, and gravity controllers use async pushes that are
  incorporated during integration, after the constraint correction
- stacked constraints (the recovered 639 rail plus 659 platform slider)
  therefore retain and reload their cross-axis error until a later PSI under
  relative load
- Rapier solves the loaded joint island iteratively and keeps locked DOFs much
  closer to exact
- isolated single joints agree between the two solvers; the divergence appears
  only in the stacked 639+659 mechanism under relative load

This is not a wrong force magnitude, wrong friction, bad mass, bad joint axis,
or random numerical error — those were independently ruled out. No empirical
softness, force rescaling, or solver tuning is used to hide the difference;
the harness records the bounded Rapier envelope as an explicit accepted gap.
