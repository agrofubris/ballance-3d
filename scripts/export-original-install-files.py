#!/usr/bin/env python3
import argparse
import json
import os
import shutil
from pathlib import Path

FILES = [
    'Database.tdb',
    'Sounds/ATARI.wav',
    'Sounds/Music_Theme_1_1.wav',
    'Sounds/Music_Theme_1_2.wav',
    'Sounds/Music_Theme_1_3.wav',
    'Textures/atari.avi',
    'Textures/sky/Sky_C_Back.bmp',
    'Textures/sky/Sky_C_Down.bmp',
    'Textures/sky/Sky_C_Front.bmp',
    'Textures/sky/Sky_C_Left.bmp',
    'Textures/sky/Sky_C_Right.bmp',
    'Textures/sky/Sky_L_Back.bmp',
    'Textures/sky/Sky_L_Down.bmp',
    'Textures/sky/Sky_L_Front.bmp',
    'Textures/sky/Sky_L_Left.bmp',
    'Textures/sky/Sky_L_Right.bmp',
]

parser = argparse.ArgumentParser()
parser.add_argument('--game', required=True, type=Path)
parser.add_argument('--output', type=Path, default=Path(
    os.environ['BALLANCE_IMPORT_OUTPUT']) if 'BALLANCE_IMPORT_OUTPUT' in os.environ else Path('.local/original'))
args = parser.parse_args()
game = args.game.resolve()
output = args.output.resolve() / 'install'
for name in FILES:
    source = game / name
    if not source.is_file():
        raise SystemExit(f'Missing install file: {source}')
    target = output / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def wave_rate(path):
    """WAVEFORMATEX nSamplesPerSec of a RIFF WAVE file's fmt chunk: the format
    rate DX7SoundManager's pitch set and read-back divide by (GetFormat)."""
    data = path.read_bytes()
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise SystemExit(f'Not a RIFF WAVE file: {path}')
    offset = 12
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset + 4:offset + 8], 'little')
        if data[offset:offset + 4] == b'fmt ':
            return int.from_bytes(data[offset + 12:offset + 16], 'little')
        offset += 8 + size + (size & 1)
    raise SystemExit(f'No fmt chunk in {path}')


# Every wave sound's format rate, by lower-case file name (the sounds themselves
# are converted to ogg/m4a, which drops the original rate).
rates = {file.name.lower(): wave_rate(file) for file in sorted((game / 'Sounds').glob('*.wav'))}


def registry_settings():
    """The installer's `Ballance\\Settings` values (Language, video mode, ...),
    which base reads through TT_ReadRegistry. The game is a 32-bit program, so
    its HKLM view is WOW6432Node on 64-bit Windows. Empty off Windows or when
    the game was not installed: TT_ReadRegistry then finds nothing."""
    try:
        import winreg
    except ImportError:
        return {}
    values = {}
    for path in (r'SOFTWARE\WOW6432Node\Ballance\Settings', r'SOFTWARE\Ballance\Settings'):
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path)
        except OSError:
            continue
        with key:
            index = 0
            while True:
                try:
                    name, value, kind = winreg.EnumValue(key, index)
                except OSError:
                    break
                index += 1
                if kind == winreg.REG_DWORD or kind == winreg.REG_SZ:
                    values.setdefault(name, value)
    return values


registry = registry_settings()
(output / 'files.json').write_text(json.dumps({'files': FILES, 'waveRates': rates, 'registry': registry}, indent=2) + '\n')
print(f'Install registry settings: {sorted(registry) or "none"}')
print(f'Install files ready: {output} ({len(FILES)} files)')
