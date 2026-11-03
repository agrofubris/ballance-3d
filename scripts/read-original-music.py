#!/usr/bin/env python3
"""Describe the original music selection and music timing from the chunk dumps.

The level themes, the ambient recordings, the theme suffixes and the delay, fade
and checkpoint timings are read from the Sound, Levelinit and Musicfiles dumps.
The stored facts the output depends on are verified, then one JSON document is
written.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from original_chunks import ChunkDump, table

DEFAULT_WORK_DIRECTORY = REPO_ROOT / '.local' / 'reference' / 'chunks'
DEFAULT_OUTPUT_DIRECTORY = REPO_ROOT / '.local' / 'original'
OUTPUT_NAME = 'music-data.json'
SOURCE_LABEL = 'Sound.nmo, Levelinit.nmo AllLevel column 7, Musicfiles.nmo'

LEVELINIT_SELECTOR = 69
LEVEL_TABLE = 4055
LEVEL_TABLE_ROWS = 12
THEME_SUFFIX_LIST = 41
SELECTOR_COLUMN = 7
MUSIC_COLUMN = 'Music'
AMBIENT_CLASS = 25
AMBIENT_NAMES = ['Music_Atmo_1', 'Music_Atmo_2', 'Music_Atmo_3']
AMBIENT_PATTERN = re.compile(rb'([A-Za-z0-9_]+)\.wav')

AMBIENT_DELAY = 1329
THEME_DELAY = 1441
THEME_START_DELAY = 1899
MUSIC_FADE = 1575
CHECKPOINT_START = 1764
CHECKPOINT_APPROACH = 1773
CHECKPOINT_FINISH = 1806
RESET_DELAY = 1755
PROXIMITY = 1680
PROXIMITY_AXES_LOCAL = 3


def ensure(condition, detail=''):
    if not condition:
        raise AssertionError(detail)


def resolve(dump, cell):
    if isinstance(cell, dict):
        return dump.value(cell['parameterIndex'])
    return cell


def input_values(dump, index):
    return [dump.value(item) for item in dump.definition(index)['inputs']]


def first_input(dump, index):
    return input_values(dump, index)[0]


def read_level_themes(levelinit):
    rows = table(levelinit.rows[LEVEL_TABLE][2])
    ensure(len(rows) == LEVEL_TABLE_ROWS, 'level table rows')
    return [resolve(levelinit, row[MUSIC_COLUMN]) for row in rows]


def read_ambient(musicfiles):
    names = []
    for stem in AMBIENT_NAMES:
        index = next(index for index, (kind, name, _raw) in musicfiles.rows.items()
                     if kind == AMBIENT_CLASS and name == stem)
        raw = musicfiles.rows[index][2]
        match = AMBIENT_PATTERN.search(raw)
        ensure(match is not None and match.group(1).decode('ascii') == stem, ('ambient', stem))
        names.append(match.group(1).decode('ascii'))
    return names


def read_proximity(sound):
    inputs = input_values(sound, PROXIMITY)
    locals_list = sound.definition(PROXIMITY)['locals']
    return {
        'distance': inputs[0],
        'axes': sound.value(locals_list[PROXIMITY_AXES_LOCAL]),
        'exactnessMin': inputs[4],
        'exactnessMax': inputs[5],
        'minFrameDelay': inputs[6],
        'maxFrameDelay': inputs[7],
    }


def build_document(chunk_directory):
    sound = ChunkDump(chunk_directory / 'Sound.tsv')
    levelinit = ChunkDump(chunk_directory / 'Levelinit.tsv')
    musicfiles = ChunkDump(chunk_directory / 'Musicfiles.tsv')

    ensure(input_values(levelinit, LEVELINIT_SELECTOR)[1] == SELECTOR_COLUMN, 'selector column')
    ensure(len(table(levelinit.rows[LEVEL_TABLE][2])) == LEVEL_TABLE_ROWS, 'level table')
    for index in (1373, 1485):
        ensure(input_values(sound, index) == [1.0, 1.0, 1.0], ('vector inputs', index))
    for index in (1344, 1472):
        ensure(input_values(sound, index) == [0.0, 0.0, False], ('flag inputs', index))
    ensure(input_values(sound, 1649) == [0.0, 0.0, True], 'flagged inputs 1649')

    return {
        'source': SOURCE_LABEL,
        'levelThemes': read_level_themes(levelinit),
        'ambient': read_ambient(musicfiles),
        'themeSuffixes': [levelinit.value(item) for item in levelinit.definition(THEME_SUFFIX_LIST)['inputs']],
        'ambientDelayMs': input_values(sound, AMBIENT_DELAY),
        'themeDelayMs': input_values(sound, THEME_DELAY),
        'themeStartDelayMs': first_input(sound, THEME_START_DELAY),
        'musicFadeMs': first_input(sound, MUSIC_FADE),
        'checkpointStart': input_values(sound, CHECKPOINT_START),
        'checkpointApproach': input_values(sound, CHECKPOINT_APPROACH),
        'checkpointFinish': input_values(sound, CHECKPOINT_FINISH),
        'resetDelayMs': first_input(sound, RESET_DELAY),
        'proximity': read_proximity(sound),
    }


def parse_arguments():
    work_directory = Path(os.environ.get('BALLANCE_IMPORT_WORK', DEFAULT_WORK_DIRECTORY))
    output_directory = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', DEFAULT_OUTPUT_DIRECTORY))

    parser = argparse.ArgumentParser(description='Read the original music data from chunk dumps.')
    parser.add_argument('dumps', nargs='?', type=Path, default=work_directory)
    parser.add_argument('--out', type=Path, default=output_directory / OUTPUT_NAME)
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    document = build_document(arguments.dumps)

    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    with open(arguments.out, 'w') as handle:
        handle.write(json.dumps(document, indent=2) + '\n')
    print(f'Wrote {arguments.out}')


if __name__ == '__main__':
    main()
