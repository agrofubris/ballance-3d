# Changelog

## [1.0.0] - 2026-11-03

First public release.

### Game
- All twelve levels, the menus, the Level 1 tutorial, HUD, music and sound run from the
  original NMO/CMO behaviour graphs of the player's own installed copy, on a generic
  Virtools graph runtime. No game files are included.
- Physics on the built-in Rapier solver, or on the original IVP engine when the player
  builds its module (`Build-IVP.bat`).

### Display
- Stereo 3D: side-by-side and top-and-bottom (half and full), cross-view, row-interlaced
  in both eye orders, and Leia SR panels through the SR Platform. The 2D interface is drawn in both eyes,
  with a depth that scales with the stereo separation.
- Widescreen modes, resolution choice and fullscreen; a full-screen-sized mode opens
  fullscreen.

### Controls
- Keyboard and gamepad with rebinding. The gamepad drives the menus (A selects, B goes
  back), the port's panels and the tutorial (X quits it), with optional analog steering.

### Setup
- Desktop app with a one-click importer for an installed Ballance folder.
- `Setup-Ballance.bat` for a source checkout: portable tools, import and browser play.

### Credits
- Inspired by [fayazara/ballance](https://github.com/fayazara/ballance) by Fayaz Ahmed.
- Original game: Ballance by Cyparade, published by Atari.
