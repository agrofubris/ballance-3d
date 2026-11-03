#!/usr/bin/env python3
"""Describe the original camera rig from the Camera and Gameplay chunk dumps.

Every stored fact the rewrite depends on is verified; the JSON document goes to
standard output only. Nothing is written to disk.
"""
import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from original_chunks import ChunkDump, chunks

TAG_FRAME = 0x100000
TAG_CLASS_WORD = 0x10000000
TAG_PROJECTION = 0xFC00000
FLAG_HAS_PARENT = 0x20000
FRAME_CLASSES = (33, 35)
CAMERA_OBJECT = 4

FRAME_NAMES = ['Cam_OrientRef', 'Cam_Pos', 'Cam_Orient', 'Cam_Target', 'InGameCam', 'Cam_MF']
FRAME_PARENTS = {
    'Cam_OrientRef': 'Cam_Target',
    'Cam_Pos': 'Cam_Orient',
    'Cam_Orient': 'Cam_Target',
    'Cam_Target': 'Cam_MF',
    'InGameCam': 'Cam_MF',
    'Cam_MF': None,
}

TURN_LINKS = [
    # (index, source, destination, delayFrames)
    (2140, 1976, 1964, 1),
    (2141, 2001, 1944, 0),
    (2142, 1977, 2000, 0),
    (2143, 1976, 2000, 0),
    (2144, 1977, 1975, 1),
    (2162, 1957, 1974, 0),
    (2165, 2132, 1956, 0),
    (2180, 2087, 1955, 0),
]

# Selector pairs: (output object, shared index it stores, input object).
SELECTOR_PAIRS = [(2033, 2032, 2975), (2043, 2042, 2964)]
TURN_CURVE_HEX = '5d34ad20b125fb1a'
TURN_ANGLES = [[0.0, 1.5707963705062866, 0.0], [0.0, -1.5707963705062866, 0.0]]
PARENT_CHILDREN = [1758, 2189, 2989, 3025]


def require(condition, where=''):
    if not condition:
        raise AssertionError(where)


def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def input_values(dump, index, count=None):
    """Values of an object's behavior inputs, in definition order (the first `count` when given)."""
    inputs = dump.definition(index).get('inputs', [])
    return [dump.value(i) for i in (inputs if count is None else inputs[:count])]


def read_frames(camera):
    frames = {}
    for index, expected in enumerate(FRAME_NAMES):
        kind, name, data = camera.rows[index]
        require(kind in FRAME_CLASSES and name == expected, ('frame', index, name))
        position = chunks(data)[TAG_FRAME]
        flags, = struct.unpack_from('<I', data, position)
        parent = None
        if flags & FLAG_HAS_PARENT:
            parent_row, = struct.unpack_from('<I', data, position + 56)
            parent = camera.rows[parent_row][1]
        require(parent == FRAME_PARENTS[name], ('frame parent', name, parent))
        floats = struct.unpack_from('<12f', data, position + 8)
        matrix = []
        for group, last in enumerate([0, 0, 0, 1]):
            matrix.extend(floats[group * 3:group * 3 + 3])
            matrix.append(last)
        frames[name] = {'parent': parent, 'matrix': matrix}
    return frames


def read_projection(camera):
    kind, name, data = camera.rows[CAMERA_OBJECT]
    class_word, = struct.unpack_from('<I', data, chunks(data)[TAG_CLASS_WORD])
    require(class_word == 3, 'camera class word')
    projection, fov, zoom, aspect, near, far = struct.unpack_from('<IffIff', data, chunks(data)[TAG_PROJECTION])
    require(projection == 1 and zoom == 1 and aspect == 0x30004 and near == 3 and far == 1200, 'projection')
    return {
        'horizontalFov': fov,
        'aspectWidth': aspect & 0xFFFF,
        'aspectHeight': aspect >> 16,
        'near': near,
        'far': far,
    }


def read_follower(gameplay, index, expected_target):
    """A Gameplay position/target behavior: reference, force and damping inputs."""
    require(gameplay.definition(index).get('target') == expected_target, ('follower target', index))
    inputs = input_values(gameplay, index)
    require(len(inputs) >= 12 and inputs[7:12] == [0.0, 0.0, 0.0, 'Coordinate-System', 0.0], ('follower tail', index))
    return {
        'target': expected_target,
        'reference': inputs[0],
        'force': inputs[1:4],
        'damping': inputs[4:7],
    }


