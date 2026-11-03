# Original graph runtime

The original Ballance behavior logic is authored Virtools NMO/CMO graphs. The
port first reproduced each module with hand-ported code validated against
recovered oracles; those hand-ports were checked against the graphs and removed
(commit 502bd84). The game now runs from the authored graphs on the generic
runtime this document describes, with its current coverage. Items below that
compare against "the hand-port" record that parity work.

## Data path

1. `scripts/original_chunks.py` reads a `dump-chunks` TSV. Its `definition`
   reader returns a behavior's `children`, `links`, `inputs`, `outputs`,
   `locals`, `inIO` and `outIO` parameter indices, the target parameter index,
   and `value` resolves a parameter to a JSON value. Output parameters may also
   carry their own serialized destinations in chunk `0x20`.
2. `scripts/export-original-graph.py` turns a dump into a graph model:
   - **nodes**: the kind-8 named `CKBehavior` objects with their parameter
     slots (each slot keeps the dump parameter index and its authored value).
   - **links**: the kind-6 rows, connecting an output parameter index to an
     input parameter index (`from`/`to`) plus the link `type` word.
   - **parameter-out targets**: a CKParameterOut's chunk-`0x20` destination
     list (`targets`) and the behavior target parameter (`targetIndex`/
     `targetSource`), so a `Convert`/`Get Object By Name` result can retarget a
     later behavior such as `Get Cell`.
   - **NULL object references**: an object parameter saved as NULL exports
     its own name as `value` (Virtools has nothing else to show) and
     `null: true`. Behaviors read object inputs through `inputObject`, which
     returns undefined for such a parameter until a behavior writes it, so an
     unset `Coordinate-System` or `Parent` acts as NULL, as in CK.
   - **parameter types**: each decodable parameter's CKParameter type GUID
     (`type`), which lets type-dispatched behaviors such as `Interpolator`
     distinguish float, vector, 2D vector, and color interpolation.
   - **prototype**: a primitive building block's prototype GUID (behavior
     chunk `0x20` words 1-2, present when flag `8` is set); scripts carry
     none. Across all 51 exported documents every prototype GUID maps to
     exactly one behavior name, so name dispatch is unambiguous, and a leaf
     without a prototype is an empty script rather than a missing block.
   - **message types**: a `CKMessageType` parameter (type `121e88032b4ea35b`)
     saves `WriteManagerInt(CKMessageManager GUID 0x466a0fac:0, type)`; the
     type indexes the manager's name table (chunk `0x53`, a counted list of
     strings in type order), read from a `dump-chunks <file> --managers` dump
     stored next to the object dump as `<stem>.managers`. Every message
     parameter in the shipped files decodes to its name (`Dead`, `Ball Off`,
     `Life_Up`, ...); a message parameter without a table fails the value.
   - **owners**: root script -> owning CKBeObject, read from each object's
     chunk `0x800` script list. Wait Message without a target waits on this
     owner (`All_Gameplay`, `All_Sound`, `P_Modul_18_MF`, ...).
   - **roots**: the script behaviors with no owning parent.
   - **hierarchy**: the CK3dEntity scene hierarchy (`parent -> children`),
     read from the serialized entity chunks (`0x100000`), because LibCmo drops
     entity parent IDs. `TT Restore IC` needs it for its children recursion.
3. `scripts/export-original-arrays.py` decodes every kind-52 `CKDataArray`
   (column definitions in chunk `0x1000`, row-major cells in `0x2000`) into
   `.local/original/data-arrays.json`, which the app fetches from the local
   original pack. Type-5 cells are parameter references and resolve to the
   referenced parameter's value (`CurrentLevel` column 4 is the
   `Activation Phase?` bool). `keyColumn` is `m_KeyColumn` from
   `CK_STATESAVE_DATAARRAYMEMBERS` (chunk `0x4000`: order, sort column, key
   column; -1 when none), which `Get Key Row` searches. The export covers base.cmo as well, so
   `GameSettings`, `DB_Options` and the per-level highscore tables are
   available to the UI host. A fresh end-to-end `prepare-original.py` run
   reproduced the previous ten source files and added the base.cmo arrays.
4. The exported graphs live under `.local/original/graphs/` (generated on
   demand, never committed).

```
python3 scripts/export-original-graph.py <dump.tsv> [--out path.json]
python3 scripts/export-all-graphs.py
python3 scripts/export-original-arrays.py
```

## Runtime

`src/game/original-graph.ts` implements `OriginalGraphRuntime`:

- It indexes every parameter index to its owning node and slot.
- **Scheduling follows CK2.dll** (`CKBehavior::Execute`,
  `CheckIOsActivation`, `FindNextBehaviorsToExecute`,
  `CheckBehaviorActivity`, `ExecuteFunction`). The CK2 reconstruction
  (doyaGu/CK2) was checked against the shipped DLL.
  - Behavior IOs are active flags, and behaviors carry ACTIVE and RESERVED0
    flags.
  - Each compound keeps its saved links and its sub-behaviors in execution
    order: the saved order re-sorted by MSVCRT `qsort` on descending priority,
    as `SortSubs` leaves it at load (`src/game/original-crt-qsort.ts`, which
    matches the 32-bit system msvcrt on every exported compound). The exporter
    writes each behavior's chunk 0x20 priority.
  - Executing a compound first follows the links that leave active IOs: they
    fire, or a delayed link starts counting. It then stacks every ACTIVE
    sub-behavior in that order and pops them one by one, so chains run
    depth-first. After a behavior runs, each of its active outputs is
    followed. A destination input makes its owner ACTIVE and inserts it above
    every stacked entry of equal or lower priority, so it runs next. A
    behavior already on the stack is not stacked twice, and runs once with
    every input that arrived.
  - A compound's output activates directly, and the parent follows it as soon
    as the compound returns.
  - A delayed link counts down once per Execute of its compound and ignores
    re-triggers while counting. When it expires, its destination becomes
    ACTIVE for the next frame.
  - `wait()` is CKBR_ACTIVATENEXTFRAME. A compound stays ACTIVE while a sub is
    ACTIVE or a delay is pending.
  - A loop is cut after 80000 executions per compound Execute, the limit the
    documents save.
- **Scripts.** The parentless nodes (the root scripts) form the top level,
  which executes each ACTIVE script once per frame.
  - `Activate Script` and `Deactivate Script` inside a graph apply at the next
    frame start, as `CKScene::Activate` does. A reset clears the script's
    IOs, delays and block state, then activates the script's own input 0.
  - The host calls `activateScript`, `deactivateScript`, `activateNow` and
    `runIsolated` act immediately.
