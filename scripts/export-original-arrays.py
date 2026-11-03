#!/usr/bin/env python3
"""Export every CKDataArray (kind-52 row) from the chunk dumps to JSON.

A DataArray stores its columns in chunk 0x1000 and its rows in chunk 0x2000.
Column types are 1=int, 2=float, 3=string, 4=object/parameter reference and
5=parameter reference. A type-5 cell holds the index of the parameter whose
value the array cell represents; it is resolved through `ChunkDump.value` and
left null when the parameter layout is not decoded yet.

The exported JSON is keyed by source NMO stem and then by array name, so
`Gameplay/CurrentLevel` and `Levelinit/AllLevel` keep their provenance. It is
written into the local original pack (`.local/original/data-arrays.json`) and
served by the app; it is never committed.

Usage: python3 scripts/export-original-arrays.py
"""
import json
import os
import struct
from pathlib import Path

import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from original_chunks import ChunkDump, chunks

ROOT = Path(__file__).resolve().parent.parent
CHUNKS = Path(os.environ.get('BALLANCE_IMPORT_WORK', ROOT / '.local' / 'reference' / 'chunks'))
OUT = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', ROOT / '.local' / 'original')) / 'data-arrays.json'


def string(data, position):
    length, = struct.unpack_from('<I', data, position)
    value = data[position + 4:position + 4 + length].split(b'\0')[0].decode('windows-1252')
    return value, position + 4 + (length + 3) // 4 * 4


def columns(dump, data):
    position = chunks(data)[0x1000]
    count, = struct.unpack_from('<I', data, position)
    position += 4
    result = []
    for _ in range(count):
        name, position = string(data, position)
        kind, = struct.unpack_from('<I', data, position)
        position += 4
        guid = None
        if kind == 5:
            guid = data[position:position + 8].hex()
            position += 8
        result.append((name, kind, guid))
    return result


def cell(dump, data, position, kind):
    if kind in (1, 4, 5):
        value, = struct.unpack_from('<i', data, position)
        if kind == 5 and value >= 0:
            try:
                return dump.value(value), position + 4
            except (ValueError, KeyError, AssertionError, struct.error):
                return None, position + 4
        return value, position + 4
    if kind == 2:
        value, = struct.unpack_from('<f', data, position)
        return value, position + 4
    if kind == 3:
        return string(data, position)
    raise ValueError(f'unsupported DataArray column type {kind}')


def export_array(dump, index):
    kind, name, data = dump.rows[index]
    defs = columns(dump, data)
    position = chunks(data)[0x2000]
    count, = struct.unpack_from('<I', data, position)
    position += 4
    rows = []
    for _ in range(count):
        row = []
        for _, column_kind, _guid in defs:
            value, position = cell(dump, data, position, column_kind)
            row.append(value)
        rows.append(row)
    # CK_STATESAVE_DATAARRAYMEMBERS (0x4000): m_Order, m_ColumnIndex, m_KeyColumn.
    order, sort_column, key_column = struct.unpack_from('<IIi', data, chunks(data)[0x4000])
    result = {
        # A parameter column (type 5) also saves its CKParameter type GUID.
        'columns': [{'name': column_name, 'type': column_kind, **({'guid': guid} if guid else {})}
                    for column_name, column_kind, guid in defs],
        'keyColumn': key_column,
        'rows': rows,
    }
    if order:
        # CKDataArray::Sort sets m_Order = Ascending, so a saved order is ascending.
        result['sortColumn'] = sort_column
    return name, result


def main():
    exported = {}
    for path in sorted(CHUNKS.glob('*.tsv')):
        dump = ChunkDump(path)
        arrays = {}
        for index, (kind, _name, _data) in dump.rows.items():
            if kind != 52:
                continue
            name, array = export_array(dump, index)
            arrays[name] = array
        if arrays:
            exported[path.stem] = arrays
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(exported, separators=(',', ':')) + '\n')
    total = sum(len(arrays) for arrays in exported.values())
    print(f'Wrote {OUT}: {total} arrays from {len(exported)} files')


if __name__ == '__main__':
    main()
