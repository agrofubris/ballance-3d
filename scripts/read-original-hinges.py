#!/usr/bin/env python3
"""Describe the passive hinged modules of the original level set from their chunk dumps.

For five modules the physics body settings, the hinge anchor and frame, the
angle limits and the optional wake distance are decoded from the stored object
dumps. One JSON object keyed by module name is written to the output file.
"""
import argparse
import json
import os
import struct
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORK_DIRECTORY = REPO_ROOT / '.local' / 'reference' / 'chunks'
DEFAULT_OUTPUT_DIRECTORY = REPO_ROOT / '.local' / 'original'
OUTPUT_NAME = 'hinge-data.json'
MODULE_NUMBERS = (19, 25, 30, 37, 41)

CHUNK_TABLE_START = 8
TAG_BEHAVIOR = 0x20
TAG_PARAMETER = 0x40
TAG_FRAME = 0x100000

CLASS_REFERENCE = 2
CLASS_PARAMETER = (3, 45)
CLASS_BEHAVIOR = 8
CLASS_FRAME = 33
DISTANCE_CLASS = 45

TARGETABLE_MARKER = 0x21
NO_REFERENCE = 0xFFFFFFFF
STORAGE_INLINE = 1
STORAGE_REFERENCE = 2
GUID_TEXT = 'e210d06bea175611'
GUID_BOOLEAN = '8e2ad51a2019745e'
GUID_INTEGER = 'fd16575ad776e244'

PHYSICALIZE_NAME = 'Physicalize'
HINGE_NAME = 'Set Physics Hinge'
WAKE_NAME = 'Physics WakeUp'
DISTANCE_NAME = 'Distance'
PHYSICS_FIELDS = [
    'fixed', 'friction', 'restitution', 'mass', 'collisionGroup', 'startFrozen',
    'enableCollision', 'automaticMassCenter', 'linearDamping', 'angularDamping',
]
HULL_INPUT_START = 11
MASS_CENTER_LOCAL = 3


def ensure(condition, message):
    if not condition:
        raise AssertionError(message)


def chunk_positions(payload):
    """Map each chunk tag to the position of its data."""
    positions = {}
    cursor = CHUNK_TABLE_START
    while True:
        tag, count = struct.unpack_from('<II', payload, cursor)
        positions[tag] = cursor + 8
        if count == 0:
            break
        cursor = CHUNK_TABLE_START + 4 * count
    return positions


