#!/usr/bin/env python3
"""Generate dual-solver harness stage starts from the local original pack.

The source pack is the user's converted Ballance install. Positions remain in
original model units; the harness converts them to render units. Floor heights
are obtained by casting a ray through the authored Phys_Floor* triangles.
"""
import json
import math
import os
from fractions import Fraction
from pathlib import Path

PACK = Path(os.environ['BALLANCE_IMPORT_OUTPUT']) if 'BALLANCE_IMPORT_OUTPUT' in os.environ else Path('.local/original')
OUT = PACK / 'harness-stages.json'
LOCAL_RIDE_OFFSET = [0.7239567358778913, 0.10878013170499834, -0.4518316494368264]

def load(name): return json.loads((PACK / f'{name}.json').read_text())
# Small 3-vector and 4x4 helpers replace numpy so the generator runs under the
# app's embeddable Python. Matrices are row lists; vectors are float lists.
def vec(values): return [float(v) for v in values]
def add(a, b): return [x + y for x, y in zip(a, b)]
def sub(a, b): return [x - y for x, y in zip(a, b)]
def scale(a, k): return [x * k for x in a]
def dot(a, b):
    total = 0.0
    for x, y in zip(a, b): total += x * y
    return total
def fused_dot(a, b):
    # numpy's float64 3-vector dot (OpenBLAS on the reference machine) is a chain
    # of fused multiply-adds in term order; Fraction gives the single rounding.
    total = a[0] * b[0]
    for x, y in zip(a[1:], b[1:]): total = float(Fraction(x) * Fraction(y) + Fraction(total))
    return total
def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def norm(a): return math.sqrt(dot(a, a))
def matmul(a, b): return [[dot(row, [r[c] for r in b]) for c in range(len(b[0]))] for row in a]
def rotation(m): return [row[:3] for row in m[:3]]
def translation(m): return [row[3] for row in m[:3]]
def transpose(m): return [list(col) for col in zip(*m)]
def apply(m, v): return [dot(row, v) for row in m]

def matrix(values): return transpose([vec(values[i:i + 4]) for i in range(0, 16, 4)])

def sector_of(level, object_id):
    group = next(g for g in level['groups'] if g['name'].startswith('Sector_') and object_id in g['members'])
    return int(group['name'].split('_')[-1])

def floor_members(level):
    names = {'Phys_Floors', 'Phys_FloorRails', 'Phys_FloorStopper'}
    return set(i for g in level['groups'] if g['name'] in names for i in g['members'])

def mesh_triangles(level, object, cache):
    if object['id'] in cache: return cache[object['id']]
    source = next(m for m in level['meshes'] if m['id'] == object['mesh'])
    flat = source['positions']
    frame = matrix(object['matrix'])
    rot, move = rotation(frame), translation(frame)
    vertices = [add(apply(rot, vec(flat[i:i + 3])), move) for i in range(0, len(flat), 3)]
    index = source['indices']
    triangles = [[vertices[index[i]], vertices[index[i + 1]], vertices[index[i + 2]]] for i in range(0, len(index), 3)]
    cache[object['id']] = triangles
    return triangles

def floor_y(level, x, z, cache):
    best = -math.inf
    origin = vec([x, 2000.0, z])
    direction = vec([0.0, -1.0, 0.0])
    for object in level['objects']:
        if object['id'] not in floor_members(level): continue
        source = next((m for m in level['meshes'] if m['id'] == object['mesh']), None)
        if not source or not source['indices']: continue
        for a, b, c in mesh_triangles(level, object, cache):
            edge1, edge2 = sub(b, a), sub(c, a)
            h = cross(direction, edge2)
            det = fused_dot(edge1, h)
            if abs(det) < 1e-9: continue
            inv = 1.0 / det
            s = sub(origin, a)
            u = inv * fused_dot(s, h)
            if u < 0 or u > 1: continue
            q = cross(s, edge1)
            v = inv * fused_dot(direction, q)
            if v < 0 or u + v > 1: continue
            t = inv * fused_dot(edge2, q)
            if t <= 1e-6: continue
            best = max(best, origin[1] + direction[1] * t)
    return best

