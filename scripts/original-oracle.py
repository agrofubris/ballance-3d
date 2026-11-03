#!/usr/bin/env python3
"""Run the user's original game files as a short, windowed oracle and trace the ball.

Windows only. The user's install is never modified: `setup` builds a mirror under
.local/oracle/mirror (copied Bin DLLs, base.cmo and Database.tdb, junctions for the
data folders) and installs a separately downloaded, user-approved BallancePlayer
v0.3.9 launcher (doyaGu/BallancePlayer, MIT). The original Player.exe is not used:
it only runs in exclusive fullscreen. Player.ini disables BallancePlayer's script
hotfixes and frame-rate unlock, so the original scripts run unmodified.

`trace` starts a level, sends the menu keys only while the game window is verified to
be in the foreground (then hands focus back), and samples float32 position triplets
of the ball from process memory. Results go to .local/oracle/runs/ and must never be
committed. Requires Pillow only for --capture-every.
"""
import argparse
import ctypes
import ctypes.wintypes as W
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
ORACLE = ROOT / '.local' / 'oracle'
MIRROR = ORACLE / 'mirror'
BIN = MIRROR / 'Bin'
# BallancePlayer-0.3.9.0-msvc2022-x86.zip (release asset digest 01228e93...eddc4) -> Player.exe
PLAYER_SHA256 = '72ad4e38174af7634679c741701c46ad5099195cac66710411290aa65fcd306e'
DATA_DIRS = ['3D Entities', 'BuildingBlocks', 'Managers', 'Plugins', 'RenderEngines', 'Sounds', 'Sounds_low', 'Textures', 'Text']
PLAYER_INI = {
    'Startup': {'LogMode': 1, 'Verbose': 1, 'ManualSetup': 0},
    'Graphics': {'Driver': 0, 'BitsPerPixel': 32, 'Width': 640, 'Height': 480, 'FullScreen': 0},
    'Window': {'X': 1250, 'Y': 420, 'ChildWindowRendering': 0, 'Borderless': 0, 'ClipCursor': 0, 'AlwaysHandleInput': 0},
    'Game': {'Language': 1, 'SkipOpening': 0, 'ApplyHotfix': 0, 'UnlockFramerate': 0, 'UnlockWidescreen': 0,
             'UnlockHighResolution': 0, 'Debug': 0, 'Rookie': 0},
}
# Verified menu paths: seconds after launch for the first key, then the key sequence.
LEVELS = {1: {'menuSeconds': 14.0, 'keys': ['enter', 'enter'], 'spawn': (54.0956, 17.6565, -153.0718)}}

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32
g32 = ctypes.windll.gdi32


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def setup(install: Path, player: Path):
    if sha256(player) != PLAYER_SHA256:
        raise SystemExit(f'{player} is not the scanned BallancePlayer v0.3.9 Player.exe (sha256 {PLAYER_SHA256})')
    if not (install / 'base.cmo').is_file() or not (install / 'Bin' / 'CK2.dll').is_file():
        raise SystemExit(f'{install} does not look like a Ballance install (base.cmo, Bin/CK2.dll)')
    BIN.mkdir(parents=True, exist_ok=True)
    for dll in (install / 'Bin').glob('*.dll'): shutil.copy2(dll, BIN / dll.name)
    for name in ['base.cmo', 'Database.tdb']: shutil.copy2(install / name, MIRROR / name)
    for name in DATA_DIRS:
        link, target = MIRROR / name, install / name
        if not target.is_dir(): raise SystemExit(f'missing {target}')
        if not link.exists(): subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)], check=True, capture_output=True)
    shutil.copy2(player, BIN / 'Player.exe')
    (BIN / 'Player.ini').write_text(''.join(f'[{section}]\r\n' + ''.join(f'{k}={v}\r\n' for k, v in keys.items())
                                            for section, keys in PLAYER_INI.items()), encoding='ascii')
    print(f'Mirror ready at {MIRROR}')


def text(h):
    b = ctypes.create_unicode_buffer(256); u32.GetWindowTextW(h, b, 256); return b.value


def windows_of(pid):
    found = []

    @ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def visit(h, _):
        owner = W.DWORD(); u32.GetWindowThreadProcessId(h, ctypes.byref(owner))
        if owner.value == pid and u32.IsWindowVisible(h): found.append(h)
        return True
    u32.EnumWindows(visit, 0)
    return found


