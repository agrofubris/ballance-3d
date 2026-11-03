// Typed boundary between the game and the IVP physics module (WebAssembly build
// of the IVP SDK, produced by scripts/build-ivp-simulation.py from
// scripts/ivp-simulation-bridge.cpp). The caller loads the module; this file
// only describes its exports, packs descriptors into doubles and wraps every
// bridge call. Units and axes are the original game's (IVP native).

const BRIDGE_ABI_VERSION = 7;
const DEFAULT_GRAVITY = -20;
const DEFAULT_STEP_SECONDS = 1 / 66;
const OUTPUT_STATE_VALUES = 17;
const BODY_DESCRIPTOR_VALUES = 18;
const JOINT_DESCRIPTOR_VALUES = 9;
const SPRING_DESCRIPTOR_VALUES = 10;
const FORCE_DESCRIPTOR_VALUES = 7;
const EVENT_VALUES = 14;
const CONTACT_VALUES = 7;
const IMPULSE_AT_VALUES = 6;
const DOUBLE_BYTES = 8;
const COMPOUND_MIN_HULL_VALUES = 12;

const JOINT_KIND_CODES: Record<IvpJointDescriptor['kind'], number> = {
  hinge: 1,
  slider: 2,
  ballSocket: 3,
};

const EVENT_KIND_CONTACT_START = 1;
const EVENT_KIND_CONTACT_END = 2;

const textEncoder = new TextEncoder();

// Type-only surface of the loaded module: bridge exports plus runtime helpers.
export interface IvpModule {
  _ivp_bridge_abi(): number;
  HEAPF64: Float64Array;
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _ivp_new(gravity: number): number;
  _ivp_delete(world: number): void;
  _ivp_time(world: number): number;
  _ivp_ball(world: number, radius: number, descriptor: number, group: number): number;
  _ivp_hull(world: number, count: number, vertices: number, descriptor: number, group: number): number;
  _ivp_trimesh(world: number, faces: number, vertices: number, descriptor: number, group: number): number;
  _ivp_compound(
    world: number,
    hulls: number,
    length: number,
    vertices: number,
    descriptor: number,
    group: number,
  ): number;
  _ivp_group(world: number, body: number, group: number): number;
  _ivp_remove(world: number, body: number): number;
  _ivp_pair(world: number, first: number, second: number, enabled: number): number;
  _ivp_event_count(world: number): number;
  _ivp_events(world: number, output: number, capacity: number): number;
  _ivp_contacts(world: number, body: number, output: number, capacity: number): number;
  _ivp_joint(world: number, kind: number, reference: number, attached: number, descriptor: number): number;
  _ivp_remove_joint(world: number, joint: number): number;
  _ivp_wake(world: number, body: number): number;
  _ivp_spring(world: number, reference: number, attached: number, descriptor: number): number;
  _ivp_remove_spring(world: number, spring: number): number;
  _ivp_force(world: number, body: number, corePoint: number, descriptor: number): number;
  _ivp_remove_force(world: number, force: number): number;
  _ivp_step(world: number, dt: number): number;
  _ivp_push(world: number, body: number, x: number, y: number, z: number): number;
  _ivp_push_at(world: number, body: number, values: number): number;
  _ivp_state(world: number, body: number, output: number): number;
}

export interface IvpBodyDescriptor {
  position: readonly number[];
  rotation?: readonly number[];
  mass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  fixed?: boolean;
  massCenter?: readonly number[];
  collisionEnabled?: boolean;
  frozen?: boolean;
  collisionGroup?: string;
}

export interface IvpContact {
  id: number;
  other: number;
  // Current world-space surface normal, oriented to point into this body.
  normal: [number, number, number];
  normalForce: number;
}

export interface IvpCollisionEvent {
  kind: 'contactStart' | 'contactEnd' | 'impact';
  time: number;
  // Contact identifier; 0 for impact events.
  contact: number;
  bodies: [number, number];
  // Points from bodies[0] toward bodies[1]; absent on contactEnd.
  normal?: [number, number, number];
  // World-space contact point; absent on contactEnd.
  point?: [number, number, number];
  // Present only on impact.
  relativeVelocity?: [number, number, number];
}

