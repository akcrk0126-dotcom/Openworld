/**
 * PhysicsWorld.js
 * Thin, opinionated wrapper around Rapier3D (compat/WASM build).
 *
 * Why Rapier over cannon-es:
 *  - Rust compiled to WASM; roughly an order of magnitude faster once you pass
 *    ~200 simultaneous dynamic bodies, which is exactly the debris regime.
 *  - Built-in convex-hull colliders with automatic mass properties. Fractured
 *    shards are convex by construction, so we never need a trimesh collider
 *    (trimesh dynamic bodies are unstable and slow in every engine).
 *  - Deterministic fixed-step integrator and cheap island sleeping, which is
 *    what lets us auto-despawn debris on "settled" rather than on a dumb timer.
 */

import RAPIER from '@dimforge/rapier3d-compat';

/** Collision layers. Membership in the high 16 bits, filter mask in the low 16. */
export const LAYER = {
  WORLD: 0x0001,
  DEBRIS: 0x0002,
  PLAYER: 0x0004,
};

export function groups(membership, collidesWith) {
  return ((membership & 0xffff) << 16) | (collidesWith & 0xffff);
}

/**
 * Debris deliberately does NOT collide with other debris. This is the single
 * biggest perf lever in a destruction system: shard-vs-shard is O(n^2)-ish in
 * the broadphase and contributes almost nothing visually once the dust settles.
 * Flip DEBRIS_SELF_COLLIDE if you want the expensive-but-prettier behaviour.
 */
const DEBRIS_SELF_COLLIDE = false;
const DEBRIS_MASK = LAYER.WORLD | LAYER.PLAYER | (DEBRIS_SELF_COLLIDE ? LAYER.DEBRIS : 0);

export const GROUPS = {
  world: groups(LAYER.WORLD, LAYER.WORLD | LAYER.DEBRIS | LAYER.PLAYER),
  debris: groups(LAYER.DEBRIS, DEBRIS_MASK),
  player: groups(LAYER.PLAYER, LAYER.WORLD | LAYER.DEBRIS),
};

export class PhysicsWorld {
  /**
   * @param {{gravity?: {x:number,y:number,z:number}, timestep?: number}} [opts]
   * @returns {Promise<PhysicsWorld>}
   */
  static async create(opts = {}) {
    await RAPIER.init();
    return new PhysicsWorld(opts);
  }

  constructor({ gravity = { x: 0, y: -22, z: 0 }, timestep = 1 / 60 } = {}) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World(gravity);
    this.world.timestep = timestep;

    /** colliderHandle -> arbitrary game object. How a raycast hit becomes a tile. */
    this._colliderUserData = new Map();

    // Feature-detect body enable/disable. Present in Rapier >= 0.12. When it
    // exists we can park a body instead of destroying it, which keeps the
    // handle-allocation churn at zero while recycling hundreds of shards.
    this.supportsBodyToggle =
      typeof RAPIER.RigidBody.prototype.setEnabled === 'function';

    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  step() {
    this.world.step();
  }

  // ---------------------------------------------------------------- registry

  bindCollider(collider, userData) {
    this._colliderUserData.set(collider.handle, userData);
    return collider;
  }

  unbindCollider(collider) {
    this._colliderUserData.delete(collider.handle);
  }

  userDataFor(colliderHandle) {
    return this._colliderUserData.get(colliderHandle) ?? null;
  }

  // ----------------------------------------------------------------- bodies

  /** Static box. Used for terrain and for each undamaged destructible tile. */
  createStaticCuboid(position, halfExtents, { userData = null, collisionGroups = GROUPS.world, friction = 0.9 } = {}) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z)
    );
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setFriction(friction)
      .setCollisionGroups(collisionGroups);
    const collider = this.world.createCollider(desc, body);
    if (userData) this.bindCollider(collider, userData);
    return { body, collider };
  }

  /**
   * Dynamic convex hull from a flat Float32Array of local-space points.
   * Rapier derives mass/inertia from the hull volume x density, so shards
   * get physically plausible weight differences for free.
   */
  createDynamicConvexHull(points, { density = 1.6, friction = 0.85, restitution = 0.08, ccd = false, collisionGroups = GROUPS.debris, linearDamping = 0.05, angularDamping = 0.35 } = {}) {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setCcdEnabled(ccd)
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping)
      .setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.convexHull(points);
    if (!colliderDesc) {
      this.world.removeRigidBody(body);
      return null; // degenerate/coplanar cell — caller should drop this shard
    }
    colliderDesc
      .setDensity(density)
      .setFriction(friction)
      .setRestitution(restitution)
      .setCollisionGroups(collisionGroups);

    const collider = this.world.createCollider(colliderDesc, body);
    return { body, collider };
  }

  removeBody(body) {
    this.world.removeRigidBody(body);
  }

  /** Park a pooled body outside the simulation without freeing its handle. */
  setBodyActive(body, active) {
    if (this.supportsBodyToggle) {
      body.setEnabled(active);
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------- queries

  /**
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir normalized
   * @returns {{point:{x,y,z}, normal:{x,y,z}, distance:number, collider:any, userData:any}|null}
   */
  raycast(origin, dir, maxDistance = 200, { excludeCollider = null, filterGroups = undefined } = {}) {
    this._ray.origin.x = origin.x;
    this._ray.origin.y = origin.y;
    this._ray.origin.z = origin.z;
    this._ray.dir.x = dir.x;
    this._ray.dir.y = dir.y;
    this._ray.dir.z = dir.z;

    const hit = this.world.castRayAndGetNormal(
      this._ray,
      maxDistance,
      true,          // solid
      undefined,     // query filter flags
      filterGroups,
      excludeCollider ?? undefined
    );
    if (!hit) return null;

    // Rapier renamed `toi` -> `timeOfImpact`; support both.
    const t = hit.timeOfImpact ?? hit.toi;
    return {
      distance: t,
      point: {
        x: origin.x + dir.x * t,
        y: origin.y + dir.y * t,
        z: origin.z + dir.z * t,
      },
      normal: hit.normal,
      collider: hit.collider,
      userData: this.userDataFor(hit.collider.handle),
    };
  }

  get bodyCount() {
    return this.world.bodies.len();
  }
}
