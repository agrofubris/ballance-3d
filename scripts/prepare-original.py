#!/usr/bin/env python3
"""Assemble the local asset pack from a Ballance installation.

Runs the chunk dumper, the BMap-based extractor, the image and audio
converters and every reader or exporter script in a fixed order, then writes
the pack manifest. All output is local data; nothing here is committed.

Usage:
  prepare-original.py --game <game> --library <BMap.dll> --dump-chunks <exe>
                      [--output <dir>] [--work <dir>] [--no-ffmpeg]

Each phase prints a "STEP n/26 <name>" line before it starts; the desktop
importer parses those lines, so the format and the total must stay fixed.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
from original_images import convert_image as convert_image_stdlib  # noqa: E402
STEP_TOTAL = 24
LEVEL_COUNT = 12

TEXTURES_TGA = [
    'DomeShadow', 'Trafo_Shadow_Big', 'Laterne_Schatten', 'Modul18_Gitter',
    'Stick_Bottom', 'Column_beige_fade', 'Button01_deselect',
    'Button01_select', 'Button01_special', 'Font_1', 'Cursor', 'Pfeil',
    'Tut_Pfeil01', 'Tut_Pfeil_Hoch', 'Wolken_intro',
]
TEXTURES_BMP = ['Particle_Flames', 'Gravitylogo_intro']

AUDIO_FIXED = [
    'Music_Theme_1_1', 'Music_Atmo_1', 'Misc_Checkpoint', 'Misc_StartLevel',
    'Misc_Fall', 'Misc_Trafo', 'Misc_Ventilator', 'Misc_extraball',
    'Extra_Hit', 'Extra_Start', 'Music_EndCheckpoint', 'Roll_Wood_Stone',
    'Roll_Stone_Stone', 'Roll_Paper',
]
ROLL_BALLS = ['Wood', 'Stone']
ROLL_SURFACES = ['Wood', 'Metal']
AUDIO_MISC = ['Misc_RopeTears', 'Misc_UFO_anim', 'Misc_Lightning']
AUDIO_MENU = ['Menu_click', 'Menu_dong', 'Menu_load', 'Menu_counter', 'Menu_atmo']
AUDIO_ATARI = ['ATARI']
AUDIO_FINAL = ['Music_Final', 'Music_LastFinal']

# (step number, step name, script file) for the exporter loop.
EXPORT_STEPS = [
    (12, 'Export behavior graphs', 'export-all-graphs.py'),
    (13, 'Export Data Arrays', 'export-original-arrays.py'),
    (14, 'Export object tables', 'export-original-objects.py'),
    (15, 'Read hinge data', 'read-original-hinges.py'),
    (16, 'Read transformer clock', 'read-original-transformer-clock.py'),
    (17, 'Generate harness stages', 'generate-harness-stages.py'),
]

# Camera and collision readers: stdout is redirected to a file.
CAMERA_READERS = [
    ('read-original-camera.py', 'camera-data.json'),
    ('read-original-collisions.py', 'collision-data.json'),
]

DUMP_SUFFIX = '.nmo'


class Pack:
    """Holds the resolved locations and the running step counter."""

    def __init__(self, game, library, dumper, output, work, no_ffmpeg):
        self.game = game
        self.library = library
        self.dumper = dumper
        self.output = output
        self.work = work
        self.no_ffmpeg = no_ffmpeg
        self.step_no = 0
        self.entities = None

    def step(self, name):
        self.step_no += 1
        print(f'STEP {self.step_no}/{STEP_TOTAL} {name}', flush=True)

    def python(self, script, *args, stdout=None):
        command = [sys.executable, str(SCRIPTS / script), *map(str, args)]
        subprocess.run(command, check=True, stdout=stdout)

    def extractor(self, *extra):
        self.python('extract-original.py',
                    '--library', self.library,
                    '--game', self.game,
                    '--output', self.output,
                    '--work', self.work,
                    *extra)

    def ffmpeg(self, *args):
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', *map(str, args)],
                       check=True)

    def convert_image(self, source, target):
        if self.no_ffmpeg:
            convert_image_stdlib(source, target)
        else:
            self.ffmpeg('-i', source, target)

    def json_out(self, script, name):
        self.python(script, self.work, '--out', self.output / name)

    def load_json(self, name):
        return json.loads((self.output / name).read_text(encoding='utf-8'))


def parse_args(argv):
    parser = argparse.ArgumentParser(description='Build the local Ballance asset pack.')
    parser.add_argument('--game', required=True, help='Ballance game folder')
    parser.add_argument('--library', required=True, help='path of the BMap shared library')
    parser.add_argument('--dump-chunks', required=True, dest='dumper',
                        help='chunk dumper executable')
    parser.add_argument('--output', default='.local/original',
                        help='output directory (default: .local/original)')
    parser.add_argument('--work', default=None,
                        help='chunk dump and scratch directory '
                             '(default: <repository>/.local/reference/chunks)')
    parser.add_argument('--no-ffmpeg', action='store_true',
                        help='convert images and audio with the standard library')
    args = parser.parse_args(argv)
    args.library = str(Path(args.library).resolve())
    args.dumper = str(Path(args.dumper).resolve())
    args.output = Path(args.output).resolve()
    args.work = Path(args.work).resolve() if args.work else REPO_ROOT / '.local' / 'reference' / 'chunks'
    return args


def check_game_folder(pack):
    pack.step('Check game folder')
    game = Path(pack.game)
    entities = game / '3D Entities'
    if not entities.is_dir():
        entities = game / '3D_Entities'
    if not entities.is_dir():
        sys.exit(f'Missing {game / "3D_Entities"}')
    if not (game / 'base.cmo').is_file():
        sys.exit(f'Missing {game / "base.cmo"}')
    pack.entities = entities


def dump_document(pack, document, stem):
    for flag, suffix in (([], '.tsv'), (['--managers'], '.managers')):
        result = subprocess.run([pack.dumper, str(document), *flag], check=True,
                                capture_output=True)
        target = pack.work / (stem + suffix)
        with open(target, 'w', encoding='latin-1', newline='\n') as handle:
            handle.write(result.stdout.decode('latin-1'))


def dump_chunks(pack):
    pack.step('Dump chunk tables')
    pack.work.mkdir(parents=True, exist_ok=True)
    documents = sorted(p for p in pack.entities.rglob('*')
                       if p.is_file() and p.suffix.lower() == DUMP_SUFFIX)
    for document in documents:
        dump_document(pack, document, document.stem)
    dump_document(pack, Path(pack.game) / 'base.cmo', 'base')


def extract_levels(pack):
    pack.step('Extract levels')
    pack.extractor()


def extract_entities(pack):
    pack.step('Extract shared entities')
    pack.extractor('--entities')


def extract_transformer(pack):
    pack.step('Extract transformer meshes')
    pack.extractor('--transformer')


def extract_menu(pack):
    pack.step('Extract menu scene')
    pack.extractor('--menu')


def extract_level_geometry(pack):
    pack.step('Extract level geometry')
    document = pack.entities.relative_to(pack.game).as_posix() + '/Levelinit.nmo'
    pack.extractor('--document', document)


def convert_textures(pack):
    pack.step('Convert textures')
    textures = Path(pack.game) / 'Textures'
    out = pack.output
    (out / 'textures').mkdir(parents=True, exist_ok=True)
    (out / 'sky').mkdir(parents=True, exist_ok=True)
    (out / 'audio').mkdir(parents=True, exist_ok=True)
    for name in TEXTURES_TGA:
        pack.convert_image(textures / f'{name}.tga', out / 'textures' / f'{name}.png')
    for name in TEXTURES_BMP:
        pack.convert_image(textures / f'{name}.bmp', out / 'textures' / f'{name}.png')
    sky_suffix = '.png' if pack.no_ffmpeg else '.jpg'
    for source in sorted((textures / 'sky').glob('*.bmp')):
        pack.convert_image(source, out / 'sky' / (source.stem + sky_suffix))


def read_music_and_audio(pack):
    pack.step('Read music data')
    pack.json_out('read-original-music.py', 'music-data.json')
    pack.step('Read audio data')
    pack.json_out('read-original-audio.py', 'audio-data.json')


def audio_names(pack):
    music = pack.load_json('music-data.json')
    materials = pack.load_json('audio-data.json')['materials']
    names = list(AUDIO_FIXED)
    names += [f'Roll_{ball}_{surface}' for ball in ROLL_BALLS for surface in ROLL_SURFACES]
    names += AUDIO_MISC + AUDIO_MENU + AUDIO_ATARI
    names += music['ambient']
    names += AUDIO_FINAL
    for theme in sorted(set(music['levelThemes'])):
        for suffix in music['themeSuffixes']:
            names.append(f'Music_Theme_{theme}{suffix}')
    for row in materials.values():
        names.extend(row.values())
    return list(dict.fromkeys(names))


def convert_audio(pack):
    pack.step('Convert audio')
    sounds = Path(pack.game) / 'Sounds'
    target_dir = pack.output / 'audio'
    for name in audio_names(pack):
        source = sounds / f'{name}.wav'
        if pack.no_ffmpeg:
            shutil.copyfile(source, target_dir / f'{name}.wav')
            continue
        pack.ffmpeg('-i', source, '-c:a', 'libvorbis', '-q:a', '3',
                    target_dir / f'{name}.ogg')
        pack.ffmpeg('-i', source, '-c:a', 'aac', '-b:a', '96k',
                    '-movflags', '+faststart', target_dir / f'{name}.m4a')


def export_graphs_and_scripts(pack):
    for _number, name, script in EXPORT_STEPS:
        pack.step(name)
        pack.python(script)


def read_interface_and_menu(pack):
    pack.step('Read interface data')
    pack.json_out('read-original-ui.py', 'ui-data.json')
    pack.step('Read menu animation')
    pack.json_out('read-original-menu-animation.py', 'menu-ball.json')


def read_camera_and_collisions(pack):
    pack.step('Read camera and collision data')
    for script, name in CAMERA_READERS:
        with open(pack.output / name, 'w', encoding='utf-8', newline='\n') as handle:
            pack.python(script, pack.work, stdout=handle)


def read_objects_and_player(pack):
    pack.step('Read object and player data')
    pack.json_out('read-original-objects.py', 'object-data.json')
    pack.json_out('read-original-player.py', 'player-data.json')


def copy_tutorial_text(pack):
    pack.step('Copy tutorial text')
    target_dir = pack.output / 'text'
    target_dir.mkdir(parents=True, exist_ok=True)
    text_dir = Path(pack.game) / 'Text'
    for source in sorted(text_dir.glob('Tutorial*.txt')):
        shutil.copyfile(source, target_dir / source.name.lower())


def export_install_files(pack):
    pack.step('Export install files')
    pack.python('export-original-install-files.py',
                '--game', pack.game, '--output', pack.output)


def level_entry(pack, number):
    data = json.loads((pack.output / f'level_{number:02d}.json').read_text(encoding='utf-8'))
    group = next(g for g in data['groups'] if g['name'] == 'PC_Checkpoints')
    difficulty = ('Original course' if number == 1
                  else 'Original course \u00b7 mechanics in progress')
    return {
        'name': f'Level {number:02d}',
        'difficulty': difficulty,
        'checkpoints': group['members'],
    }


def write_manifest(pack):
    pack.step('Write manifest')
    levels = [level_entry(pack, n) for n in range(1, LEVEL_COUNT + 1)]
    manifest = {
        'version': 1,
        'levels': levels,
        'formats': {
            'sky': 'png' if pack.no_ffmpeg else 'jpg',
            'audio': ['wav'] if pack.no_ffmpeg else ['ogg', 'm4a'],
        },
    }
    (pack.output / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')


def main(argv=None):
    args = parse_args(argv)
    pack = Pack(args.game, args.library, args.dumper, args.output, args.work, args.no_ffmpeg)
    os.environ['BALLANCE_IMPORT_OUTPUT'] = str(args.output)
    os.environ['BALLANCE_IMPORT_WORK'] = str(args.work)

    check_game_folder(pack)
    dump_chunks(pack)
    extract_levels(pack)
    extract_entities(pack)
    extract_transformer(pack)
    extract_menu(pack)
    extract_level_geometry(pack)
    convert_textures(pack)
    read_music_and_audio(pack)
    convert_audio(pack)
    export_graphs_and_scripts(pack)
    read_interface_and_menu(pack)
    read_camera_and_collisions(pack)
    read_objects_and_player(pack)
    copy_tutorial_text(pack)
    export_install_files(pack)
    write_manifest(pack)
    print(f'Local asset pack ready: {args.output}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
