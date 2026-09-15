/**
 * ShardPool.js
 *
 * Owns every piece of debris in the world. Two pools working together:
 *
 *  1. RENDER POOL — one InstancedMesh per unique shard geometry. A shard is a
 *     slot index into that mesh's instanceMatrix. Slots are kept densely packed
 *     (swap-remove on free) so `mesh.count` tracks the true live count and the
 *     GPU never processes dead instances.
 *
 *  2. BODY POOL — Rapier rigid bodies are created once per slot and then parked
 *     (setEnabled(false)) instead of destroyed. Creating/destroying bodies every
 *     frame is what turns a smooth destruction system into a stuttering one:
 *     it churns WASM allocations and invalidates broadphase proxies.
 *
 * Despawn policy, in priority order:
 *   a. hard budget pressure   -> recycle oldest immediately
 *   b. below the kill plane   -> recycle immediately
 *   c. body has gone to sleep -> hold for settleDelay, then fade out
 *   d. maxLifetime exceeded   -> fade out regardless
 *
 * Fade is a uniform scale-to-zero. It needs no extra material, no transparency
 * sorting and no per-instance alpha attribute, and at shard size it is visually
 * indistinguishable from a dissolve. See README for the shader-based variant.
 */

import * as THREE from 'three';
import { GROUPS } from '../physics/PhysicsWorld.js';

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

