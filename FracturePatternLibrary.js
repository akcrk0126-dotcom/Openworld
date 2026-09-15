/**
 * FracturePatternLibrary.js
 *
 * Bakes a small set of fracture patterns per "tile archetype" (wall panel,
 * floor slab, pillar...) during load, and hands them to the ShardPool so it can
 * allocate one InstancedMesh per distinct shard geometry up front.
 *
 * Multiple variants per archetype matter: with a single pattern, a player who
 * breaks two walls immediately notices the identical debris. Three or four
 * variants, picked pseudo-randomly from the tile index, kills that tell for
 * essentially zero runtime cost.
 */

import * as THREE from 'three';
import { fractureBox } from './ConvexFracture.js';

export class FracturePatternLibrary {
  constructor() {
    /** @type {Map<string, {size:THREE.Vector3, variants:import('./ConvexFracture.js').FractureCell[][], shapeIds:number[][]}>} */
    this.archetypes = new Map();
    /** Flat list of every unique shard geometry across all archetypes. */
    this.shapes = [];
  }

  /**
   * @param {string} key archetype name, e.g. 'wall-brick'
   * @param {{x:number,y:number,z:number}} size full tile extents
   * @param {{variants?:number, cells?:number, seed?:number, bias?:THREE.Vector3, uvScale?:number}} [opts]
   */
  bake(key, size, opts = {}) {
    const { variants = 3, cells = 12, seed = 9001, bias, uvScale } = opts;

    const variantCells = [];
    const variantShapeIds = [];

    for (let v = 0; v < variants; v++) {
      const cellList = fractureBox(size, { cells, seed: seed + v * 7919, bias, uvScale });
      const ids = cellList.map((cell) => {
        const id = this.shapes.length;
        this.shapes.push({
          id,
          key,
          geometry: cell.geometry,
          hullPoints: cell.hullPoints,
          volume: cell.volume,
        });
        return id;
      });
      variantCells.push(cellList);
      variantShapeIds.push(ids);
    }

    this.archetypes.set(key, {
      size: new THREE.Vector3(size.x, size.y, size.z),
      variants: variantCells,
      shapeIds: variantShapeIds,
    });
    return this;
  }

  /** Deterministic variant pick so the same tile always shatters the same way. */
  pickVariant(key, salt = 0) {
    const arch = this.archetypes.get(key);
    if (!arch) throw new Error(`FracturePatternLibrary: unknown archetype "${key}"`);
    const index = Math.abs(Math.imul(salt ^ 0x9e3779b9, 0x85ebca6b)) % arch.variants.length;
    return { cells: arch.variants[index], shapeIds: arch.shapeIds[index] };
  }

  get shapeCount() {
    return this.shapes.length;
  }

  dispose() {
    for (const shape of this.shapes) shape.geometry.dispose();
    this.shapes.length = 0;
    this.archetypes.clear();
  }
}