export interface IvpJointDescriptor {
  kind: 'hinge' | 'slider' | 'ballSocket';
  // Zero means world space; otherwise a live body handle.
  reference: number;
  attached: number;
  anchor: readonly number[];
  // Required for hinge and slider.
  axis?: readonly number[];
  // Hinge limits in radians; slider limits in original length units.
  limits?: readonly [number, number];
}

export interface IvpSpringDescriptor {
  reference: number;
  attached: number;
  anchor1: readonly number[];
  anchor2: readonly number[];
  length: number;
  constant: number;
  axialDamping: number;
  globalDamping: number;
}

export interface IvpForceDescriptor {
  body: number;
  position: readonly number[];
  positionSpace: 'core' | 'world';
  // Already transformed by the creation-time direction referential.
  direction: readonly number[];
  // Per-PSI impulse magnitude in the original's units.
  value: number;
}

function assertFinite(values: readonly number[], message: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(message);
  }
}

// Packs a body descriptor into 18 doubles.
export function ivpDescriptor(d: IvpBodyDescriptor): number[] {
  if (
    d.position.length !== 3 ||
    (d.rotation !== undefined && d.rotation.length !== 4) ||
    (d.massCenter !== undefined && d.massCenter.length !== 3)
  ) {
    throw new Error('Invalid IVP pose dimensions');
  }
  const packed = [
    ...d.position,
    ...(d.rotation ?? [0, 0, 0, 1]),
    d.mass,
    d.friction,
    d.restitution,
    d.linearDamping,
    d.angularDamping,
    d.fixed ? 1 : 0,
    ...(d.massCenter ?? [0, 0, 0]),
    (d.collisionEnabled ?? true) ? 1 : 0,
    d.frozen ? 1 : 0,
  ];
  if (packed.length !== BODY_DESCRIPTOR_VALUES) throw new Error('Invalid IVP body descriptor');
  assertFinite(packed, 'Invalid IVP body descriptor');
  return packed;
}

// Packs a joint descriptor into 9 doubles. The kind is passed separately to the bridge.
export function ivpJointDescriptor(d: IvpJointDescriptor): number[] {
  if (
    d.anchor.length !== 3 ||
    (d.axis !== undefined && d.axis.length !== 3) ||
    (d.limits !== undefined && d.limits.length !== 2)
  ) {
    throw new Error('Invalid IVP joint dimensions');
  }
  if ((d.kind === 'hinge' || d.kind === 'slider') && d.axis === undefined) {
    throw new Error('IVP hinge/slider requires an axis');
  }
  const axis = d.axis ?? [0, 0, 1];
  const limits = d.limits ?? [0, 0];
  const packed = [...d.anchor, ...axis, d.limits !== undefined ? 1 : 0, limits[0], limits[1]];
  if (packed.length !== JOINT_DESCRIPTOR_VALUES) throw new Error('Invalid IVP joint descriptor');
  assertFinite(packed, 'Invalid IVP joint descriptor');
  return packed;
}

// Packs a spring descriptor into 10 doubles.
export function ivpSpringDescriptor(d: IvpSpringDescriptor): number[] {
  if (d.anchor1.length !== 3 || d.anchor2.length !== 3) {
    throw new Error('Invalid IVP spring dimensions');
  }
  const packed = [
    ...d.anchor1,
    ...d.anchor2,
    d.length,
    d.constant,
    d.axialDamping,
    d.globalDamping,
  ];
  if (packed.length !== SPRING_DESCRIPTOR_VALUES) throw new Error('Invalid IVP spring descriptor');
  assertFinite(packed, 'Invalid IVP spring descriptor');
  return packed;
}

// Packs a force descriptor into 7 doubles.
export function ivpForceDescriptor(d: IvpForceDescriptor): number[] {
  if (d.position.length !== 3 || d.direction.length !== 3) {
    throw new Error('Invalid IVP force dimensions');
  }
  const packed = [...d.position, ...d.direction, d.value];
  if (packed.length !== FORCE_DESCRIPTOR_VALUES) throw new Error('Invalid IVP force descriptor');
  assertFinite(packed, 'Invalid IVP force descriptor');
  return packed;
}