class ShapeBatch {
  constructor(shape, material, capacity, scene) {
    this.shape = shape;
    this.capacity = capacity;
    this.records = new Array(capacity).fill(null);
    this.count = 0;

    this.mesh = new THREE.InstancedMesh(shape.geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // debris moves every frame; culling per-mesh is wrong here
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.name = `shards:${shape.key}:${shape.id}`;
    scene.add(this.mesh);

    /** Parked bodies available for reuse, one shape == one collider geometry. */
    this.freeBodies = [];
  }

  alloc(record) {
    if (this.count >= this.capacity) return -1;
    const slot = this.count++;
    this.records[slot] = record;
    record.slot = slot;
    this.mesh.count = this.count;
    return slot;
  }

  free(slot) {
    const last = --this.count;
    if (slot !== last) {
      const moved = this.records[last];
      this.records[slot] = moved;
      moved.slot = slot;
      moved.dirty = true;
    }
    this.records[last] = null;
    this.mesh.count = this.count;
    this.mesh.setMatrixAt(last, _zero);
  }
}

export class ShardPool {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   physics: import('../physics/PhysicsWorld.js').PhysicsWorld,
   *   library: import('./FracturePatternLibrary.js').FracturePatternLibrary,
   *   materials: Record<string, THREE.Material>,
   *   capacityPerShape?: number,
   *   maxActive?: number,
   *   settleDelay?: number,
   *   maxLifetime?: number,
   *   fadeTime?: number,
   *   killPlaneY?: number,
   * }} cfg
   */
  constructor(cfg) {
    const {
      scene, physics, library, materials,
      capacityPerShape = 14,
      maxActive = 520,
      settleDelay = 3.5,
      maxLifetime = 16,
      fadeTime = 0.45,
      killPlaneY = -40,
    } = cfg;

    this.scene = scene;
    this.physics = physics;
    this.library = library;
    this.maxActive = maxActive;
    this.settleDelay = settleDelay;
    this.maxLifetime = maxLifetime;
    this.fadeTime = fadeTime;
    this.killPlaneY = killPlaneY;

    /** @type {ShapeBatch[]} indexed by shape id */
    this.batches = library.shapes.map((shape) => {
      const material = materials[shape.key] ?? materials.default;
      if (!material) throw new Error(`ShardPool: no material for archetype "${shape.key}"`);
      return new ShapeBatch(shape, material, capacityPerShape, scene);
    });

    /** @type {Set<object>} every live shard record, insertion-ordered (oldest first). */
    this.active = new Set();
    this._recycleQueue = [];
  }

  get activeCount() {
    return this.active.size;
  }

  /**
   * @param {number} shapeId
   * @param {THREE.Vector3} worldPosition centre of mass position at spawn
   * @param {THREE.Quaternion} worldQuaternion
   * @param {THREE.Vector3} impulse world-space linear impulse
   * @param {THREE.Vector3} [torque] world-space angular impulse
   * @param {boolean} [ccd] enable continuous collision for fast, thin shards
   */
  spawn(shapeId, worldPosition, worldQuaternion, impulse, torque = null, ccd = false) {
    if (this.active.size >= this.maxActive) this._recycleOldest();

    const batch = this.batches[shapeId];
    if (!batch) return null;

    let entry = batch.freeBodies.pop();
    if (!entry) {
      entry = this.physics.createDynamicConvexHull(batch.shape.hullPoints, {
        ccd,
        collisionGroups: GROUPS.debris,
      });
      if (!entry) return null; // degenerate hull; pattern baking already filters most
    }

    const { body } = entry;
    this.physics.setBodyActive(body, true);
    body.setTranslation(worldPosition, false);
    body.setRotation(worldQuaternion, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    body.wakeUp();
    body.applyImpulse(impulse, true);
    if (torque) body.applyTorqueImpulse(torque, true);

    const record = {
      shapeId,
      slot: -1,
      body,
      entry,
      age: 0,
      sleepTime: 0,
      fade: 1,
      state: 'live',
      dirty: true,
    };

    if (batch.alloc(record) === -1) {
      // This shape's batch is saturated. Steal the oldest slot in it.
      const victim = batch.records[0];
      this._recycle(victim);
      batch.alloc(record);
    }

    this.active.add(record);
    this._writeMatrix(batch, record);
    return record;
  }

  update(dt) {
    const settleDelay = this.settleDelay;
    const maxLifetime = this.maxLifetime;

    for (const record of this.active) {
      record.age += dt;

      if (record.state === 'live') {
        const t = record.body.translation();
        if (t.y < this.killPlaneY) { this._recycleQueue.push(record); continue; }

        if (record.body.isSleeping()) {
          record.sleepTime += dt;
          if (record.sleepTime >= settleDelay) record.state = 'fading';
        } else {
          record.sleepTime = 0;
          record.dirty = true;
        }

        if (record.age >= maxLifetime) record.state = 'fading';
      }

      if (record.state === 'fading') {
        record.fade -= dt / this.fadeTime;
        record.dirty = true;
        if (record.fade <= 0) { this._recycleQueue.push(record); continue; }
      }
    }

    // Free first, so compaction happens before any matrix is written.
    for (let i = 0; i < this._recycleQueue.length; i++) this._recycle(this._recycleQueue[i]);
    this._recycleQueue.length = 0;

    // Single transform-sync pass. Sleeping, non-fading shards are skipped.
    const touched = new Set();
    for (const record of this.active) {
      if (!record.dirty) continue;
      const batch = this.batches[record.shapeId];
      this._writeMatrix(batch, record);
      if (record.state === 'live' && record.body.isSleeping()) record.dirty = false;
      touched.add(batch);
    }
    for (const batch of touched) batch.mesh.instanceMatrix.needsUpdate = true;
  }

  _writeMatrix(batch, record) {
    const t = record.body.translation();
    const r = record.body.rotation();
    _pos.set(t.x, t.y, t.z);
    _quat.set(r.x, r.y, r.z, r.w);
    _scale.setScalar(Math.max(record.fade, 0));
    _m4.compose(_pos, _quat, _scale);
    batch.mesh.setMatrixAt(record.slot, _m4);
    batch.mesh.instanceMatrix.needsUpdate = true;
  }

  _recycle(record) {
    if (!this.active.has(record)) return;
    const batch = this.batches[record.shapeId];

    if (!this.physics.setBodyActive(record.body, false)) {
      // Engine build without setEnabled: destroy and let spawn() rebuild.
      this.physics.removeBody(record.body);
      batch.free(record.slot);
      this.active.delete(record);
      batch.mesh.instanceMatrix.needsUpdate = true;
      return;
    }

    record.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    record.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    batch.freeBodies.push(record.entry);
    batch.free(record.slot);
    this.active.delete(record);
    batch.mesh.instanceMatrix.needsUpdate = true;
  }

  _recycleOldest() {
    const oldest = this.active.values().next().value;
    if (oldest) this._recycle(oldest);
  }

  clear() {
    for (const record of [...this.active]) this._recycle(record);
  }

  dispose() {
    this.clear();
    for (const batch of this.batches) {
      this.scene.remove(batch.mesh);
      batch.mesh.dispose();
      for (const entry of batch.freeBodies) this.physics.removeBody(entry.body);
      batch.freeBodies.length = 0;
    }
    this.batches.length = 0;
  }
}