def finish_data(level, balloon):
    finish = next(o for o in level['objects'] if o['name'] == 'PE_Balloon_01')
    part = next(o for o in balloon['objects'] if o['name'] == 'PE_Balloon_Platform')
    world = matmul(matrix(finish['matrix']), matrix(part['matrix']))
    origin = translation(world)
    start = add(origin, apply(rotation(world), LOCAL_RIDE_OFFSET))
    reset_count = len(next(g for g in level['groups'] if g['name'] == 'PR_Resetpoints')['members'])
    return {'sector': reset_count, 'startOriginal': start}

def fan_data(level):
    parents = sorted((o for o in level['objects'] if o['name'].startswith('P_Modul_18_')), key=lambda o: o['name'])
    if not parents: return None
    parent = parents[0]
    origin = translation(matrix(parent['matrix']))
    start = add(origin, vec([0.0, 2.2, 0.0]))
    return {
        'name': parent['name'],
        'sector': sector_of(level, parent['id']),
        'originOriginal': origin,
        'startOriginal': start,
        'hoverYOriginal': float(origin[1] + 15.0),
    }

def bridge_data(level, module, cache):
    parents = sorted((o for o in level['objects'] if o['name'].startswith('P_Modul_29_')), key=lambda o: o['name'])
    if not parents: return None
    parent = parents[0]
    frame = matrix(parent['matrix'])
    first_obj = next(o for o in module['objects'] if o['name'] == 'P_Modul_29_Platte01')
    last_obj = next(o for o in module['objects'] if o['name'] == 'P_Modul_29_Platte09')
    first = translation(matmul(frame, matrix(first_obj['matrix'])))
    last = translation(matmul(frame, matrix(last_obj['matrix'])))
    delta = sub(last, first)
    delta[1] = 0
    length = norm(delta)
    if length < 1e-6: return None
    axis = [x / length for x in delta]
    start = sub(first, scale(axis, 1.5))
    y = floor_y(level, float(start[0]), float(start[2]), cache)
    if not math.isfinite(y): return None
    start[1] = y + 2.04
    yaw = math.atan2(-float(axis[0]), float(axis[2]))
    return {
        'name': parent['name'],
        'sector': sector_of(level, parent['id']),
        'startOriginal': start,
        'axis': axis,
        'yaw': yaw,
        'stopDistance': length + 2.0,
    }

def arm_data(level, module, reference, cache):
    parents = sorted((o for o in level['objects'] if o['name'].startswith('P_Modul_17_')), key=lambda o: o['name'])
    if not parents: return None
    ref_parent = next(o for o in reference['objects'] if o['name'] == 'P_Modul_17_01')
    dreharme = next(o for o in module['objects'] if o['name'] == 'Modul17_Dreharme')
    ref_rotation = rotation(matmul(matrix(ref_parent['matrix']), matrix(dreharme['matrix'])))
    result = []
    for parent in parents:
        frame = matmul(matrix(parent['matrix']), matrix(dreharme['matrix']))
        origin, turn = translation(frame), rotation(frame)
        # Level 7 uses a 12-unit lever and a different exit; Level 9 uses -10.
        # The caller passes the level number through the cache key.
        number = cache['number']
        lever = 12 if number == 7 else -10
        approach = vec([lever, 40.0, 5.0 if number == 7 else 6.0])
        exit_local = vec([lever, 40.0, -4.0 if number == 7 else -8.0])
        start = add(origin, apply(turn, apply(transpose(ref_rotation), approach)))
        target = add(origin, apply(turn, apply(transpose(ref_rotation), exit_local)))
        y = floor_y(level, float(start[0]), float(start[2]), cache)
        if not math.isfinite(y): continue
        start[1] = y + 2.04
        result.append({
            'name': parent['name'],
            'sector': sector_of(level, parent['id']),
            'startOriginal': start,
            'targetOriginal': target,
        })
    return result or None