// Tracks heap allocations made for one bridge call so they are always released.
class Scratch {
  private readonly pointers: number[] = [];
  private readonly module: IvpModule;

  constructor(module: IvpModule) {
    this.module = module;
  }

  allocate(bytes: number): number {
    const pointer = this.module._malloc(bytes);
    this.pointers.push(pointer);
    return pointer;
  }

  doubles(values: ArrayLike<number>): number {
    const pointer = this.allocate(values.length * DOUBLE_BYTES);
    this.module.HEAPF64.set(values, pointer / DOUBLE_BYTES);
    return pointer;
  }

  // UTF-8 with a terminating zero byte.
  text(value: string): number {
    if (value.includes('\0')) throw new Error('Invalid IVP collision identifier');
    const bytes = textEncoder.encode(value);
    const pointer = this.allocate(bytes.length + 1);
    const heap = this.module.HEAPU8;
    heap.set(bytes, pointer);
    heap[pointer + bytes.length] = 0;
    return pointer;
  }

  release(): void {
    for (const pointer of this.pointers) this.module._free(pointer);
    this.pointers.length = 0;
  }
}

function expectOk(result: number, operation: string): void {
  if (result !== 1) throw new Error(`IVP ${operation} failed`);
}

function expectHandle(handle: number, operation: string): number {
  if (handle === 0) throw new Error(`IVP ${operation} failed`);
  return handle;
}

export class IvpWorld {
  private readonly module: IvpModule;
  private handle: number;
  private output: number;

  constructor(module: IvpModule, gravity = DEFAULT_GRAVITY) {
    if (typeof module._ivp_bridge_abi !== 'function' || module._ivp_bridge_abi() !== BRIDGE_ABI_VERSION) {
      throw new Error('Rebuild the IVP module: bridge ABI 7 is required');
    }
    const environment = module._ivp_new(gravity);
    if (environment === 0) throw new Error('IVP environment creation failed');
    this.module = module;
    this.handle = environment;
    this.output = module._malloc(OUTPUT_STATE_VALUES * DOUBLE_BYTES);
  }

  sphere(radius: number, descriptor: IvpBodyDescriptor): number {
    const packed = ivpDescriptor(descriptor);
    return this.withScratch((scratch) => {
      const world = this.live();
      const descriptorPointer = scratch.doubles(packed);
      const groupPointer = scratch.text(descriptor.collisionGroup ?? '');
      return expectHandle(
        this.module._ivp_ball(world, radius, descriptorPointer, groupPointer),
        'sphere creation',
      );
    });
  }

  convex(vertices: ArrayLike<number>, descriptor: IvpBodyDescriptor): number {
    if (vertices.length % 3 !== 0) throw new Error('Invalid IVP convex positions');
    const packed = ivpDescriptor(descriptor);
    return this.withScratch((scratch) => {
      const world = this.live();
      const vertexPointer = scratch.doubles(vertices);
      const descriptorPointer = scratch.doubles(packed);
      const groupPointer = scratch.text(descriptor.collisionGroup ?? '');
      return expectHandle(
        this.module._ivp_hull(world, vertices.length / 3, vertexPointer, descriptorPointer, groupPointer),
        'convex creation',
      );
    });
  }

  triangles(vertices: ArrayLike<number>, descriptor: IvpBodyDescriptor): number {
    if (vertices.length % 9 !== 0) throw new Error('Invalid IVP triangle positions');
    const packed = ivpDescriptor(descriptor);
    return this.withScratch((scratch) => {
      const world = this.live();
      const vertexPointer = scratch.doubles(vertices);
      const descriptorPointer = scratch.doubles(packed);
      const groupPointer = scratch.text(descriptor.collisionGroup ?? '');
      return expectHandle(
        this.module._ivp_trimesh(world, vertices.length / 9, vertexPointer, descriptorPointer, groupPointer),
        'triangle mesh creation',
      );
    });
  }

