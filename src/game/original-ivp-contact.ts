import type { IvpCollisionEvent } from './ivp-bridge.ts'

export interface OriginalContactChange {
  group: number
  active: boolean
}

interface GroupRecord {
  touching: number
  active: boolean
  // IVP time of the pending transition; undefined when nothing is scheduled.
  pending: number | undefined
  // Ordering key assigned when the group was scheduled.
  order: number
}

// Debounces contact events into group activation changes for one body.
export class OriginalIvpContact {
  private readonly body: number
  private readonly startDelay: number
  private readonly endDelay: number
  private readonly groups: GroupRecord[] = []
  private readonly contacts = new Map<number, number>()
  private nextOrder = 1
  private stopped = false

  constructor(body: number, groupCount: number, startDelay: number, endDelay: number) {
    if (!Number.isInteger(groupCount) || groupCount < 0 || !Number.isFinite(startDelay) || !Number.isFinite(endDelay)) {
      throw new Error('Invalid original contact settings')
    }
    this.body = body
    this.startDelay = startDelay
    this.endDelay = endDelay
    for (let i = 0; i < groupCount; i++) {
      this.groups.push({ touching: 0, active: false, pending: undefined, order: 0 })
    }
  }

  consume(events: readonly IvpCollisionEvent[], groupForBody: (body: number) => number): OriginalContactChange[] {
    if (this.stopped) return []
    const changes: OriginalContactChange[] = []
    for (const event of events) {
      if (event.kind === 'impact') continue
      const [first, second] = event.bodies
      if (first !== this.body && second !== this.body) continue
      if (event.kind === 'contactStart') {
        this.onContactStart(event, first === this.body ? second : first, groupForBody, changes)
      } else if (event.kind === 'contactEnd') {
        this.onContactEnd(event)
      }
    }
    return changes
  }

  process(time: number): OriginalContactChange[] {
    if (!Number.isFinite(time)) throw new Error('Invalid original contact time')
    if (this.stopped) return []
    const changes: OriginalContactChange[] = []
    const scheduled = this.groups
      .map((group, index) => ({ group, index }))
      .filter((entry) => entry.group.pending !== undefined)
      .sort((a, b) => b.group.order - a.group.order)

    for (const { group, index } of scheduled) {
      const since = time - (group.pending as number)
      if (group.active) {
        if (group.touching !== 0) {
          group.pending = undefined
        } else if (since > this.endDelay) {
          group.pending = undefined
          group.active = false
          changes.push({ group: index + 1, active: false })
        }
      } else if (group.touching <= 0) {
        if (since * 0.5 > this.startDelay) group.pending = undefined
      } else if (since > this.startDelay) {
        group.pending = undefined
        group.active = true
        changes.push({ group: index + 1, active: true })
      }
    }
    return changes
  }

  stop(): OriginalContactChange[] {
    this.stopped = true
    this.contacts.clear()
    const changes: OriginalContactChange[] = []
    this.groups.forEach((group, index) => {
      if (group.active) changes.push({ group: index + 1, active: false })
      group.active = false
      group.touching = 0
      group.pending = undefined
    })
    return changes
  }

  private onContactStart(
    event: IvpCollisionEvent,
    other: number,
    groupForBody: (body: number) => number,
    changes: OriginalContactChange[],
  ): void {
    if (this.contacts.has(event.contact)) return
    const index = groupForBody(other) - 1
    if (!Number.isInteger(index) || index < 0 || index >= this.groups.length) return

    this.contacts.set(event.contact, index)
    const group = this.groups[index]
    group.touching += 1
    if (group.touching !== 1) return

    if (group.active) {
      group.pending = undefined
    } else if (group.pending !== undefined && this.startDelay < event.time - group.pending) {
      group.pending = undefined
      group.active = true
      changes.push({ group: index + 1, active: true })
    } else {
      this.schedule(index, event.time)
    }
  }

  private onContactEnd(event: IvpCollisionEvent): void {
    const index = this.contacts.get(event.contact)
    if (index === undefined) return
    this.contacts.delete(event.contact)
    const group = this.groups[index]
    group.touching = Math.max(0, group.touching - 1)
    if (group.touching === 0 && group.active) this.schedule(index, event.time)
  }

  private schedule(index: number, time: number): void {
    const group = this.groups[index]
    if (group.pending !== undefined) return
    group.pending = time
    group.order = this.nextOrder
    this.nextOrder += 1
  }
}
