#!/usr/bin/env python3
"""Describe the original sound settings and the contact-sound ids of the physical modules.

The Sound and Levelinit dumps supply the material sound table, the rolling
timing, the impact gates and the floor sound groups. Every matching physical
module dump supplies the contact identifiers stored on its objects. The checks
run before the single JSON document is written.
"""
import argparse
import json
import os
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from original_chunks import ChunkDump, chunks, table

DEFAULT_WORK_DIRECTORY = REPO_ROOT / '.local' / 'reference' / 'chunks'
DEFAULT_OUTPUT_DIRECTORY = REPO_ROOT / '.local' / 'original'
OUTPUT_NAME = 'audio-data.json'
SOURCE_LABEL = 'Sound.nmo / Levelinit.nmo / PH object attributes'

TAG_CONTACT = 0x11
ATTRIBUTE_MANAGER_ID = 0x3D242466
HIT_ATTRIBUTE = 'Coll Detection ID'
ROLL_ATTRIBUTE = 'Continuous Contact ID'

SOUND_DUMP = 'Sound.tsv'
LEVELINIT_DUMP = 'Levelinit.tsv'
SOUND_ROLL_DELAY = 392
SOUND_ROLL_DELAY_ALT = 448
SOUND_PITCH_FORMULA = 312
SOUND_GAIN = 342
SOUND_MATERIALS = 2093
LEVELINIT_ROLL_GROUP = 3398
LEVELINIT_HIT_GROUP = 3409
ROLL_GROUP_NAMES = ['Sound_RollID_01', 'Sound_RollID_02', 'Sound_RollID_03']
HIT_GROUP_NAMES = ['Sound_HitID_01', 'Sound_HitID_02', 'Sound_HitID_03']
PITCH_FORMULA = '0.5+(a*0.01)'
GAIN_LOCAL_CODES = [0x38996B85, 0x334E35C2]
IMPACT_GATES = [
    (266, 'HitStone'),
    (248, 'HitWood'),
    (30, 'HitMetal'),
    (49, 'HitDome'),
]
ROLLING_GROUP_COUNT = 3
PITCH_BASE = 0.5
PITCH_MULTIPLIER = 0.01
MODULE_STEMS = [
    'P_Box', 'P_Dome', 'P_Ball_Wood', 'P_Ball_Paper', 'P_Ball_Stone',
    'P_Modul_01', 'P_Modul_03', 'P_Modul_08', 'P_Modul_17', 'P_Modul_18',
    'P_Modul_19', 'P_Modul_25', 'P_Modul_26', 'P_Modul_29', 'P_Modul_30',
    'P_Modul_34', 'P_Modul_37', 'P_Modul_41', 'PE_Balloon',
]
MODULE_STEMS_LOWER = {stem.lower() for stem in MODULE_STEMS}
CONTACT_CLASSES = (33, 41)


def ensure(condition, detail=''):
    if not condition:
        raise AssertionError(detail)


def float32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def resolve(dump, cell):
    if isinstance(cell, dict):
        return dump.value(cell['parameterIndex'])
    return cell


def input_values(dump, index):
    return [dump.value(item) for item in dump.definition(index)['inputs']]


def contact_pairs(raw):
    """(object reference, attribute index) pairs of a 0x11 contact chunk."""
    position = chunks(raw)[TAG_CONTACT]
    count, = struct.unpack_from('<I', raw, position)
    references = struct.unpack_from(f'<{count}I', raw, position + 4)
    header = position + 4 + 4 * count
    repeat, identifier, zero = struct.unpack_from('<3I', raw, header)
    ensure(repeat == count and identifier == ATTRIBUTE_MANAGER_ID and zero == 0, 'contact header')
    attributes = struct.unpack_from(f'<{count}I', raw, header + 12)
    return list(zip(references, attributes))


def read_materials(sound):
    materials = {}
    for row in table(sound.rows[SOUND_MATERIALS][2]):
        values = {column: resolve(sound, cell) for column, cell in row.items()}
        name = values['Active Ball'].removeprefix('Ball_').lower()
        materials[name] = {column: value for column, value in values.items() if column != 'Active Ball'}
    return materials