class Dump:
    def __init__(self, path):
        self.rows = {}
        with open(path) as handle:
            for line in handle:
                columns = line.rstrip('\r\n').split('\t')
                if len(columns) != 5:
                    continue
                index = int(columns[0])
                self.rows[index] = (int(columns[2]), columns[3], bytes.fromhex(columns[4]))

    def find(self, class_code, name):
        for index, (row_class, row_name, _payload) in self.rows.items():
            if row_class == class_code and row_name == name:
                return index
        return None

    def require(self, class_code, name):
        index = self.find(class_code, name)
        if index is None:
            raise LookupError(f'no class {class_code} row named {name}')
        return index

    def decode(self, index):
        row_class, name, payload = self.rows[index]
        if row_class == CLASS_REFERENCE:
            target, = struct.unpack_from('<I', payload, 24)
            return self.decode(target)
        if row_class not in CLASS_PARAMETER:
            return name
        return self.decode_parameter(name, payload)

    def decode_parameter(self, name, payload):
        position = chunk_positions(payload)[TAG_PARAMETER]
        guid = payload[position:position + 8].hex()
        mode, = struct.unpack_from('<I', payload, position + 8)
        if mode == STORAGE_REFERENCE:
            row, = struct.unpack_from('<I', payload, position + 12)
            if row == NO_REFERENCE:
                return name
            return self.rows[row][1]
        ensure(mode == STORAGE_INLINE, ('storage mode', name, mode))

        length, = struct.unpack_from('<I', payload, position + 12)
        data = payload[position + 16:position + 16 + length]
        if guid == GUID_TEXT:
            return data.split(b'\x00', 1)[0].decode('windows-1252')
        if guid == GUID_BOOLEAN:
            value, = struct.unpack_from('<I', data)
            return value != 0
        if guid == GUID_INTEGER:
            value, = struct.unpack_from('<i', data)
            return value
        if length == 4:
            value, = struct.unpack_from('<f', data)
            return value
        if length == 12:
            return list(struct.unpack_from('<3f', data))
        raise AssertionError(('parameter payload', name, length))

    def behavior(self, index, with_locals):
        payload = self.rows[index][2]
        start = chunk_positions(payload)[TAG_BEHAVIOR]
        words = struct.unpack_from('<%dI' % ((len(payload) - start) // 4), payload, start)
        ensure(words[4] == TARGETABLE_MARKER, 'Expected a targetable entity behavior')
        input_count = words[7]
        record = {
            'target': self.decode(words[5]),
            'inputs': [self.decode(word) for word in words[8:8 + input_count]],
            'locals': [],
        }
        if with_locals:
            local_count = words[8 + input_count]
            first = 9 + input_count
            record['locals'] = [self.decode(word) for word in words[first:first + local_count]]
        return record


def read_frame(dump, referential):
    index = dump.find(CLASS_FRAME, referential)
    if index is None:
        raise LookupError(f'no frame row named {referential}')
    payload = dump.rows[index][2]
    position = chunk_positions(payload)[TAG_FRAME] + 8
    groups = struct.unpack_from('<12f', payload, position)
    frame = []
    for group in range(4):
        frame.extend(groups[group * 3:group * 3 + 3])
        frame.append(1 if group == 3 else 0)
    return frame


def read_wake_distance(dump):
    if dump.find(CLASS_BEHAVIOR, WAKE_NAME) is None:
        return None
    index = dump.find(DISTANCE_CLASS, DISTANCE_NAME)
    if index is None:
        return None
    return dump.decode(index)


def read_module(number, path):
    dump = Dump(path)
    physicalize_index = dump.require(CLASS_BEHAVIOR, PHYSICALIZE_NAME)
    hinge_index = dump.require(CLASS_BEHAVIOR, HINGE_NAME)

    physicalize = dump.behavior(physicalize_index, with_locals=True)
    hinge = dump.behavior(hinge_index, with_locals=False)
    ensure(physicalize['target'] == hinge['target'], 'shared target')
    ensure(physicalize['locals'][1] == 0 and physicalize['locals'][2] == 0, 'convex only')

    inputs = physicalize['inputs']
    hull_count = physicalize['locals'][0]
    hinge_inputs = hinge['inputs']
    referential = hinge_inputs[1]

    record = {'source': f'P_Modul_{number:02d}.nmo'}
    record['physicalizeIndex'] = physicalize_index
    record['hingeIndex'] = hinge_index
    record['target'] = physicalize['target']
    record.update(zip(PHYSICS_FIELDS, inputs))
    record['hulls'] = inputs[HULL_INPUT_START:HULL_INPUT_START + hull_count]
    record['massCenter'] = physicalize['locals'][MASS_CENTER_LOCAL]
    record['anchorObject'] = hinge_inputs[0]
    record['hingeFrame'] = read_frame(dump, referential)
    record['limitsEnabled'] = hinge_inputs[2]
    record['lowerLimit'] = hinge_inputs[3]
    record['upperLimit'] = hinge_inputs[4]
    record['wakeDistance'] = read_wake_distance(dump)
    return record


def parse_arguments():
    parser = argparse.ArgumentParser(description='Read the original hinge parameters from chunk dumps.')
    parser.add_argument('dump_directory', nargs='?', type=Path,
                        default=Path(os.environ.get('BALLANCE_IMPORT_WORK', DEFAULT_WORK_DIRECTORY)))
    parser.add_argument('--out', type=Path, default=None)
    arguments = parser.parse_args()
    if arguments.out is None:
        output_directory = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', DEFAULT_OUTPUT_DIRECTORY))
        arguments.out = output_directory / OUTPUT_NAME
    return arguments


def main():
    arguments = parse_arguments()
    document = {}
    for number in MODULE_NUMBERS:
        path = arguments.dump_directory / f'P_Modul_{number:02d}.tsv'
        document[f'P_Modul_{number:02d}'] = read_module(number, path)

    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    with open(arguments.out, 'w') as handle:
        handle.write(json.dumps(document, indent=2) + '\n')
    print(f'Wrote {arguments.out}')


if __name__ == '__main__':
    main()
