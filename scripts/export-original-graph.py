#!/usr/bin/env python3
"""Export a Virtools CKBehavior graph from a dump-chunks TSV into JSON.

The dump's kind-8 rows are named CKBehavior objects. Each behavior's
`definition` lists its input/output/local/activation parameter indices, and the
kind-6 link rows connect an output parameter index to an input parameter index.
This produces a graph model the TypeScript runtime can execute; it does not
interpret the graph itself.

Usage: python3 scripts/export-original-graph.py <dump.tsv> [--out out.json]
"""
import argparse
import json
import os
import struct
from pathlib import Path

import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from original_chunks import ChunkDump, chunks


def myself_local(kind, data):
    """CKParameterLocal::Load's CK_STATESAVE_PARAMETERLOCAL_MYSELF (0x200).

    CK2.dll 0x240096E6 reads the saved chunk identifiers and calls
    CKParameterLocal::SetAsMyselfParameter(TRUE) when 0x200 is present; the
    parameter then holds its behavior's owner and has no stored value chunk.
    """
    if kind != 45:
        return False
    try:
        return 0x200 in chunks(data)
    except (ValueError, struct.error, IndexError):
        return False


# CKParameter type GUIDs whose zero value an unconnected parameter-in holds.
# CK2.dll allocates the pin's own value buffer from its type; a kind-2 row with
# real source 0xFFFFFFFF and no 0x40 value chunk keeps that buffer zeroed.
_ZERO_DEFAULTS = {
    'fd16575ad776e244': 0,                    # CKPGUID_INT
    '3f4c8847202c2c43': 0.0,                  # CKPGUID_FLOAT
    '2b42b4544f0f0f73': 0.0,                  # CKPGUID_TIME
    'f52c26113a23b030': 0.0,                  # CKPGUID_ANGLE
    '4e4bc8f334ccfa0f': 0.0,                  # CKPGUID_PERCENTAGE
    '8e2ad51a2019745e': False,                # CKPGUID_BOOL
    'e210d06bea175611': '',                   # CKPGUID_STRING
}
_DEFAULT_MISSING = object()


def parameter_zero(guid):
    """The load-time value of an unconnected parameter-in, or _DEFAULT_MISSING."""
    return _ZERO_DEFAULTS.get(guid, _DEFAULT_MISSING)


def final_source(dump, index):
    """The parameter row a chain of parameter-in references finally reads."""
    current = index
    for _ in range(64):
        kind, _name, data = dump.rows[current]
        if kind != 2 or len(data) < 28:
            return current
        ref, = struct.unpack_from('<I', data, 24)
        if ref == 0xffffffff:
            return current
        current = ref
    raise ValueError((index, 'parameter source chain is a cycle'))


def keyed_animation(dump, result, reference):
    """Attach a CKKeyedAnimation object input's authored list to the pin.

    Play Global Animation steps a CKKeyedAnimation's sub-animations, so the
    graph needs their names (their controllers stay in the object export).
    """
    row = dump.rows.get(reference) if reference is not None else None
    if row is None or row[0] != 18:
        return
    animation = dump.keyed_animation(reference)
    result['keyedAnimation'] = {
        'length': animation['length'],
        'animations': [dump.rows[index][1] for index in animation['animations']],
    }


def parameter(dump, index):
    """Resolve a parameter index to a JSON-safe value, or a raw descriptor.

    A `kind == 2` row is a parameter-in that references another parameter at
    offset 24 (Virtools "real source"); emit that reference so the runtime can
    read the live source instead of a value frozen at export time.

    A saved object reference keeps both its display name (`value`, the row the
    reference points at) and its file index (`object`). Names are not unique
    across classes, so the runtime resolves `object` first.
    """
    kind, name, data = dump.rows[index]
    source = None
    if kind == 2:
        ref, = struct.unpack_from('<I', data, 24)
        if ref != 0xffffffff:
            source = ref
    parameter_type = dump.parameter_guid(index)
    reference = dump.parameter_reference(index)
    myself = myself_local(kind, data)
    if myself:
        result = {'index': index, 'kind': kind, 'name': name, 'myself': True}
        if source is not None:
            result['source'] = source
        if parameter_type is not None:
            result['type'] = parameter_type
        targets = dump.parameter_targets(index)
        if targets:
            result['targets'] = targets
        return result
    try:
        value = dump.value(index)
    except (ValueError, KeyError, AssertionError, struct.error):
        # A pin that reads an undecoded parameter keeps that parameter's saved
        # bytes: CK2dCurve values, for example, live on the source row, not on
        # the pin's 0x1000 reference chunk.
        raw = data.hex()
        if kind == 2 and source is not None:
            final = final_source(dump, index)
            if final != index and dump.rows[final][0] in (3, 45):
                raw = dump.rows[final][2].hex()
        result = {'index': index, 'kind': kind, 'name': name, 'raw': raw}
        if source is not None:
            result['source'] = source
        if parameter_type is not None:
            result['type'] = parameter_type
        if reference is not None:
            result['object'] = reference
        keyed_animation(dump, result, reference)
        if kind == 2 and source is None and set(chunks(data)) == {0x1000} and len(data) >= 24:
            # No real source and no saved value chunk: the pin keeps its own
            # value buffer, zeroed for a primitive type.
            default = parameter_zero(data[16:24].hex())
            if default is not _DEFAULT_MISSING:
                result['value'] = default
        # An undecoded value still has its destination links.
        targets = dump.parameter_targets(index)
        if targets:
            result['targets'] = targets
        return result
    result = {'index': index, 'kind': kind}
    if isinstance(value, list):
        result['value'] = value
    else:
        result['value'] = value
    if source is not None:
        result['source'] = source
    if parameter_type is not None:
        result['type'] = parameter_type
    if reference is not None:
        result['object'] = reference
    keyed_animation(dump, result, reference)
    if kind == 2 and len(data) >= 24:
        # A parameter-in has its own type (offset 16), which building blocks
        # such as Add Row test; `type` is its source's.
        own = data[16:24].hex()
        if own != parameter_type:
            result['pinType'] = own
    if dump.null_object(index):
        # A NULL object reference: `value` is only the parameter's own name.
        result['null'] = True
    targets = dump.parameter_targets(index)
    if targets:
        result['targets'] = targets
    return result