  compound(hulls: readonly ArrayLike<number>[], descriptor: IvpBodyDescriptor): number {
    if (hulls.length === 0) throw new Error('Invalid IVP compound hulls');
    for (const hull of hulls) {
      if (hull.length < COMPOUND_MIN_HULL_VALUES || hull.length % 3 !== 0) {
        throw new Error('Invalid IVP compound hulls');
      }
    }
    // Each hull is packed as its point count followed by its coordinates.
    const packed: number[] = [];
    for (const hull of hulls) {
      packed.push(hull.length / 3);
      for (let index = 0; index < hull.length; index += 1) packed.push(hull[index]);
    }
    const descriptorValues = ivpDescriptor(descriptor);
    return this.withScratch((scratch) => {
      const world = this.live();
      const hullPointer = scratch.doubles(packed);
      const descriptorPointer = scratch.doubles(descriptorValues);
      const groupPointer = scratch.text(descriptor.collisionGroup ?? '');
      return expectHandle(
        this.module._ivp_compound(world, hulls.length, packed.length, hullPointer, descriptorPointer, groupPointer),
        'compound creation',
      );
    });
  }

  group(body: number, name: string): void {
    this.withScratch((scratch) => {
      const world = this.live();
      const namePointer = scratch.text(name);
      expectOk(this.module._ivp_group(world, body, namePointer), 'collision group change');
    });
  }

  remove(body: number): void {
    expectOk(this.module._ivp_remove(this.live(), body), 'body removal');
  }

  pair(first: number, second: number, enabled: boolean): void {
    expectOk(this.module._ivp_pair(this.live(), first, second, enabled ? 1 : 0), 'collision pair change');
  }

  joint(descriptor: IvpJointDescriptor): number {
    const packed = ivpJointDescriptor(descriptor);
    return this.withScratch((scratch) => {
      const world = this.live();
      const descriptorPointer = scratch.doubles(packed);
      return expectHandle(
        this.module._ivp_joint(
          world,
          JOINT_KIND_CODES[descriptor.kind],
          descriptor.reference,
          descriptor.attached,
          descriptorPointer,
        ),
        'joint creation',
      );
    });
  }

  removeJoint(joint: number): void {
    expectOk(this.module._ivp_remove_joint(this.live(), joint), 'joint removal');
  }

  wake(body: number): void {
    expectOk(this.module._ivp_wake(this.live(), body), 'body wake');
  }

  spring(descriptor: IvpSpringDescriptor): number {
    const packed = ivpSpringDescriptor(descriptor);
    return this.withScratch((scratch) => {
      const world = this.live();
      const descriptorPointer = scratch.doubles(packed);
      return expectHandle(
        this.module._ivp_spring(world, descriptor.reference, descriptor.attached, descriptorPointer),
        'spring creation',
      );
    });
  }

  removeSpring(spring: number): void {
    expectOk(this.module._ivp_remove_spring(this.live(), spring), 'spring removal');
  }

  force(descriptor: IvpForceDescriptor): number {
    const packed = ivpForceDescriptor(descriptor);
    return this.withScratch((scratch) => {
      const world = this.live();
      const descriptorPointer = scratch.doubles(packed);
      const corePoint = descriptor.positionSpace === 'core' ? 1 : 0;
      return expectHandle(
        this.module._ivp_force(world, descriptor.body, corePoint, descriptorPointer),
        'force creation',
      );
    });
  }

  removeForce(force: number): void {
    expectOk(this.module._ivp_remove_force(this.live(), force), 'force removal');
  }

  push(body: number, x: number, y: number, z: number): void {
    expectOk(this.module._ivp_push(this.live(), body, x, y, z), 'impulse');
  }

  pushAt(body: number, position: readonly number[], impulse: readonly number[]): void {
    if (position.length !== 3 || impulse.length !== 3) {
      throw new Error('Invalid IVP impulse dimensions');
    }
    const values = [...position, ...impulse];
    if (values.length !== IMPULSE_AT_VALUES) throw new Error('Invalid IVP impulse dimensions');
    this.withScratch((scratch) => {
      const world = this.live();
      const valuePointer = scratch.doubles(values);
      expectOk(this.module._ivp_push_at(world, body, valuePointer), 'impulse at position');
    });
  }