def read_impacts(sound):
    impacts = []
    for index, column in IMPACT_GATES:
        inputs = input_values(sound, index)
        ensure(len(inputs) == 4, ('impact inputs', index))
        minimum, maximum, cooldown, group = inputs
        impacts.append({
            'index': index,
            'minimum': minimum,
            'maximum': maximum,
            'cooldown': cooldown,
            'group': group,
            'column': column,
        })
    return impacts


def read_module(path):
    """Contact identifiers of one physical module dump, keyed by object name."""
    ensure(path.with_suffix('.managers').is_file(),
           (str(path), 'has no attribute manager dump'))
    dump = ChunkDump(path)
    attribute_names = dump.attributes
    objects = {}
    for index, (kind, name, raw) in dump.rows.items():
        if kind not in CONTACT_CLASSES or TAG_CONTACT not in chunks(raw):
            continue
        entries = {}
        for reference, attribute in contact_pairs(raw):
            attribute_name = attribute_names[attribute]
            if attribute_name == HIT_ATTRIBUTE:
                entries['hit'] = dump.value(reference)
            elif attribute_name == ROLL_ATTRIBUTE:
                entries['roll'] = dump.value(reference)
        if entries:
            objects[name] = entries
    return objects


def matching_modules(chunk_directory):
    paths = [path for path in chunk_directory.glob('*.tsv') if path.stem.lower() in MODULE_STEMS_LOWER]
    return sorted(paths, key=lambda path: path.name.lower())


def build_document(chunk_directory):
    sound = ChunkDump(chunk_directory / SOUND_DUMP)
    levelinit = ChunkDump(chunk_directory / LEVELINIT_DUMP)

    for index in (SOUND_ROLL_DELAY, SOUND_ROLL_DELAY_ALT):
        ensure(input_values(sound, index) == [float32(0.3), float32(0.3)], ('roll delay', index))
    ensure(input_values(sound, SOUND_PITCH_FORMULA)[0] == PITCH_FORMULA, 'pitch formula')
    gain_locals = [sound.value(item) for item in sound.definition(SOUND_GAIN)['locals'][1:]]
    ensure(gain_locals == GAIN_LOCAL_CODES, 'gain locals')
    ensure(input_values(levelinit, LEVELINIT_ROLL_GROUP) == ROLL_GROUP_NAMES, 'roll groups')
    ensure(input_values(levelinit, LEVELINIT_HIT_GROUP) == HIT_GROUP_NAMES, 'hit groups')

    sound_delays = input_values(sound, SOUND_ROLL_DELAY)
    gain_inputs = input_values(sound, SOUND_GAIN)

    module_ids = {}
    for path in matching_modules(chunk_directory):
        module_ids[path.stem.lower()] = read_module(path)

    return {
        'source': SOURCE_LABEL,
        'materials': read_materials(sound),
        'rolling': {
            'startDelay': sound_delays[0],
            'endDelay': sound_delays[1],
            'groupCount': ROLLING_GROUP_COUNT,
            'gainMultiplier': gain_inputs[1],
            'pitchBase': PITCH_BASE,
            'pitchMultiplier': PITCH_MULTIPLIER,
        },
        'impacts': read_impacts(sound),
        'floorGroups': {
            'roll': input_values(levelinit, LEVELINIT_ROLL_GROUP),
            'hit': input_values(levelinit, LEVELINIT_HIT_GROUP),
        },
        'moduleIds': module_ids,
    }


def parse_arguments():
    work_directory = Path(os.environ.get('BALLANCE_IMPORT_WORK', DEFAULT_WORK_DIRECTORY))
    output_directory = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', DEFAULT_OUTPUT_DIRECTORY))

    parser = argparse.ArgumentParser(description='Read the original audio data from chunk dumps.')
    parser.add_argument('dump_directory', nargs='?', type=Path, default=work_directory)
    parser.add_argument('--out', type=Path, default=output_directory / OUTPUT_NAME)
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    document = build_document(arguments.dump_directory)

    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    with open(arguments.out, 'w') as handle:
        handle.write(json.dumps(document, indent=2) + '\n')
    print(f'Wrote {arguments.out}')


if __name__ == '__main__':
    main()
