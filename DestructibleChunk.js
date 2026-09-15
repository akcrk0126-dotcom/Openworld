/**
 * DestructibleChunk.js
 *
 * A wall or floor section, authored as a grid of tiles.
 *
 * Intact tiles are drawn as one InstancedMesh (one draw call per chunk) and
 * collide as one static cuboid each. "Destroying" a tile is three cheap ops:
 *   - zero-scale its instance matrix
 *   - drop its static collider
 *   - ask the DestructionManager for shards
 *
 * Streaming: call setActive(false) on distant chunks to release their colliders
 * while keeping the visual. Physics cost scales with what is near the player,
 * not with world size — which is what makes this viable in an open world.
 */

import * as THREE from 'three';
import { GROUPS } from '../physics/PhysicsWorld.js';

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

let _chunkSeq = 0;

export class DestructibleChunk {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   physics: import('../physics/PhysicsWorld.js').PhysicsWorld,
   *   archetype: string,
   *   material: THREE.Material,
   *   tileSize: {x:number,y:number,z:number},
   *   dimensions: {x:number,y:number,z:number},   tiles along each axis
   *   origin: THREE.Vector3,                      world position of the chunk's min corner
   *   rotationY?: number,
   *   hitPoints?: number,
   * }} cfg
   */
  constructor(cfg) {
    const {
      scene, physics, archetype, material,
      tileSize, dimensions, origin,
      rotationY = 0, hitPoints = 100,
    } = cfg;

    this.id = _chunkSeq++;
    this.scene = scene;
    this.physics = physics;
    this.archetype = archetype;
    this.tileSize = new THREE.Vector3(tileSize.x, tileSize.y, tileSize.z);
    this.dimensions = { ...dimensions };
    this.origin = origin.clone();
    this.quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
    this.defaultHitPoints = hitPoints;

    this.tileCount = dimensions.x * dimensions.y * dimensions.z;
    this.hp = new Float32Array(this.tileCount).fill(hitPoints);
    this.destroyed = new Uint8Array(this.tileCount);
    /** @type {(null|{body:any, collider:any})[]} */
    this.colliders = new Array(this.tileCount).fill(null);
    this.tileCenters = new Array(this.tileCount);

    const geometry = new THREE.BoxGeometry(tileSize.x, tileSize.y, tileSize.z);
    this.mesh = new THREE.InstancedMesh(geometry, material, this.tileCount);
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = `chunk:${archetype}:${this.id}`;
    scene.add(this.mesh);

    for (let i = 0; i < this.tileCount; i++) {
      const center = this._computeTileCenter(i, new THREE.Vector3());
      this.tileCenters[i] = center;
      _m4.compose(center, this.quaternion, new THREE.Vector3(1, 1, 1));
      this.mesh.setMatrixAt(i, _m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    this.active = false;
    this.setActive(true);
  }

  index(ix, iy, iz) {
    return ix + this.dimensions.x * (iy + this.dimensions.y * iz);
  }

  _computeTileCenter(index, out) {
    const { x: nx, y: ny } = this.dimensions;
    const ix = index % nx;
    const iy = Math.floor(index / nx) % ny;
    const iz = Math.floor(index / (nx * ny));

    _v3.set(
      (ix + 0.5) * this.tileSize.x,
      (iy + 0.5) * this.tileSize.y,
      (iz + 0.5) * this.tileSize.z
    ).applyQuaternion(this.quaternion);

    return out.copy(this.origin).add(_v3);
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      for (let i = 0; i < this.tileCount; i++) {
        if (!this.destroyed[i]) this._createTileCollider(i);
      }
    } else {
      for (let i = 0; i < this.tileCount; i++) this._removeTileCollider(i);
    }
  }

  _createTileCollider(index) {
    if (this.colliders[index]) return;
    const half = { x: this.tileSize.x * 0.5, y: this.tileSize.y * 0.5, z: this.tileSize.z * 0.5 };
    const entry = this.physics.createStaticCuboid(this.tileCenters[index], half, {
      userData: { kind: 'tile', chunk: this, tileIndex: index },
      collisionGroups: GROUPS.world,
    });
    this.colliders[index] = entry;
  }

  _removeTileCollider(index) {
    const entry = this.colliders[index];
    if (!entry) return;
    this.physics.unbindCollider(entry.collider);
    this.physics.removeBody(entry.body);
    this.colliders[index] = null;
  }

  /** @returns {boolean} true when this hit broke the tile. */
  applyDamage(index, amount) {
    if (this.destroyed[index]) return false;
    this.hp[index] -= amount;
    return this.hp[index] <= 0;
  }

  /** Visually and physically remove a tile. Shards are the manager's job. */
  removeTile(index) {
    if (this.destroyed[index]) return false;
    this.destroyed[index] = 1;
    this._removeTileCollider(index);
    this.mesh.setMatrixAt(index, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  /** Tiles whose centres fall inside a sphere — used for splash/explosive damage. */
  tilesInRadius(worldPoint, radius, out = []) {
    const r2 = radius * radius;
    for (let i = 0; i < this.tileCount; i++) {
      if (this.destroyed[i]) continue;
      if (this.tileCenters[i].distanceToSquared(worldPoint) <= r2) out.push(i);
    }
    return out;
  }

  dispose() {
    this.setActive(false);
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