  step(dt = DEFAULT_STEP_SECONDS): void {
    expectOk(this.module._ivp_step(this.live(), dt), 'simulation step');
  }

  get time(): number {
    return this.module._ivp_time(this.live());
  }

  // Returns: position xyz (interpolated render transform), rotation xyzw,
  // core linear velocity, core angular velocity, core rotational inertia,
  // and the movement state enumeration value.
  state(body: number): number[] {
    const world = this.live();
    expectOk(this.module._ivp_state(world, body, this.output), 'body state read');
    const start = this.output / DOUBLE_BYTES;
    return Array.from(this.module.HEAPF64.subarray(start, start + OUTPUT_STATE_VALUES));
  }

  contacts(body: number): IvpContact[] {
    const world = this.live();
    const count = this.module._ivp_contacts(world, body, 0, 0);
    if (count < 0) throw new Error('IVP contact read failed');
    return this.withScratch((scratch) => {
      const pointer = scratch.allocate(Math.max(count * CONTACT_VALUES, 1) * DOUBLE_BYTES);
      if (this.module._ivp_contacts(world, body, pointer, count) !== count) {
        throw new Error('IVP contact read failed');
      }
      const heap = this.module.HEAPF64;
      const first = pointer / DOUBLE_BYTES;
      const rows: IvpContact[] = [];
      for (let row = 0; row < count; row += 1) {
        const base = first + row * CONTACT_VALUES;
        const contactId = heap[base];
        const bodyA = heap[base + 1];
        const bodyB = heap[base + 2];
        // The stored normal points toward B. Flip it when this body is A.
        const sign = bodyA === body ? -1 : 1;
        rows.push({
          id: contactId,
          other: bodyA === body ? bodyB : bodyA,
          normal: [heap[base + 3] * sign, heap[base + 4] * sign, heap[base + 5] * sign],
          normalForce: heap[base + 6],
        });
      }
      return rows;
    });
  }

  drainEvents(): IvpCollisionEvent[] {
    const world = this.live();
    const count = this.module._ivp_event_count(world);
    if (count < 0) throw new Error('IVP contact read failed');
    return this.withScratch((scratch) => {
      const pointer = scratch.allocate(Math.max(count * EVENT_VALUES, 1) * DOUBLE_BYTES);
      if (this.module._ivp_events(world, pointer, count) !== count) {
        throw new Error('IVP contact read failed');
      }
      const heap = this.module.HEAPF64;
      const first = pointer / DOUBLE_BYTES;
      const events: IvpCollisionEvent[] = [];
      for (let row = 0; row < count; row += 1) {
        const base = first + row * EVENT_VALUES;
        const code = heap[base];
        const kind: IvpCollisionEvent['kind'] =
          code === EVENT_KIND_CONTACT_START
            ? 'contactStart'
            : code === EVENT_KIND_CONTACT_END
              ? 'contactEnd'
              : 'impact';
        const event: IvpCollisionEvent = {
          kind,
          time: heap[base + 1],
          contact: heap[base + 2],
          bodies: [heap[base + 3], heap[base + 4]],
        };
        if (kind !== 'contactEnd') {
          event.normal = [heap[base + 5], heap[base + 6], heap[base + 7]];
          event.point = [heap[base + 8], heap[base + 9], heap[base + 10]];
        }
        if (kind === 'impact') {
          event.relativeVelocity = [heap[base + 11], heap[base + 12], heap[base + 13]];
        }
        events.push(event);
      }
      return events;
    });
  }

  dispose(): void {
    if (this.handle === 0) return;
    this.module._ivp_delete(this.handle);
    this.module._free(this.output);
    this.handle = 0;
    this.output = 0;
  }

  private live(): number {
    if (this.handle === 0) throw new Error('IVP environment is disposed');
    return this.handle;
  }

  private withScratch<T>(work: (scratch: Scratch) => T): T {
    const scratch = new Scratch(this.module);
    try {
      return work(scratch);
    } finally {
      scratch.release();
    }
  }
}