def export(path):
    dump = ChunkDump(path)
    behaviors = {}
    operations = []
    for index, (kind, name, data) in sorted(dump.rows.items()):
        if kind != 8:
            continue
        try:
            definition = dump.definition(index)
        except (ValueError, KeyError, AssertionError, struct.error):
            continue
        node = {'index': index, 'name': name, 'class': kind}
        # Primitive building blocks carry their prototype GUID; scripts do not.
        prototype = dump.prototype(index)
        if prototype is not None:
            node['prototype'] = prototype
        if 'version' in definition:
            # The building block's version as saved (CKBehavior::GetVersion); some blocks branch on it.
            node['version'] = definition['version']
        for key in ('children', 'links'):
            if key in definition:
                node[key] = definition[key]
        for key in ('inputs', 'outputs', 'locals', 'inIO', 'outIO'):
            if key in definition:
                node[key] = [parameter(dump, p) for p in definition[key]]
        if 'target' in definition:
            node['target'] = definition['target']
        if 'targetIndex' in definition:
            node['targetIndex'] = definition['targetIndex']
            if definition['targetIndex'] is not None:
                reference = dump.parameter_reference(definition['targetIndex'])
                if reference is not None:
                    node['targetObject'] = reference
        if 'targetSource' in definition:
            node['targetSource'] = definition['targetSource']
        if 'targetClass' in definition:
            node['targetClass'] = definition['targetClass']
        for operation in definition.get('operations', []):
            # Parameter operations run when a reader updates their output
            # (CKParameterOut::GetValue -> CKParameterOperation::DoOperation).
            recovered = dump.operation(operation)
            operations.append({
                'index': operation, 'name': dump.rows[operation][1], 'guid': recovered['guid'], 'owner': index,
                'inputs': [parameter(dump, p) for p in recovered['inputs']],
                'output': parameter(dump, recovered['output']),
            })
        if definition.get('priority'):
            # The parent compound sorts its children by this at load (CKBehavior::SortSubs).
            node['priority'] = definition['priority']
        behaviors[index] = node

    links = []
    for index, (kind, name, data) in sorted(dump.rows.items()):
        if kind != 6:
            continue
        words = struct.unpack_from('<7I', data, 0)
        # The low 16 bits of the attribute word are the link's frame delay.
        links.append({'index': index, 'from': words[5], 'to': words[6], 'type': words[4], 'delay': words[4] & 0xffff})

    # A script is a behavior with children/links and no incoming link that owns
    # it; the smallest such index is the file's root.
    owned = set()
    for node in behaviors.values():
        for child in node.get('children', []):
            owned.add(child)
    roots = [index for index in behaviors if index not in owned]
    graph = {'source': Path(path).stem, 'nodes': behaviors, 'links': links, 'roots': roots}
    if operations:
        graph['operations'] = operations
    # The object each root script belongs to receives the messages sent to it
    # (Wait Message without a target waits on its script's owner).
    owners = {str(root): owner for root, owner in dump.script_owners().items() if root in behaviors}
    missing = [root for root in roots if str(root) not in owners]
    if missing:
        raise ValueError(f'{path}: root scripts without an owning object: {missing}')
    graph['owners'] = owners
    hierarchy = dump.entity_children()
    if hierarchy:
        # Scene children for `TT Restore IC` recursion (CK3dEntity hierarchy).
        graph['hierarchy'] = hierarchy
    return graph


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('dump', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    graph = export(args.dump)
    default_out = (Path(os.environ['BALLANCE_IMPORT_OUTPUT']) if 'BALLANCE_IMPORT_OUTPUT' in os.environ
                   else Path('.local/original')) / 'graphs'
    out = args.out or default_out / f'{args.dump.stem}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(graph, separators=(',', ':')) + '\n')
    print(f'Wrote {out}: {len(graph["nodes"])} nodes, {len(graph["links"])} links, roots {graph["roots"]}')


if __name__ == '__main__':
    main()