def swing_data(level, module, cache):
    cases = {
        8: [{'name': 'P_Modul_08_01', 'reverse': True, 'distance': 8, 'phase': 0.2}],
        9: [{'name': 'P_Modul_08_01', 'reverse': False, 'distance': 8, 'phase': 3.5}],
        10: [{'name': 'P_Modul_08_01', 'reverse': False, 'distance': 12, 'phase': 1},
             {'name': 'P_Modul_08_02', 'reverse': False, 'distance': 12, 'phase': 1}],
    }.get(cache['number'])
    if not cases: return None
    resets = sorted((o for o in level['objects'] if o['name'].startswith('PR_Resetpoint')), key=lambda o: o['name'])
    result = []
    for case in cases:
        parent = next(o for o in level['objects'] if o['name'] == case['name'])
        def frame(target):
            return matmul(matrix(parent['matrix']), matrix(next(o for o in module['objects'] if o['name'] == target)['matrix']))
        origin = translation(frame('P_Modul_08_Schaukel'))
        axis = apply(rotation(frame('P_Modul_08_Fix')), vec([0.0, 0.0, -1.0 if case['reverse'] else 1.0]))
        axis[1] = 0
        length = norm(axis)
        if length < 1e-6: continue
        axis = [x / length for x in axis]
        start = sub(origin, scale(axis, case['distance']))
        y = floor_y(level, float(start[0]), float(start[2]), cache)
        start[1] = (y + 2.04) if math.isfinite(y) else float(origin[1] + 4.0)
        target = add(origin, scale(axis, 12.0))
        sector = sector_of(level, parent['id'])
        result.append({
            'name': case['name'],
            'sector': sector,
            'startOriginal': start,
            'targetOriginal': target,
            'originOriginal': origin,
            'phaseTicks': round(case['phase'] * 60),
            'safeOriginal': resets[sector - 1]['matrix'][12:15],
            'axisOriginal': axis,
        })
    return result or None

def lift_data(level, module, cache):
    parents = sorted((o for o in level['objects'] if o['name'].startswith('P_Modul_03_')), key=lambda o: o['name'])
    if not parents: return None
    parent = parents[0]
    frame = matrix(parent['matrix'])
    def world(target):
        return translation(matmul(frame, matrix(next(o for o in module['objects'] if o['name'] == target)['matrix'])))
    origin = world('P_Modul_03_Floor')
    gate = world('P_Modul_03_Gate')
    inward = sub(origin, gate)
    inward[1] = 0.0
    length = norm(inward)
    if length < 1e-6: return None
    inward = [x / length for x in inward]
    start = add(add(origin, scale(inward, -12.0)), vec([0.0, 3.0, 0.0]))
    return {
        'name': parent['name'],
        'sector': sector_of(level, parent['id']),
        'originOriginal': origin,
        'inwardOriginal': inward,
        'startOriginal': start,
    }

def sack_data(level, module, cache):
    parents = sorted((o for o in level['objects'] if o['name'].startswith('P_Modul_26_')), key=lambda o: o['name'])
    if not parents: return None
    sack_object = next(o for o in module['objects'] if o['name'] == 'P_Modul_26_Sack')
    halter_object = next(o for o in module['objects'] if o['name'] == 'P_Modul_26_Halter')
    result = []
    for parent in parents:
        frame = matrix(parent['matrix'])
        sack = translation(matmul(frame, matrix(sack_object['matrix'])))
        halter = matmul(frame, matrix(halter_object['matrix']))
        direction = apply(rotation(halter), vec([0.0, 0.0, 1.0]))
        across = cross(direction, vec([0.0, 1.0, 0.0]))
        across[1] = 0.0
        length = norm(across)
        if length < 1e-6: continue
        across = [x / length for x in across]
        start = add(sack, scale(across, -2.0))
        y = floor_y(level, float(start[0]), float(start[2]), cache)
        start[1] = (y + 2.04) if math.isfinite(y) else float(sack[1] + 3.0)
        result.append({
            'name': parent['name'],
            'sector': sector_of(level, parent['id']),
            'originOriginal': sack,
            'axisOriginal': across,
            'startOriginal': start,
        })
    return result or None

def main():
    result = {}
    balloon = load('pe_balloon')
    bridge_module = load('p_modul_29')
    arm_module = load('p_modul_17')
    arm_reference = load('level_09')
    swing_module = load('p_modul_08')
    lift_module = load('p_modul_03')
    sack_module = load('p_modul_26')
    for number in range(4, 13):
        level = load(f'level_{number:02d}')
        cache = {'number': number}
        result[str(number)] = {
            'spawn': True,
            'finish': finish_data(level, balloon),
            'fan': fan_data(level),
            'bridge': bridge_data(level, bridge_module, cache),
            'arm': arm_data(level, arm_module, arm_reference, cache),
            'swing': swing_data(level, swing_module, cache),
            'lift': lift_data(level, lift_module, cache),
            'sack': sack_data(level, sack_module, cache),
        }
    OUT.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Wrote {OUT}')

if __name__ == '__main__':
    main()
