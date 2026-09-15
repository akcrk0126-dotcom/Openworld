/**
 * DestructionManager.js
 *
 * The only object that knows how a hit becomes debris. Everything else stays
 * ignorant: the chunk knows about tiles, the pool knows about shards, this
 * knows about the event that connects them.
 *
 * Hit -> tile resolution goes through the collider registry rather than a
 * Three.js Raycaster. One ray cast in Rapier replaces a BVH traversal over
 * thousands of instanced tiles, and it gives back the exact collider handle
 * we already mapped to {chunk, tileIndex}.
 */

import * as THREE from 'three';

const _impactToShard = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spawnPos = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _identity = new THREE.Quaternion();

export class DestructionManager {
  /**
   * @param {{
   *   physics: import('../physics/PhysicsWorld.js').PhysicsWorld,
   *   shardPool: import('./ShardPool.js').ShardPool,
   *   library: import('./FracturePatternLibrary.js').FracturePatternLibrary,
   *   onTileDestroyed?: (chunk, tileIndex, point) => void,
   * }} cfg
   */
  constructor({ physics, shardPool, library, onTileDestroyed = null }) {
    this.physics = physics;
    this.shardPool = shardPool;
    this.library = library;
    this.onTileDestroyed = onTileDestroyed;

    /** Tuning knobs, safe to expose in a debug panel. */
    this.settings = {
      radialBias: 0.78,     // how much shards fly straight away from the impact
      forwardBias: 0.34,    // how much they inherit the projectile's direction
      upwardBias: 0.16,     // a little lift reads as "explosive" rather than "dropped"
      spin: 0.055,          // angular impulse scale
      falloffRadius: 1.4,   // metres; shards further than this get much less push
      jitter: 0.12,         // direction randomisation, keeps patterns from looking rigid
      ccdSpeedThreshold: 26,
    };

    this.stats = { tilesDestroyed: 0, shardsSpawned: 0 };
  }

  /**
   * Resolve a raycast hit and apply damage.
   *
   * @param {{
   *   origin: THREE.Vector3,
   *   direction: THREE.Vector3,   normalized ray direction
   *   maxDistance?: number,
   *   damage?: number,
   *   force?: number,
   *   splashRadius?: number,      >0 destroys neighbouring tiles too
   * }} shot
   * @returns {{hit:boolean, point?:THREE.Vector3, destroyed?:number}}
   */
  fireRay(shot) {
    const { origin, direction, maxDistance = 220, damage = 60, force = 5.2, splashRadius = 0 } = shot;

    const hit = this.physics.raycast(origin, direction, maxDistance);
    if (!hit) return { hit: false };

    const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
    const ud = hit.userData;
    if (!ud || ud.kind !== 'tile') return { hit: true, point, destroyed: 0 };

    return { hit: true, point, destroyed: this.applyDamage(ud.chunk, ud.tileIndex, { point, direction, damage, force, splashRadius }) };
  }

  /**
   * @param {import('../world/DestructibleChunk.js').DestructibleChunk} chunk
   * @param {number} tileIndex
   */
  applyDamage(chunk, tileIndex, { point, direction, damage = 60, force = 5.2, splashRadius = 0 }) {
    let destroyed = 0;

    if (chunk.applyDamage(tileIndex, damage)) {
      destroyed += this.shatterTile(chunk, tileIndex, point, direction, force) ? 1 : 0;
    }

    if (splashRadius > 0) {
      const neighbours = chunk.tilesInRadius(point, splashRadius);
      for (const idx of neighbours) {
        if (idx === tileIndex) continue;
        const falloff = 1 - chunk.tileCenters[idx].distanceTo(point) / splashRadius;
        if (chunk.applyDamage(idx, damage * falloff)) {
          destroyed += this.shatterTile(chunk, idx, point, direction, force * falloff) ? 1 : 0;
        }
      }
    }

    return destroyed;
  }

  /**
   * Swap one intact tile for its pre-baked fragments.
   * @returns {boolean} false when the tile was already gone
   */
  shatterTile(chunk, tileIndex, impactPoint, rayDirection, force) {
    if (!chunk.removeTile(tileIndex)) return false;

    const center = chunk.tileCenters[tileIndex];
    // Salting by chunk + tile keeps the variant stable per tile but varied
    // across the wall, so no two adjacent tiles shatter identically.
    const { cells, shapeIds } = this.library.pickVariant(chunk.archetype, chunk.id * 73856093 + tileIndex);

    _rayDir.copy(rayDirection).normalize();
    const s = this.settings;

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];

      // Fragment starts exactly where its slice of the tile used to be, so
      // frame 1 of the shatter is pixel-identical to the intact tile.
      _spawnPos.copy(cell.offset).applyQuaternion(chunk.quaternion).add(center);

      _impactToShard.subVectors(_spawnPos, impactPoint);
      const distance = _impactToShard.length();
      if (distance < 1e-4) _impactToShard.copy(_rayDir);
      else _impactToShard.divideScalar(distance);

      _dir
        .copy(_impactToShard).multiplyScalar(s.radialBias)
        .addScaledVector(_rayDir, s.forwardBias)
        .addScaledVector(_up, s.upwardBias);

      _dir.x += (Math.random() - 0.5) * s.jitter;
      _dir.y += (Math.random() - 0.5) * s.jitter;
      _dir.z += (Math.random() - 0.5) * s.jitter;
      _dir.normalize();

      // Inverse-square-ish falloff: fragments at the entry wound get thrown,
      // fragments at the far corner merely slump. This one curve is most of
      // what makes destruction read as an impact instead of a scripted burst.
      const falloff = 1 / (1 + (distance / s.falloffRadius) ** 2);

      const record = this.shardPool.spawn(shapeIds[i], _spawnPos, _identity, { x: 0, y: 0, z: 0 });
      if (!record) continue;

      // applyImpulse is mass-dependent. Scaling by mass gives every fragment
      // the same launch *velocity*, so big slabs and slivers stay together as
      // one coherent burst instead of the small ones rocketing away.
      const mass = record.body.mass() || 1;
      const speed = force * falloff;
      _impulse.copy(_dir).multiplyScalar(speed * mass);
      record.body.applyImpulse(_impulse, true);

      _torque.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .multiplyScalar(speed * mass * s.spin);
      record.body.applyTorqueImpulse(_torque, true);

      if (speed > s.ccdSpeedThreshold) record.body.enableCcd(true);

      this.stats.shardsSpawned++;
    }

    this.stats.tilesDestroyed++;
    this.onTileDestroyed?.(chunk, tileIndex, impactPoint);
    return true;
  }

  update(dt) {
    this.shardPool.update(dt);
  }
}