def read_curve(gameplay):
    data = gameplay.rows[1984][2]
    require(data[16:24].hex() == TURN_CURVE_HEX, 'curve signature')
    require(struct.unpack_from('<3I', data, 100) == (0x100, 0, 2), 'curve header')
    require(struct.unpack_from('<3I', data, 112) == (0, 0, 0), 'curve padding')
    points = []
    for i in range(2):
        flags, *v = struct.unpack_from('<I11f', data, 124 + 48 * i)
        require(flags == 0x10000003 and all(x == 0.0 for x in v[2:7]), ('curve point', i))
        points.append({
            'flags': flags & ~0x10000000,
            'position': [v[0], v[1]],
            'incoming': [v[7], v[8]],
            'outgoing': [v[9], v[10]],
        })
    require([point['position'] for point in points] == [[0.0, 0.0], [1.0, 1.0]], 'curve positions')
    return points


def read_turn(gameplay):
    angle_values = input_values(gameplay, 1963)
    require(angle_values == TURN_ANGLES, 'turn angles')
    links = []
    for index, source, destination, delay in TURN_LINKS:
        kind, _name, data = gameplay.rows[index]
        require(kind == 6, ('link class', index))
        require(struct.unpack_from('<HH', data, 16) == (delay, delay), ('link delay', index))
        require(struct.unpack_from('<II', data, 20) == (source, destination), ('link ends', index))
        links.append({'index': index, 'source': source, 'destination': destination, 'delayFrames': delay})
    return {
        'durationMs': 250.0,
        'angles': [angle_values[0][1], angle_values[1][1]],
        'curve': read_curve(gameplay),
        'commitDelayFrames': 1,
        'links': links,
    }


def read_high_view(gameplay):
    offset_values = input_values(gameplay, 2034)
    force_values = input_values(gameplay, 2044)
    require(offset_values == [-50.0, 0.0], 'high view offset')
    require(force_values == [2.0, 0.800000011920929], 'high view force')
    return {'offsetY': offset_values[0], 'forceY': force_values[0]}


def read_reset(gameplay):
    require(input_values(gameplay, 2506) == [True], 'restore hierarchy')
    second = input_values(gameplay, 2728)
    require(len(second) >= 2 and second[1] is True, 'apply matrix')
    for index in (2506, 2728):
        require(gameplay.definition(index).get('target') == 'Cam_MF Frame', ('reset target', index))
    for index in (2724, 2738):
        word, = struct.unpack_from('<I', gameplay.rows[index][2], 24)
        require(word == 2534, ('shared player matrix', index))
    return {'restoreHierarchy': 2506, 'applyMatrix': 2728, 'sharedPlayerMatrix': 2534}


def verify_remaining(gameplay):
    """Stored facts that only decide success; nothing from them reaches the output."""
    require(input_values(gameplay, 1991, 3) == [250.0, 0.0, 1.0], 'duration object inputs')
    require(gameplay.definition(1991).get('version') == 0x10005, 'duration object version')
    require(input_values(gameplay, 1973) == [[0.0, 0.0, 0.0], False, 'Cam_Orient Frame'], 'orient object')
    require(input_values(gameplay, 1954)[1:] == [True, 'Cam_OrientRef Frame'], 'orient reference object')

    for index, expected in [(2050, 'Cam Left'), (2095, 'Cam Right')]:
        referenced, = struct.unpack_from('<I', gameplay.rows[index][2], 24)
        require(gameplay.rows[referenced][1] == expected, ('camera side', index))

    for output, shared, input_object in SELECTOR_PAIRS:
        last_word, = struct.unpack_from('<I', gameplay.rows[output][2], len(gameplay.rows[output][2]) - 4)
        require(last_word == shared, ('selector output', output))
        word, = struct.unpack_from('<I', gameplay.rows[input_object][2], 24)
        require(word == shared, ('selector input', input_object))

    children = gameplay.definition(3136).get('children', [])
    remaining = iter(children)
    require(all(child in remaining for child in PARENT_CHILDREN), 'hierarchy children order')


def main():
    parser = argparse.ArgumentParser(description='Read the original camera rig from chunk dumps.')
    parser.add_argument('chunk_directory', type=Path)
    arguments = parser.parse_args()
    chunk_directory = arguments.chunk_directory
    camera_path = chunk_directory / 'Camera.tsv'
    gameplay_path = chunk_directory / 'Gameplay.tsv'

    camera = ChunkDump(camera_path)
    gameplay = ChunkDump(gameplay_path)
    verify_remaining(gameplay)

    document = {
        'source': 'Camera.nmo and Gameplay.nmo',
        'dumpSha256': {'Camera': sha256_of(camera_path), 'Gameplay': sha256_of(gameplay_path)},
        'frames': read_frames(camera),
        'projection': read_projection(camera),
        'position': read_follower(gameplay, 2989, 'InGameCam'),
        'target': read_follower(gameplay, 3025, 'Cam_Target Frame'),
        'turn': read_turn(gameplay),
        'highView': read_high_view(gameplay),
        'reset': read_reset(gameplay),
    }
    print(json.dumps(document, indent=2))


if __name__ == '__main__':
    main()