- **Data** propagates when a behavior writes an output: the value is copied to
  every linked input and to the parameter-out's serialized `targets`, so the
  next behavior reads the live value. A behavior target (`targetIndex`) also
  follows its parameter source, which is how the module `Init` script resolves
  `CurrentLevel` and retargets `Get Cell`.
- `activateNextFrame` activates an output at the next frame start. `Delayer` follows
  `TimerMini.cpp`: it resets its elapsed time on `In`, adds float32
  `DeltaTime` every frame including the activation frame, and fires `Out` once
  the authored wait has elapsed.
- `activateNow` activates an input and executes its root script now (used to
  start a module's `_Init` script before its module script without an extra
  frame).
- A parameter reference follows a chain of references to its final source (a
  compound input can reference a local that is itself a reference).
- `Wait For All` waits for its activation pins (inIO), not its parameters; it
  remembers activations across frames, as the DLL does (the intro waits for the
  movie's loop end and the wave sound's end, which arrive at different times).
- `Key Event` follows `KeyEvent.cpp`. It monitors from On until Off, re-running
  each frame. Off keeps the Key State output, On resets it, and a block without
  keys counts as pressed.
- Messages are identified by their decoded message type name and addressed to
  a destination object: Send Message input 1, which the documents' `_Init`
  scripts fill with `Op Get Object By Name` (`All_Gameplay`, `All_Sound`,
  `Level`). A Wait Message without a target receives only messages addressed
  to its root script's owner. Messages live on a `GraphMessageBus`, the
  CKMessageManager.
  - Messages sent during a frame are delivered by `postProcess` after every
    script ran. A private bus does this at the start of the next `step`; the
    session host does it at the start of each frame for its shared bus.
  - Delivery replaces every receiver's last-frame messages, which
    `Switch On Message` reads each frame until Off, as `SwitchOnMessage.cpp`
    does.
  - Delivery also wakes each matching `Wait Message` registration once
    (`RegisterWait` on In, `UnRegisterWait` on Stop). It copies the message
    parameters to the block's outputs and activates Out, whose links fire at
    the next frame start. A message sent in frame F is therefore acted on in
    F+1, in any script order.
  - A registered Wait Message keeps its compound active
    (CKBEHAVIOR_WAITSFORMESSAGE).
  - A host that stands in for a receiver script `take`s delivered messages.

  A runtime has a private bus unless its host passes a shared one. The session
  shares one bus across every hosted document, the ending and the tutorial. No
  hosted module document receives messages, so instances that share owner
  names cannot cross-deliver.
- Behaviors are looked up in a `BehaviorRegistry` by name. Activating a
  primitive (a node with a prototype) that is not registered throws, naming
  the document, node and prototype. A host lists blocks it knowingly leaves
  unimplemented as `inert`; coverage tooling uses `unknown: 'record'` to
  collect them in `runtime.unimplemented` instead. `runIsolated` runs one node without
  following its outputs, for a host that executes a single authored node
  outside its script.
- `holdScript(name, held)` keeps a root script from executing without
  discarding its state.
- Without `frameRoots` (hand-built graphs only), every root is re-fired each
  frame. This is not an original path, and every host sets `frameRoots = []`.
- The exporter decodes `CKPGUID_PERCENTAGE` parameters as 0..1 floats (they
  were read as raw integer bits).

### Gameplay host

The graph session runs Gameplay.nmo's roots on one runtime per level.
`GameplayBinding` (`src/game/original-gameplay-binding.ts`) owns every exported
Data Array, maps the port settings into `GameSettings` (Language, `Tutorial?`)
and `DB_Options` (`Invert Cam Rotation?`), fills `CurrentLevel`, records
`Set Physics Globals`' time factor and routes the tutorial scene's names to its
tutorial binding. The session runs `Gameplay_Init`, `Gameplay_Ingame`,
`Gameplay_Refresh` and `Gameplay_Sky`, supplies `Light_Ingame`, the level
`SkyLayer` and the TT Sky entity (see [original-sky.md](original-sky.md)), and
steps the document every script frame on the shared bus.

Known gap: script-level parameter operations (`Get Name`, `Convert`, 14 in
Gameplay.nmo) are not exported. `Gameplay_Refresh`'s `Get Key Row` key is a
`Get Name` of `ActiveBall`, so Refresh stops after copying the `Keyboard` row:
it does not yet set the ball physics globals, swap the inverted rotation keys,
run its tutorial freeze or send `Refresh`. The module `Test` blocks fill the
same unexported active-ball name from the binding.

The pure array/logic primitives live in `src/game/original-behaviors.ts`
(`Binary Switch`, `Identity`, `Group Iterator`, `Linear Progression`, cell
addressing and message delivery). The behavior registry is assembled in
`src/game/original-graph.ts`; `ORIGINAL_PRIMITIVES` is kept as an alias for the
full `ORIGINAL_BEHAVIORS` registry.

## Goal and progress

