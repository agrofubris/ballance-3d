#!/usr/bin/env python3
"""Export every chunk dump under .local/reference/chunks into graph JSON.

Reuses `export()` from scripts/export-original-graph.py so the batch wrapper and
the single-file exporter cannot drift. Dumps whose export raises are skipped and
reported; the rest are written to .local/original/graphs/<stem>.json.

Usage: python3 scripts/export-all-graphs.py
"""
import importlib.util
import json
import os
from pathlib import Path

import sys; sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
CHUNKS = Path(os.environ.get('BALLANCE_IMPORT_WORK', ROOT / '.local' / 'reference' / 'chunks'))
OUT_DIR = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', ROOT / '.local' / 'original')) / 'graphs'


def load_exporter():
    """Load scripts/export-original-graph.py (the hyphenated name needs a spec)."""
    spec = importlib.util.spec_from_file_location(
        'export_original_graph', SCRIPTS / 'export-original-graph.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def target_for(stem):
    """Write to an existing case-variant file (the checked-in p_modul_08 fixture)."""
    target = OUT_DIR / f'{stem}.json'
    for existing in OUT_DIR.iterdir():
        if existing.name.casefold() == target.name.casefold():
            return existing, existing.stem
    return target, stem


def main():
    exporter = load_exporter()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    exported = []
    skipped = []
    for path in sorted(CHUNKS.glob('*.tsv')):
        try:
            graph = exporter.export(path)
        except Exception as error:
            skipped.append((path.name, f'{type(error).__name__}: {error}'))
            continue
        out, source = target_for(path.stem)
        graph['source'] = source
        out.write_text(json.dumps(graph, separators=(',', ':')) + '\n')
        exported.append((path.name, len(graph['nodes']), len(graph['links'])))

    print(f'Exported {len(exported)} graphs to {OUT_DIR}')
    for name, nodes, links in exported:
        print(f'  {name}: {nodes} nodes, {links} links')
    print(f'Skipped {len(skipped)} files')
    for name, reason in skipped:
        print(f'  {name}: {reason}')


if __name__ == '__main__':
    main()