def game_window(pid, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        hs = windows_of(pid)
        if hs: return hs[0]
        time.sleep(.2)
    raise RuntimeError('no game window')


def capture(h, path):
    """PrintWindow of the game window only; never the desktop."""
    from PIL import Image
    r = W.RECT(); u32.GetClientRect(h, ctypes.byref(r)); w, hh = r.right, r.bottom
    wdc = u32.GetWindowDC(h); dc = g32.CreateCompatibleDC(wdc); bm = g32.CreateCompatibleBitmap(wdc, w, hh)
    g32.SelectObject(dc, bm); u32.PrintWindow(h, dc, 3)
    header = struct.pack('<IiiHHIIiiII', 40, w, -hh, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * hh * 4)
    g32.GetDIBits(dc, bm, 0, hh, buf, ctypes.create_string_buffer(header, 44), 0)
    g32.DeleteObject(bm); g32.DeleteDC(dc); u32.ReleaseDC(h, wdc)
    Image.frombuffer('RGBA', (w, hh), buf, 'raw', 'BGRA', 0, 1).convert('RGB').save(path)


class KI(ctypes.Structure):
    _fields_ = [('wVk', W.WORD), ('wScan', W.WORD), ('dwFlags', W.DWORD), ('time', W.DWORD), ('extra', ctypes.c_size_t)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', W.DWORD), ('ki', KI), ('pad', ctypes.c_ubyte * 8)]


SCAN = {'enter': 0x1C, 'down': 0x50, 'up': 0x48}
EXTENDED = {'down', 'up'}


def focus(h):
    fg = u32.GetForegroundWindow()
    if fg == h: return True
    me, them = k32.GetCurrentThreadId(), u32.GetWindowThreadProcessId(fg, None)
    u32.AttachThreadInput(me, them, True)
    u32.ShowWindow(h, 9); u32.BringWindowToTop(h); u32.SetForegroundWindow(h)
    u32.AttachThreadInput(me, them, False)
    time.sleep(.2)
    return u32.GetForegroundWindow() == h


def key(h, name, hold=.12):
    """DirectInput reads scan codes. Refuse to type unless the game has focus."""
    if not focus(h): raise RuntimeError('game window is not in the foreground; key not sent')
    flags = 0x0008 | (0x0001 if name in EXTENDED else 0)
    for up in (0, 0x0002):
        if u32.GetForegroundWindow() != h: raise RuntimeError('focus lost; key not sent')
        event = INPUT(1, KI(0, SCAN[name], flags | up, 0, 0))
        u32.SendInput(1, ctypes.byref(event), ctypes.sizeof(event))
        if not up: time.sleep(hold)


def give_back(previous):
    if previous and u32.IsWindow(previous):
        me, them = k32.GetCurrentThreadId(), u32.GetWindowThreadProcessId(u32.GetForegroundWindow(), None)
        u32.AttachThreadInput(me, them, True); u32.SetForegroundWindow(previous); u32.AttachThreadInput(me, them, False)


class Memory:
    """Read-only view of the game's committed writable memory."""
    def __init__(self, pid):
        self.h = k32.OpenProcess(0x0410, False, pid)  # QUERY_INFORMATION | VM_READ
        if not self.h: raise OSError('OpenProcess failed')

    def regions(self):
        class MBI(ctypes.Structure):
            _fields_ = [('Base', ctypes.c_void_p), ('AllocBase', ctypes.c_void_p), ('AllocProtect', W.DWORD),
                        ('Size', ctypes.c_size_t), ('State', W.DWORD), ('Protect', W.DWORD), ('Type', W.DWORD)]
        address, info = 0, MBI()
        while address < 0x7FFF0000 and k32.VirtualQueryEx(self.h, ctypes.c_void_p(address), ctypes.byref(info), ctypes.sizeof(info)):
            base = info.Base or 0
            if info.State == 0x1000 and info.Protect in (0x04, 0x40) and info.Size < 256 << 20: yield base, info.Size
            address = base + info.Size

    def read(self, address, size):
        buf = ctypes.create_string_buffer(size); got = ctypes.c_size_t()
        if not k32.ReadProcessMemory(self.h, ctypes.c_void_p(address), buf, size, ctypes.byref(got)): return None
        return buf.raw[:got.value]

    def near(self, center, ylo, yhi, radius):
        """Addresses of float32 x,y,z with x,z within radius of center and y in [ylo, yhi]."""
        cx, _, cz = center
        patterns = [re.compile(re.escape(struct.pack('<f', v)[2:])) for v in (cx - radius, cx, cx + radius)]
        hits = []
        for base, size in self.regions():
            data = self.read(base, size)
            if not data: continue
            seen = set()
            for pattern in patterns:
                for match in pattern.finditer(data):
                    i = match.start() - 2
                    if i < 0 or i % 4 or i in seen or i + 12 > len(data): continue
                    seen.add(i)
                    x, y, z = struct.unpack_from('<3f', data, i)
                    if abs(x - cx) < radius and ylo <= y <= yhi and abs(z - cz) < radius: hits.append(base + i)
        return hits


def launch():
    """Each launch uses a freshly named copy: Windows renders an exe path black after its first run."""
    if sha256(BIN / 'Player.exe') != PLAYER_SHA256: raise SystemExit('mirror Player.exe changed; rerun setup')
    exe = BIN / f'P{int(time.time() * 1000)}.exe'
    shutil.copy2(BIN / 'Player.exe', exe)
    process = subprocess.Popen([str(exe), '--config', str(BIN / 'Player.ini')], cwd=BIN)
    process.exe_copy = exe
    return process


def stop(process):
    process.kill(); process.wait(5)
    for _ in range(20):
        try: process.exe_copy.unlink(); break
        except OSError: time.sleep(.25)


def trace(level, seconds, out: Path, capture_every, topmost, fast_scan):
    if level not in LEVELS: raise SystemExit(f'level {level} has no verified menu path yet')
    plan = LEVELS[level]; spawn = plan['spawn']
    out.parent.mkdir(parents=True, exist_ok=True)
    result = {'level': level, 'spawn': spawn, 'player': PLAYER_SHA256, 'ini': PLAYER_INI, 'topmost': topmost,
              'events': [], 'columns': [], 'samples': []}
    process = launch()
    try:
        h = game_window(process.pid); t0 = time.time()
        # Keep the small window uncovered without taking focus: HWND_TOPMOST with
        # SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE.
        if topmost: u32.SetWindowPos(h, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)
        time.sleep(plan['menuSeconds'])
        previous = u32.GetForegroundWindow()
        try:
            for name in plan['keys']: key(h, name); time.sleep(1.5)
        finally: give_back(previous)
        result['events'].append(['menu', time.time() - t0])
        memory = Memory(process.pid)
        # Every candidate is tracked, including those already present at level start:
        # the ball entity can sit at the spawn pose before it is physicalized. Pick the
        # ball afterwards by its motion. Scan back to back for fast_scan seconds so new
        # objects are sampled from their first frames.
        columns, next_scan, next_shot, shot = [], 0, 0, 0
        level_start, end = time.time(), t0 + seconds
        while time.time() < end:
            now = time.time()
            if now > next_scan:
                for address in memory.near(spawn, spawn[1] - 4, spawn[1] + 3, .3):
                    if address not in columns:
                        columns.append(address); result['columns'].append([hex(address), now - t0])
                next_scan = now + (0 if now - level_start < fast_scan else 2)
            row = [now - t0]
            for address in columns:
                raw = memory.read(address, 12)
                row.append(list(struct.unpack('<3f', raw)) if raw and len(raw) == 12 else None)
            result['samples'].append(row)
            if capture_every and now > next_shot:
                capture(h, out.with_name(f'{out.stem}-{shot:03d}.png')); shot += 1; next_shot = now + capture_every
            time.sleep(.01)
    finally:
        stop(process)
        out.write_text(json.dumps(result))
    print(f'{len(result["columns"])} candidate addresses, {len(result["samples"])} samples -> {out}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='command', required=True)
    s = sub.add_parser('setup', help='build the mirror from an install and a scanned BallancePlayer exe')
    s.add_argument('--install', type=Path, default=Path(r'C:\games\ballance'))
    s.add_argument('--player', type=Path, required=True, help='Player.exe from the approved BallancePlayer v0.3.9 zip')
    t = sub.add_parser('trace', help='start a level and sample the ball pose')
    t.add_argument('--level', type=int, default=1)
    t.add_argument('--seconds', type=float, default=120)
    t.add_argument('--out', type=Path, default=ORACLE / 'runs' / 'trace.json')
    t.add_argument('--capture-every', type=float, default=0, help='seconds between window captures (needs Pillow)')
    t.add_argument('--fast-scan', type=float, default=30, help='seconds after the menu keys to scan memory back to back')
    t.add_argument('--topmost', action='store_true', help='keep the game window on top (without focus) so it is not throttled')
    a = parser.parse_args()
    u32.SetProcessDPIAware()
    if a.command == 'setup': setup(a.install, a.player)
    else: trace(a.level, a.seconds, a.out, a.capture_every, a.topmost, a.fast_scan)


if __name__ == '__main__':
    main()