Definition of done: every behavior used by gameplay is decoded and implemented,
every level's modules run from their authored graphs (done; the hand-ports are
removed), nothing in gameplay depends on hand-port knowledge, and all emitted
harness scenarios pass on both backends. The dead hand-port code is purged.
What still carries hand-port knowledge are rules first taken from the removed
hand-ports: the Rapier fallback's per-module anchors, joint wake and solver
iterations (`src/game/original-context-physics-rapier.ts`,
`src/game/original-graph-physics-rapier.ts`). The IVP graph physics was checked
against physics_RT.dll: hinges, sliders and springs constrain against Object2's
physics object (`FixCube Object`, the module's physicalized FixCube) instead of
an extra fixed sphere, and the slider axis is the handler's arithmetic
(`0x10005f10`: x in double, y and z through float32, not normalized). Single
hulls use the same ledge-soup surface as compounds, which is what the bridge
builds for either call.

### Layer 1 - behaviors

- [x] Runtime core: activation + data propagation, next-frame scheduling.
- [x] Exporter: `dump-chunks` TSV -> graph model (nodes, slots, links, roots).
- [x] Pure primitives: `Binary Switch`, `Identity`, `Linear Progression`,
      `Group Iterator`, `Nop`, and the engine-core `Get Cell`/`Set Cell`
      (recovered from `Logics.dll`: Data Array target with row/column inputs).
- [ ] Decode opaque behavior locals (operation selectors, array targets,
      object references) in the exporter.
- [x] `Op`: generic parameter operation. The operation GUID (locals 1/2) maps to
      a name via the `ParameterOperations.dll` registration table
      (`scripts/recover-operation-table.py`); the runtime embeds the 20 shipped
      operations and implements the arithmetic and object-getter functions.
- [x] `Send Message` / `Wait Message`: recovered from `Logics.dll` and
      implemented over the runtime message queue.
- [x] Timers/progressions: `TimerMini`, `Delayer`, `Linear Progression`,
      `Timer`, `Bezier Progression`, `Per Second`. `Bezier Progression`
      samples the block's saved Progression Curve: the runtime exposes undecoded
      parameter chunks (`inputRaw`/`localRaw`) and `src/game/original-2d-curve.ts`
      decodes CK2dCurve points (the layout first recovered from the UFO
      animation's curves; TCB or fitted curves fail loudly).
- [x] Script controls: `Sequencer`, `Activate Script`, `Deactivate Script`,
      `Parameter Selector`, `Switch On Parameter`, `Binary Memory`,
      `Wait For All`, `Test`, `Interpolator`, `Key Event`, `Send Message`,
      `Wait Message`, `Exit`.
- [x] Physics set (`src/game/original-graph-physics.ts`): `Physicalize`,
      `Unphysicalize`, `SetPhysicsForce`, `PhysicsImpulse`, `Set Physics Hinge`/
      `Slider`/`BallSocket`, `Physics WakeUp`, `PhysicsCollDetection`,
      `TT Set Dynamic Position`, `Per Second`, implemented against the
      `GraphPhysicsBinding` contract.
- [x] `TT Set Dynamic Position` follows TT_Toolbox_RT.dll 0x10004a80: On
      saves the position without integrating; Off clears the active flag but
      still integrates once before Out Off; positions are read and written in
      the Coordinate-System's frame (`positionIn`/`setPositionIn`, children
      follow); only output 0 is written. The arithmetic is shared with the
      hand-port (`originalDynamicPositionStep`) and the Offset is converted to
      the binding's units. A NULL Object or a non-zero MaxDistance2Target
      (never authored) fails loudly.
- [x] `TT Scaleable Proximity` routed through the runtime with the authored
      coordinate scale (render units for Rapier, original units for IVP).
- [x] `Get Nearest In Group` (`GetNearestInGroup.cpp`): float32 squared
      distances between float32 original-unit positions, from FLT_MAX with a
      strict `<`, the Referential excluded. This is the same arithmetic as the
      hand-ported transformer search. Only the authored zero Position offset is
      supported.
- [x] `Object Create` / `Object Copy` (`ObjectCreator.cpp`, `ObjectCopier.cpp`)
      over a `GraphLifecycleBinding`. A Level class (CKCID 21) creates nothing.
      Copies keep input order. The CKDependencies blob goes to the binding
      undecoded.
- [x] `Planar Filter` (`PlanarFilter.cpp`) over a `GraphFilterBinding`. On
      registers a full-view quad whose settings are read live (pointer-form
      `RGBAFTOCOLOR` colours), Off has priority, and the block stays active
      every frame until Off.
- [x] `Execute Script` (`ExecuteScript.cpp`): activates the script with its
      Reset flag and fires Out on the first later frame where the script is no
      longer active (`OriginalGraphRuntime.isScriptActive`: nothing of it is
      queued, waiting or delayed). Only this document's root scripts resolve.
      16 of the 19 authored calls target another document (Loading_Manager,
      Levelinit_build, Menu_Score, ...) and fail loudly until a multi-document
      host exists.
- [x] `Send Message To Group` (`SendMessageToGroup.cpp`, version 2): Out, then
      one message per group member with inputs 2.. as parameters. Unresolved
      groups fail loudly.
- [x] Attribute blocks (`Has Attribute`, `Set Attribute`, `Remove Attribute`,
      `Objects With Attribute Iterator`), translated from their
      `Logics/Behaviors` sources over a `GraphAttributeBinding` (has, value,
      set, remove, and the manager's carrier list).
      - The exporter now writes a CKPGUID_ATTRIBUTE value as the attribute's
        name. Like a message type, it is saved as `WriteManagerInt` of the
        CKAttributeManager GUID (0x3d242466) and a per-document index into
        that manager's chunk 0x52 table: `TrafoType` is 32 in Gameplay, 34 in
        Levelinit, 30 in AnimTrafo and 52 in base.
      - Blocks with a target parameter that holds no object take their
        no-target path. Blocks without a target parameter act on the script
        owner.
      - The authored `set Trafo-Attribute` compound runs end to end in the
        tests.
      - Per-object authored attributes (object chunk 0x11) are not exported
        yet, so no host binding exists.
- [x] Camera, orientation and prelit blocks (`src/game/original-graph-render.ts`):
      - `Set Euler Orientation` builds `Vx3DMatrixFromEulerAngles`' rows
        (float32, the EPSILON shortcut) and hands them to the object binding's
        `setOrientation`. `src/game/original-orientation.ts` implements
        `CK3dEntity::SetOrientation` for hosts: referential rotation, zero
        components as 1e-6, renormalisation that keeps the row scale and the
        position. On the authored `Cam_Orient`/`Cam_OrientRef` frames it agrees
        with the hand-ported camera turn.
      - `Set As Active Camera` and `Set Clipping Planes` drive a
        `GraphCameraBinding`.
      - `Set Prelit Color` converts both colours with the four-float
        `RGBAFTOCOLOR` and writes them through the effect binding's
        `setPrelitColor`.

      No host provides these bindings yet; their authored uses are in
      `Gameplay_Ingame`/`Gameplay_Events` and Levelinit. They fail loudly until
      one does.
- [x] Effects/audio (`src/game/original-graph-effects.ts`): `Set World Matrix`,
      `Set Diffuse`, `Set Emissive`, `Set Texture`, `TT_TextureSine`,
      `Play Sound Instance`, `Wave Player`, implemented against
      `GraphAudioBinding`/`GraphEffectBinding`. `Wave Player` stays active while
      `CKWaveSound::IsPlaying` (the audio binding's `playing`) and fires
      `End Playing` when it stops; without that query a sink falls back to the
      authored wave duration, and fade-in/out and pause/resume remain
      unimplemented. Particle systems
      (`SphericalParticleSystem`, `Point Particle System`) are in
      `src/game/original-particle-system.ts`. RANDNUM and RANDNUMP use the
      shipped DLL's float factors (0x38800203, 0x380000FD), and AddParticles
      draws no density `rand()`. Known gap: the DLL rounds RANDNUM to float
      at some call sites and keeps the x87 value at others; the port rounds
      it everywhere. `TT_TimedependentPointParticlesystem` is the General
      system with a TimePointEmitter: Emission Delay is an int rate per
      second, and AddParticles2 (0x25083540) fires floor(rate x time)
      particles, at least one, along the path once rate x time passes 0.9,
      then restarts the path at the frame. The extra-point trail presentation
      is not ported; only its recovered data (`.local/original/point-trails-data.json`)
      remains as decode evidence.
- [x] `Ray Intersection` (Logics `RayIntersection.cpp`) through
      `GraphBinding.rayIntersection`; `Set Position` honours its Referential
      when the referential's binding provides `toWorld` (other hosts keep the
      historical world-space write).
- [ ] UI/particles depth: `2D Text`, `Set 2D Material`, light controls.

The pure primitive helpers were first written generically; the runtime registry
now carries faithful translations of the recovered `CKBuildingBlocks` source.
`Op`, `Get Cell`, `Set Cell`, `Send Message` and `Wait Message` are engine-core
behaviors whose source is not in the building-block pack; they need Ghidra
recovery before they can be faithful, so they are not marked recovered.

### Layer 2 - objects

- [x] Object binding interface (`GraphBinding`/`GraphObjectBinding`) and the
      visibility/transform behaviors (`Show`, `Hide`, `Set Position`, `Scale`,
      `Rotate`) translated from source.
- [x] Object resolver (`src/game/original-graph-scene.ts`): maps authored object
      names to live Three.js objects and Data Arrays for the runtime.
- [x] Entity hierarchy (`src/game/original-entity-graph.ts`): CK3dEntity
      transforms in original units for frames without a body or mesh (the
      Camera.nmo rig), following the RCK3dEntity reconstruction of CK2_3D.dll
      (doyaGu/CKRenderEngine), spot-checked against the shipped DLL. Each entity
      keeps world, local and a lazily computed inverse world matrix, and
      `WorldPositionChanged` patches only the inverse translation, so values
      depend on history as in the original. `SetParent`, `SetWorldMatrix`,
      `SetPosition`/`GetPosition` with a referential, `SetOrientation` and the
      load/restore order (`SetParent(saved, TRUE)` then `SetWorldMatrix(saved,
      TRUE)`) are implemented. `src/game/original-matrix.ts` ports VxMath's
      `Vx3DMultiplyMatrix` and `Vx3DMultiplyMatrixVector` (SSE paths, float
      per operation) and `Vx3DInverseMatrix` (x87, Graphics Gems split
      determinant, 1e-15 singular limit). `originalEntityObject` exposes an
      entity as a `GraphObjectBinding` in original or render units (the power-of-two
      scale and Z flip convert exactly), `originalEntityFrame` as a physics
      referential. `LookAt` follows CK2_3D 0x10007D68 (world Y up, anti-flip).
- [x] Camera rig (`src/game/original-camera-rig.ts`): Camera.nmo's six frames
      on the entity graph, with the camera binding (`Set As Active Camera`,
      `Set Clipping Planes`), the render manager's per-frame target-camera
      `LookAt` (InGameCam at Cam_Target) and a render-space view. The authored
      `Cam Navigation` compound (Gameplay 2189) run on it matches the
      hand-ported turn frame by frame, including the steering commit. The
      camera rig class is not wired into the session host yet.
- [x] Hierarchy behaviors: `Set Parent` (KeepWorldPos TRUE, NULL detaches),
      `Set World Matrix` and `Set Position` (KeepChildren = !Hierarchy) use the
      binding's `setParent`/`setWorldMatrix`/`setPositionIn` when it has them.
      `Set Parent` fails loudly without a target or a hierarchy binding.
      `TT Restore IC` walks the binding's live `children` when it reports
      them, so a detached entity is no longer restored with its old parent.
      The tutorial binding reparents with THREE `attach` and restores the
      load-time parent and world matrix.
- [x] CK object context (`src/game/original-context.ts`): every loaded
      document's objects with CK class ids, saved 3D parents, group members,
      owned scripts, attributes and dependency links, exported per document by
      `scripts/export-original-objects.py` into `.local/original/objects/`. A
      load lists objects as CKFile::FinishLoading does (BeObjects and
      animations in file order, then scripts). The class hierarchy is the one
      CK2 (CKGlobals.cpp) and CK2_3D register. Objects travel through graphs as
      `#<id>` references (CK object parameters hold CK_IDs; names collide, such
      as a texture and its material); saved references stay names and resolve
      only when unique. `Get Object By Name` uses GetObjectByNameAndParentClass
      with the result type's class (first match). Attributes keep saved values,
      add defaults by type, and list carriers in the order they got the
      attribute. `DestroyObject` with NONE or FULL dependencies follows the
      delete-mode PrepareDependencies of BeObject (scripts), 3D entity (meshes,
      children), mesh (materials), material (textures) and group (members).
      The entity/mesh/material/texture links come from the rendering export,
      mapped by name within each class; an ambiguous name fails loudly when a
      delete reaches it.
- [x] Multi-document session (`src/game/original-session.ts`): documents run
      together on one message bus and binding, in load order; Execute Script
      and Activate Script reach other documents' scripts, a hosted document's
      objects are loaded into the context, and a document an `Object Load`
      brings in starts running its scripts.
- [x] Context blocks (`src/game/original-graph-context.ts`): `Object Load`
      (ObjectLoader.cpp: master object by class and name or root entity),
      `Collection Iterator`, `Sound Load` (synchronous path; the file resolves
      on the user's sound paths), `Object Delete` (NONE/FULL dependencies), and
      `Add To Group`/`Add Object To Group` and `Object Create` on the
      context. `Broadcast Message` reaches every BeObject receiver. String
      `Addition` concatenates, `Get Length` is strlen, and `Test` compares object
      operands as CK_IDs (NULL equals NULL).
- [x] Object Copy (ObjectCopier.cpp over `CKContext::CopyObjects`): the
      saved copy dependencies (NONE, FULL or a per-class table over the
      registered defaults) choose what is copied. CK2.dll's
      CKBeObject::PrepareDependencies reads the BeObject entry for every
      BeObject (NeMo2 reads the object's own class), so copies take their
      scripts, attributes and groups when that entry asks. Copies keep their
      names or take `GetObjectSecureName` names (verified in CK2.dll: a trailing
      three-digit number set aside, the highest suffix of that class plus one,
      `%03d`). Each copied root script runs as a new instance of its document's
      graph with references to the copied objects remapped; it starts active
      when its original is.
- [x] Hosted documents have their saved object references resolved to context
      objects by name within the reference's class (the document's own
      objects first), as loading remaps them. `Convert` from a string to an
      object type finds the object by name in that class.
- [x] `TT Save IC` snapshots a context object's (and with Hierarchy? its
      descendants') state; Restore IC brings it back. `Scan String`
      (SplitString.cpp), `Get World Matrix` (the entity's saved matrix),
      `Get Row Count`, `Get Script Count` and the group `Get Count` are
      implemented, and an `Op` with an unrecovered operation fails loudly.
- [ ] Hosting Levelinit_build: it now fills `ResetPoints` with the level's
      reset-point matrices itself (tested on Level 1), copies the checkpoint,
      start, end and module placeholders and sets up their tables, and runs
      the copied pickup scripts' `Ray Intersection` and `TT Extra`. It stops
      at `Set Prelit Color` (frame 42 on Level 1), which needs the renderer
      behind the context.
- [x] A session runs in original units: the context owns every 3D entity's
      transform and parenting (`OriginalEntityGraph`, keyed by `#<id>`), and
      the session's object, frame and children bindings read it directly.
- [x] `Ray Intersection` over the context (`src/game/original-ray.ts`):
      RayIntersection.cpp's candidates (the filter group, or every 3D
      object, character and 3D sprite), CK3dEntity::RayIntersection in each
      entity's frame, and the mesh test CK2_3D picks on SSE CPUs
      (0x1002F52E) over VxMath's RayPlane / RayPlaneCulled, PointInFace and
      GetPointCoefficients (decoded from VxMath.dll; EPSILON 2^-23).
      Meshes come from the document's render export. Two gaps are explicit:
      face normals use the exact reciprocal square root where the original
      uses `rsqrtss` (a CPU-specific approximation), and a hit on a textured
      face with an alpha reference (PreciseTexturePick) fails loudly. The
      bounding sphere/box rejections are left out: they only skip entities
      the ray cannot meet within Depth.
- [x] IVP bodies keyed by context references (`OriginalContextPhysics`):
      the session owns its physics; Physicalize takes hulls from the
      context's meshes (or an entity's current mesh) and poses from the
      entity transforms, in original units, and `sync()` writes simulated
      poses back. Levelinit physicalizes FixCube and the module parts on
      Level 1, and the session steps IVP after the scripts. Levelinit's own
      mesh (FixCube) is exported by `prepare-original.py` with
      `extract-original.py --document`.
- [x] Data Array blocks (`src/game/original-graph-array.ts`): `Add Row`,
      `Clear Array`, `Value Count`, `Sort Rows`, `Change Value If` from
      CKBuildingBlocks over the CKDataArray kernel (NeMo2 reconstruction):
      per-type equal and sort functions (strcmp, int difference, float
      ordering, memcmp of parameter bytes), MSVCRT qsort, and the
      sorted-column cache that only an ascending sort sets and InsertRow or a
      write to the sort column clears. Inputs are written only when they have
      a source and their own pin type matches the column (`pinType` in the
      export); an object column takes only a BeObject pin, as
      `ReadInputParameters` does. Column parameter GUIDs and a saved sort
      column are exported with the Data Arrays. A missing array is
      CKBR_OWNERERROR (no output); a parameter column left at its default
      fails loudly.
- [x] `Remove Row`, `Remove Row If`, `Remove Key Row`, `Insert Column`,
      `Remove Column`, `Threshold` and `Mini Calculator`, checked against
      Logics.dll and CK2.dll. Insert/Remove Column fire Out before looking at
      the target; CK2.dll's InsertColumn ignores a NULL name or an index at
      or past the column count and never shifts the key or sort column.
      Column changes are kept with the rows (the Data Array's own format),
      though `Get Key Row` still reads the saved key column. A new parameter
      cell is defined only for BOOL; object keys compare by reference only.
- [x] Sound blocks (`src/game/original-graph-sound.ts`): `Volume Control`,
      `Pitch Control` and `Panning Control` (Sounds.dll: Out first, a NULL
      target ends there, the pin goes to the setter unclamped), and
      TT_Gravity_RT's `TT_GetSoundProperties` and `TT SpeedOMeter`, decoded
      from the DLL where it differs from the reconstructed source: no NULL
      target check in the first, no zero delta or zero range guard in the
      second (|Δpos| · 1000 / DeltaTime; the relative speed is clamped to
      0..1 and NaN becomes 0). The audio binding gains pitch, pan and
      property read-back. Open: a sound's authored gain/pitch/pan (its saved
      chunk is not decoded yet).
- [x] Level-setup blocks (`src/game/original-graph-material.ts`) over the
      context's object state: `Set Blend Modes`, `Set Alpha Test`,
      `Set Material Z Buffer`, `Set MipMap Level`, `Change Texture Video
      Format`, `Texture Load`, `Fill Group By Class`, `TT_SetMipMapping`,
      `TT_ReflectionMapping`, `TT_FlushTextures`, `TT_PreloadTextures`,
      decoded from Materials, Narratives, Logics and TT_Toolbox_RT. Where the
      DLL differs from the reconstruction it wins: Texture Load resolves on
      the DATA path, Set Blend Modes does nothing for a NULL target, Change
      Texture Video Format has no range check (out of range fails loudly
      here), Fill Group By Class runs from Class to Class + 1 without
      Derived Classes. The renderer does not read this state yet.
- [x] `TT Extra` and `TT_Timer` (`src/game/original-graph-extra.ts`),
      decoded from TT_Toolbox_RT: the idle orbit about the six DLL axes,
      the fly-away and the pursuit with the DLL's float stores; uninitialise
      hides the small balls (the reconstruction shows them). TT_Timer reads
      one timer manager per context. Behavior callbacks
      (`BEHAVIOR_CALLBACKS`) carry CKM_BEHAVIORRESET and
      CKM_BEHAVIORDEACTIVATESCRIPT to blocks that react to them. A session
      gives TT Extra the context's entity tree; its scene DeActivate of the
      floor glow is a flag when the object has no scripts and fails loudly
      otherwise.
- [x] `CKBehavior::GetTarget` without a target parameter is the owner of
      the behavior's script.
- [ ] `Deactivate Object`: CKScene::DeActivate drops the object from the
      scheduler's active list without touching its scripts' flags; the
      runtime has no per-object activity yet, so it stays unimplemented
      (used only in base). Levelinit's `set MipMap` script has no inbound
      link; whether the file starts it active is not exported.
- [x] Parameter operations outside building blocks (kind-4
      CKParameterOperations, 89 across the documents) are exported with their
      owner and evaluated when their output is read, as
      `CKParameterOut::GetValue(update)` runs `DoOperation`. Unknown
      operations, and `Convert` pairings other than integer to string/float or
      string passthrough, fail loudly.
- [x] Physics binding for both backends:
      `src/game/original-graph-physics-rapier.ts` and
      `src/game/original-graph-physics-ivp.ts`, built over host resolvers and
      reusing the recovered helpers (`configureBody`, `configureContact`,
      `applyOriginalConvexMass`, the IVP joint/force/spring APIs).
- [x] Audio/effect bindings: `src/game/original-graph-audio.ts` and the
      session's `GraphBinding` adapt the sound and effect pools to
      `GraphAudioBinding`/`GraphEffectBinding`. Authored `PlanarParticleSystem`
      settings render through `src/game/original-particle-system.ts` with the
      recovered additive smoke shader.
- [x] Module runner: `src/game/original-session.ts` (`OriginalSession`) hosts
      every loaded document on `OriginalGraphRuntime`. Activation fires `_Init`
      roots first and then the scripts exactly once; each frame only advances
      the live runtimes, so multi-frame work continues through timers/link
      delays instead of re-running `Start`.
- [x] Object/host wiring: `src/game/original-graph-host.ts` builds the
      session binding from the live scene, bodies and audio;
      `src/game/original-context-physics.ts` / `-rapier.ts` resolve bodies and
      convex hulls.
- [ ] Moddability: load level/module NMO/CMO (or exported JSON) at runtime so
      mods can supply their own graphs and assets.

### Layer 3 - validation

The graph-vs-hand-port results below record the parity work before commit
502bd84; the hand-ports were removed after that sweep, and the harness now runs
only the graph session.

- [x] Export every authored graph: `scripts/export-all-graphs.py` writes all 51
      documents' graphs to `.local/original/graphs/` (never committed).
- [x] Coverage harness: `tests/original-graph-coverage.test.ts` loads every
      exported graph and steps it 120 frames with the full behavior registry,
      proving unknown behaviors stay inert and no graph throws. The
      unimplemented-behavior work queue is generated by
      `scripts/graph-coverage.mjs` into `.local/reference/graph-coverage.md`
      and `docs/graph-coverage.md`.
- [x] Filled the gameplay gaps it found: TT physics (`Set Physics Spring`,
      `Set Physics Ball Joint`, `De Physicalize`, `Physicalize Walls`,
      `Physics Force`), the spring binding on both backends, and the
      script/array set (`Iterator`, `Create String`, `Counter`, `Calculator`,
      `Random`, `Switch On Message`, `Set Parent`, `Add To Group`, `Test Cell`).
- [x] Per-module equivalence harness (first pass): `tests/original-graph-equivalence-swing.test.ts`
      and `tests/original-graph-equivalence-lift.test.ts` run the authored swing, lift
      and sack graphs beside their hand-port recovered data and report, field by
      field, what matches. The **construction payloads match exactly** (body
      settings, hinge, slider, spring, ball joints, force directions/values).
- [x] Runtime wiring fixes the equivalence pass surfaced:
  - activation links now propagate from `inIO` sources as well as `outIO`, so
    root/compound `Start` activation reaches children;
  - parameter-in **source references** are exported (`source`) and read live,
    so `Get Cell` -> `Binary Switch` conditions follow the value;
  - **link delays** (`type & 0xffff`) are modelled, so Loop Out -> Loop In
    cycles run across frames instead of collapsing into one;
  - `OriginalSession` launches the roots once (`activateNow`), with `_Init`
    first; multi-frame scripts stay alive through `wait()` and link delays. The low-level runtime keeps `frameRoots` for explicit re-activation
    in coverage tests. Activation loops are capped and reported via
    `runtime.warnings`.
- [x] Non-root **compound** scripts now expand: activating a compound propagates
      its activated `inIO` into the internal graph, so a reached compound (e.g.
      `Physicalize and Swing`) constructs its authored physics. A compound's
      children take precedence over a same-named primitive behavior.
- [x] Serialized **parameter-out links** (chunk `0x20`) are exported and applied
      by the runtime, and behavior targets follow their live parameter source.
      This is the module `Init` path: `Op/Convert("CurrentLevel")` writes the
      `CurrentLevel Array` variable, so `Get Cell` targets the recovered array.
- [x] **Data Arrays from recovered level data**: `scripts/export-original-arrays.py`
      decodes `Gameplay/CurrentLevel` (level id, ball refs, reset point,
      `Activation Phase?`, points) and `Levelinit/AllLevel` (twelve level rows).
      `originalCurrentLevelRows(level)` and `installOriginalDataArrays` feed them
      to the session binding.
- [x] Module graphs **self-activate from their roots**: the swing, lift and sack
      equivalence tests activate `_Init` then the module script once. They now
      construct the same bodies, joints, springs and drive timeline as the
      hand-port, including the four 500 ms swing stages.
- [x] Module source selection and the first graph-driven module host: the
      harness `module` selection pins the matching placement from the generated
      graph and frame catalog. The Rapier `stage8_swing` graph run matches all
      8 scenario assertions and is bit-identical with `--repeat 2`.
- [x] Rapier same-solver parity for `stage8_swing`: graph vs hand-port is
      bit-identical (zero position/orientation/velocity divergence, declared
      tolerance) with bit-identical graph repeats. The module keeps its Rapier
      body/collider handles and fixed joint anchors across engine resets,
      rounds hull points before transformation, and treats a force positioned
      in its own body frame as body-local.
- [x] Native IVP graph module host: the native runtime skips the selected
      hand-port assembly, creates its bodies in the original-unit world, steps
      the graph before `world.step`, and registers its bodies with the existing
      visual/sound/observer parts. The native binding now has an original-units
      mode, fixed joint supports, and a startup-force deferral; graph timers use
      float32 milliseconds. `stage8_swing` passes graph-vs-hand-port on both
      solvers with bit-identical repeats.
- [x] Same-solver parity for `stage8_sack` on both solvers: graph vs hand-port
      is bit-identical (position/orientation/velocity deltas 0) with
      bit-identical repeats. This required matching the authored timing
      semantics: initial activations do not advance `TimerMini` while the level
      is still loading, a construction-time `wait()` resumes on the first
      script frame, and the sack hand-port re-arms its Delayer on the switch
      frame instead of carrying the finished period's overshoot. Graph joints
      also keep the recovered frame pivot in double precision until it becomes
      a body-local anchor, and the IVP sack uses a direct world joint rather
      than the fixed sphere support used by the swing. Harness orientation
      comparisons normalize backend quaternions before measuring the angle, so
      small norm defects no longer look like rotation differences.
- [x] Same-solver parity for the `P_Modul_03` lift: Rapier graph vs hand-port
      is bit-identical on all four lift scenarios (`stage7/9/10/12_lift`) with
      bit-identical repeats. The graph now resolves the authored
      `Ball_Pos_Frame Frame` object and `P_Modul_03_MF` frame, receives
      level-aware `CurrentLevel` rows with the ball frame cell filled, keys
      shared hull meshes by target (the seven walls reuse one mesh at different
      rotations), creates Rapier springs as the recovered per-frame impulses
      rather than Rapier joints, releases frozen loose weights on the authored
      WakeUp, and reorders the hand-port's lift parts to the authored
      `Physicalize` chain so both paths create IVP bodies in the same order.
      IVP also reuses the module's fixed joint support for its spring and
      creates compound bodies for single hulls like the native hand-port.
- [x] IVP lift residual declared explicitly: once the ball enters the loose
      wall cage the native solver orders the contact island differently, so
      `stage7/9/10_lift` use the scenario-declared `LIFT_VARIANT` tolerance
      (max position 0.009, orientation 0.018, velocity 0.18) instead of
      loosening the global comparator. `stage12_lift` is bit-identical. All
      lift assertions still pass and every graph run is repeat-2 deterministic.
- [x] Shared Rapier sector lifecycle: graph modules still construct their
      bodies at level load so creation order matches the hand-port, but leave
      them disabled with joints/forces/springs deferred. On sector activation
      they enable the authored bodies, install the authored joints and run the
      module script; leaving the sector restores the authored poses and body
      kinds, removes controllers and disables the bodies while keeping their
      handles. A module whose script state was reset restarts on activation;
      a WakeUp released during that activation survives the Physicalize pass.
      `P_Modul_29` now matches the hand-port bit-for-bit on Rapier for all nine
      bridge scenarios and on IVP for `stage2/3/4/8/9/10/11_bridge`.
      `stage6_bridge` and `stage7_bridge` retain their pre-existing native IVP
      residual (max position 0.0028/0.0047, orientation 0.0092/0.0845,
      linear velocity 0.215/0.226, angular velocity 0.108/0.113); the
      comparator reports it instead of masking it.
- [x] Chain collision, material test and break path: `CurrentLevel[0][1]`
      carries the live `Ball_Wood`/`Ball_Stone`/`Ball_Paper` name, the runtime
      binding exposes `activeBall`, `Test` compares strings and resolves the
      chain's unwritten `Pout 0` operand from that live name, and `Wave Player`
      uses the live target plus its authored loop flag. The native IVP graph
      object binding now samples physicalized parts from the original-unit
      world state instead of the render-space visual mesh, so the chain's inner
      proximity sees Platte06. `stage2_bridge_stone` releases the
      Platte07-Platte06 hinge at the same tick and matches bit-for-bit on both
      solvers.
- [x] Passive hinges (`P_Modul_19/25/30/37/41`): the authored graphs match the
      hand-port construction for all 118 level placements (body pose, mass,
      collider hulls and joint anchors), and five staged harness scenarios are
      bit-identical on both solvers with repeat-2 determinism. Start-frozen
      hinges use the authored anchor frame, `wakeJoints: false`, the native
      direct world joint (`fixedJointSupport: false`), and defer external-player
      sampling during an activation restart so their proximity poll matches the
      hand-port. `stage7_hinge_41` keeps its always-dynamic flap at rest without
      an invented motor.
- [x] Slider (`P_Modul_34`): `stage1_slider` pushes the free crate away, drops
      the stone along the authored Frame01 -> Frame02 axis, and keeps it within
      the prismatic joint on both solvers; graph vs hand-port is bit-identical
      with repeat-2 determinism. The graph uses sleep-mode crate release,
      authored anchors, direct native world joints and the same no-wake joint
      registration as the hand-port.
- [x] Pusher (`P_Modul_01`): `stage1_pusher` matches the hand-port bit-for-bit
      on Rapier and all assertions pass. The Rapier hand-port now creates the
      Filler/Rinne guides as fixed bodies in authored order and uses the same
      four solver iterations, so graph and hand-port bodies/colliders match.
      The native IVP graph retains a small pre-existing residual (max pose
      0.0059) while the gate travel and assertions match.
- [x] Fan airflow (`P_Modul_18`): the exporter now decodes node 293's target
      class independently of the version bit, `Box Box Intersection` and
      `Row Search` are implemented, and graph bindings expose the live
      `Ball_<Material>` object/bounds/body plus original-unit IVP mesh frames.
      All generated fan-lift scenarios (`stage3..12_fan_lift`) and the Level 2
      two-fan transfer are exact on both solvers with graph/hand repeat-2
      determinism. The native runtime now hosts an array of graph modules, so
      several fans can overlap; it keeps the hand fan mesh for native visuals
      but disables its physics and sound when the graph owns that placement,
      and `activeFanNames` lists every active graph fan. Rapier graph modules
      hide the fan's collision proxy, render the authored rotor (including the
      Rotate axis referential), and run the two `PlanarParticleSystem` smoke
      layers with the recovered emission/size/color/lifespan settings.
      `Wave Player` uses the live target and loop input, `TT
      ProximityVolumeControl` applies its per-frame gain through the audio
      binding, and `Activate Script`/`Deactivate Script` now restart and stop
      the named particle script (resetting its waits and effects) instead of
      only gating future activations. `Misc_Ventilator_01..04` map to the
      recovered `Misc_Ventilator` recording; native fan voices are keyed by
      module instance so overlapping fans do not share gain.
- [x] Finish/ending (`PE_Balloon`): graph vs hand-port is bit-identical on
      Rapier and IVP for `stage1..12_finish_ride` with repeat-2 determinism and
      all scenario assertions pass. The graph now reproduces the native solver
      settings the hand-port used (no extra solver iterations, collider-derived
      single-hull mass, shared module anchor), keeps the saved ten-frame outer
      proximity countdown, starts controllers on the tick after creation,
      skips impulses on the frame a body is woken, and applies an external
      force referential as a fixed world point (the ending's rope forces).
      `enableCollision = false` now uses the empty collision-group mask instead
      of disabling the collider, so collider-derived mass survives. The graph
      session hosts the ending as an authored document. Harness finish
      scenarios select the real `PE_Balloon_01` placement. The recovered
      UFO/claw presentation and ending camera are created for both solvers;
      the Level 12 UFO stage assertions now run on both.
- [x] Finish hand-port removed. The graph session loads the exported
      `PE_Balloon` graph on every level load and hosts it beside the other
      authored documents. The former finish adapters and presentation views are
      gone; harness observers select graph modules by authored kind and pinned
      instance instead of assuming the first one.
- [x] Default graph hosting for every matched module family. The graph session
      loads all authored module graphs and hosts every placement from its graph
      on both solvers. The hand-port mechanism classes (lift, slider, arms,
      swing, sack, chain, hinges, pusher and their IVP adapters) are deleted. The native
      backend renders graph bodies from a generic authored-mesh builder, and
      native fan rotor/particles are driven by the graph effect binding. Lift wall bodies are registered with
      the original depth cleanup on both backends (the travelling platform is
      excluded). All 87 harness scenarios pass on both solvers;
      observers resolve the scenario's selected module instance before falling
      back to the first placement of a kind.
- `TT Restore IC` / `Restore IC` restore through `GraphBinding.restoreInitial`.
      Both DLLs fire Out, then ask the context scene for the target's saved
      initial state and call `CKReadObjectState` only when the scene holds one;
      `TT Restore IC` input 0 also visits every descendant (`HierarchyParser`).
      No shipped NMO/CMO contains a CKScene object or initial-value chunk, so a
      loaded entity's initial state is the one captured when it entered the
      scene: both module hosts snapshot each authored visual's pose and
      visibility at load and restore from that snapshot. A behavior without a
      target acts on its script owner, the document's `<Document>_MF` entity
      (the only hierarchy root of every module document). Physicalized parts
      keep following their body, as the physics manager re-drives the entity.
      Unknown entities and stale exports without a hierarchy fail loudly. The
      sector lifecycle still resets bodies itself, so no validated scenario
      exercises the Physicalize deactivation branch that reaches this node.
- Menu and HUD: the original-art sprite renderer (per-eye stereo overlay with the
      UI Depth slider, see `original-ui.md`) draws them from the recovered
      CK2dEntity data. The graph session runs `Menu.nmo` and `Gameplay.nmo`;
      the 2D behaviors (`Set 2D Material`, `TT Set_2DSprite`, `Text Display`,
      `TT PushButton2`) are implemented in `src/game/original-graph-menu.ts`
      and `src/game/original-graph-interface.ts`.
      The tutorial script is hosted: `2D Text`, `Set Font Properties`,
      `TT CreateFontEx`, `Load String`, `TT_SplitString`, `Get Row`/`Set Row`,
      `Set Physics Globals`, `TT LookAt` and `Streaming Event` are implemented
      for it through `GraphTutorialBinding`
      (`src/game/original-graph-tutorial.ts`). `TT LookAt` (execution
      0x10010E00, core 0x10011190) reads Position, Referential, Following Speed,
      Hierarchy, Look X/Y/Z and the Time Based/Direction/Roll locals. It
      interpolates the selected local axis (X for Direction 1/2, Y for 3/4,
      Z for 5/6) toward the aim by `speed * deltaMs * 0.07` (capped at 1),
      rebuilds the right-handed basis and calls SetOrientation; Roll then calls
      Rotate3f. Direction values 2/4/6 look along the negative axis end, Look
      X/Y/Z drop that delta component, and `Hierarchy` is read but unused by the
      DLL. The CK3dEntity vtable slots used are +0x108 Rotate3f, +0x128
      GetPosition, +0x12C SetOrientation, +0x130 GetOrientation, +0x140
      SetScale, +0x144 GetScale and +0x17C Transform. The score (`Menu_Score`)
      host still reads the recovered chapter/timing data directly, and the menu
      backdrop plays the authored camera curve, ball recording and ambience;
      see `docs/original-ui.md`.
- [x] Runtime prerequisites for hosting the core documents: exported
      prototype GUIDs, decoded message names and script owners, fail-loud
      dispatch with explicit per-document inert lists, the shared
      CKMessageManager bus with owner-addressed delivery, `TT_Debug`
      (TT_Toolbox_RT `Debug.cpp`: console/log output only while debug mode is
      on, then Exit; the port passes through) and `Get Key Row`
      (Logics `GetArray.cpp`). Turning dispatch strict surfaced two silent
      skips: the tutorial host's `Keyboard` row copy continued into
      Gameplay_Refresh's ball-physics `Get Key Row`, whose array target only
      `Gameplay_Init` resolves (the host now runs the copy isolated), and the
      unhosted P_Extra_Life graph reaches `SphericalParticleSystem` (the
      Blob/Fizz particles, now ported: [original-particles.md](original-particles.md))
      and `TT_TextureSine` (ported; each placed extra life now runs the graph).
- `Set Light Color` (Lights.dll execution 0x25401110) reads its single CKColor
      input and calls `CKLight::SetColor` for the target through
      `GraphBinding.light`. The exporter already decodes the authored color
      chunks (GUID ee2fd457:913bbb7c); the DLL prototype's default is
      `255,255,255,255`, so an unconnected color input keeps white instead of
      going inert. A target without a registered light binding fails loudly.

## Coverage

Implemented and tested: the runtime core (activation + data propagation, next
frame scheduling, compound expansion), the graph and Data Array exporters, the
pure data/logic primitives, the full physics/script/effect behavior sets, the
object resolver and both physics bindings.

Current state:

1. Every matched family (swing, sack, lift, arms, chain including the stone
   break, five passive hinge kinds, slider, pusher, fan including the Level 2
   transfer, and the ending) runs from its authored graph by default on both
   solvers. The hand-port mechanism classes are deleted; the graph-driven
   module construction path, the sector lifecycle, the script-frame clock, the
   authored proximity wake, the script/particle/audio bindings, multi-graph
   hosting and the native mesh builder are in place.
2. `TT Restore IC`, `TT ProximityVolumeControl`, `PlanarParticleSystem` and
   `Set Light Color` are implemented. The 2D UI behaviors are intentionally left
   to the React interface (see above).
3. Decode the remaining opaque parameter locals in the exporter as new graphs
   need them.

The generated `.local/reference/behavior-matrix.md` is the work queue; its
`Known` column is read from `ORIGINAL_BEHAVIORS`, so it refreshes with the
runtime registry instead of a hand-maintained list.
