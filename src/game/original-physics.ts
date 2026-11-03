import RAPIER from '@dimforge/rapier3d-compat'
import type { Material } from './levels.ts'
import { SCALE } from './original-data.ts'

export interface PhysicalMaterial {
  mass: number
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
}

// Original simulation clock: the IVP clock runs at twice real time, and the
// solver ticks at its default rate.
export const ORIGINAL_TIME_FACTOR = 2
export const ORIGINAL_PSI_HZ = 66
export const PHYSICS_STEP = 1 / (ORIGINAL_PSI_HZ * ORIGINAL_TIME_FACTOR)
export const GRAVITY = -20 * SCALE * ORIGINAL_TIME_FACTOR * ORIGINAL_TIME_FACTOR

export const PLAYER_PHYSICS: Record<Material, PhysicalMaterial> = {
  wood: { mass: 1.9, friction: 0.8, restitution: 0.2, linearDamping: 0.9, angularDamping: 0.1 },
  stone: { mass: 10, friction: 0.5, restitution: 0.1, linearDamping: 0.3, angularDamping: 0.1 },
  paper: { mass: 0.2, friction: 0.5, restitution: 0.4, linearDamping: 1.5, angularDamping: 0.1 },
}

// IVP multiplies the two surfaces' coefficients; Rapier averages by default.
export function configureContact(
  collider: RAPIER.ColliderDesc,
  material: Pick<PhysicalMaterial, 'friction' | 'restitution'>,
): RAPIER.ColliderDesc {
  collider.setFriction(material.friction)
  collider.setRestitution(material.restitution)
  collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
  collider.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
  return collider
}

// Converts IVP's exponential velocity decay into Rapier's reciprocal damping.
export function configureBody(body: RAPIER.RigidBody, material: PhysicalMaterial, dt = PHYSICS_STEP): void {
  body.setLinearDamping(Math.expm1(material.linearDamping * ORIGINAL_TIME_FACTOR * dt) / dt)
  body.setAngularDamping(Math.expm1(material.angularDamping * ORIGINAL_TIME_FACTOR * dt) / dt)
}
