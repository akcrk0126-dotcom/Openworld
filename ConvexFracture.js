/**
 * ConvexFracture.js
 * Generates fracture patterns by recursively splitting a box with random planes.
 *
 * DESIGN NOTE — why not runtime CSG:
 * Boolean/Voronoi fracture at the moment of impact (three-bvh-csg, voro++ ports)
 * costs 20-200ms per wall on a mid-range laptop and allocates dozens of buffers.
 * That is a guaranteed hitch on every shot. Instead we pre-bake a handful of
 * patterns once during load, and destruction at runtime is nothing but a pool
 * fetch plus a transform write.
 *
 * Each cell is the intersection of half-spaces, therefore convex, therefore
 * usable directly as a Rapier convexHull collider with correct mass properties.
 *
 * Plane convention: a point p is inside a half-space when  n·p + d <= 0.
 */

import * as THREE from 'three';

/** Small deterministic PRNG so patterns are reproducible across sessions/clients. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Solve for the single point where three planes meet. Null if near-parallel. */
function intersectThreePlanes(a, b, c, out) {
  const bc = new THREE.Vector3().crossVectors(b.n, c.n);
  const det = a.n.dot(bc);
  if (Math.abs(det) < 1e-8) return null;

  const ca = new THREE.Vector3().crossVectors(c.n, a.n);
  const ab = new THREE.Vector3().crossVectors(a.n, b.n);

  out
    .copy(bc).multiplyScalar(-a.d)
    .addScaledVector(ca, -b.d)
    .addScaledVector(ab, -c.d)
    .divideScalar(det);
  return out;
}

/**
 * Enumerate the vertices of a convex cell defined by half-spaces.
 * Plane counts stay small (6 box planes + ~4 cut planes), so the O(n^3) triple
 * loop is ~120 candidate points — far cheaper and far more robust than trying
 * to maintain a winged-edge polyhedron through successive clips.
 */
function cellVertices(planes, eps = 1e-5) {
  const pts = [];
  const tmp = new THREE.Vector3();
  const n = planes.length;

  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        if (!intersectThreePlanes(planes[i], planes[j], planes[k], tmp)) continue;

        let inside = true;
        for (let m = 0; m < n; m++) {
          if (planes[m].n.dot(tmp) + planes[m].d > eps) { inside = false; break; }
        }
        if (!inside) continue;

        let duplicate = false;
        for (let q = 0; q < pts.length; q++) {
          if (pts[q].distanceToSquared(tmp) < 1e-8) { duplicate = true; break; }
        }
        if (!duplicate) pts.push(tmp.clone());
      }
    }
  }
  return pts;
}

function boxPlanes(hx, hy, hz) {
  return [
    { n: new THREE.Vector3( 1, 0, 0), d: -hx },
    { n: new THREE.Vector3(-1, 0, 0), d: -hx },
    { n: new THREE.Vector3( 0, 1, 0), d: -hy },
    { n: new THREE.Vector3( 0,-1, 0), d: -hy },
    { n: new THREE.Vector3( 0, 0, 1), d: -hz },
    { n: new THREE.Vector3( 0, 0,-1), d: -hz },
  ];
}

function centroidOf(points, out) {
  out.set(0, 0, 0);
  for (const p of points) out.add(p);
  return out.divideScalar(points.length || 1);
}

function looseVolume(points) {
  const box = new THREE.Box3().setFromPoints(points);
  const s = box.getSize(new THREE.Vector3());
  return s.x * s.y * s.z;
}

/**
 * Distance from the cell's centroid to its nearest bounding plane, i.e. an
 * approximate inscribed radius.
 *
 * Bounding-box volume alone does not catch slivers: a thin diagonal wafer has a
 * perfectly healthy bbox. Slivers are poison for a physics engine — the convex
 * hull comes out nearly coplanar, the inertia tensor goes ill-conditioned, and
 * the shard buzzes on the floor instead of settling. Reject them at the cut.
 */
function inscribedRadius(points, planes) {
  const c = centroidOf(points, new THREE.Vector3());
  let min = Infinity;
  for (const plane of planes) {
    const dist = -(plane.n.dot(c) + plane.d);
    if (dist < min) min = dist;
  }
  return min;
}

/**
 * Build the cell's surface directly from its bounding planes.
 *
 * The obvious route is ConvexGeometry (a general quickhull) over the vertex
 * set. We do not need it: a cell IS the intersection of known half-spaces, so
 * every face is already named by a plane. Collecting the vertices that lie on
 * each plane, sorting them around the face centroid and fan-triangulating gives
 * the exact surface — with no general hull code, no extra dependency, and exact
 * flat facet normals, which is what fractured stone should have anyway.
 *
 * Dropping the `three/addons/` import also removes one CDN path from startup.
 */
function buildCellGeometry(points, planes, uvScale, eps = 1e-4) {
  const positions = [];
  const normals = [];
  const uvs = [];

  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const rel = new THREE.Vector3();

  for (const plane of planes) {
    const face = points.filter((p) => Math.abs(plane.n.dot(p) + plane.d) < eps);
    if (face.length < 3) continue;

    centre.set(0, 0, 0);
    for (const p of face) centre.add(p);
    centre.divideScalar(face.length);

    // Any tangent will do; pick the axis least aligned with the normal so the
    // cross product stays well conditioned.
    const n = plane.n;
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (ax <= ay && ax <= az) u.set(1, 0, 0);
    else if (ay <= az) u.set(0, 1, 0);
    else u.set(0, 0, 1);
    u.addScaledVector(n, -n.dot(u)).normalize();
    v.crossVectors(n, u); // u x v === n, so ascending angle winds CCW seen from outside

    const ordered = face
      .map((p) => {
        rel.subVectors(p, centre);
        return { p, angle: Math.atan2(rel.dot(v), rel.dot(u)) };
      })
      .sort((a, b) => a.angle - b.angle)
      .map((entry) => entry.p);

    // Box-projected UVs, so a tiling brick or concrete map still reads on the
    // shard faces. ConvexGeometry produced none; this picks the dominant axis
    // of the face normal and drops the other two coordinates in.
    const useYZ = ax >= ay && ax >= az;
    const useXZ = !useYZ && ay >= az;

    for (let i = 1; i < ordered.length - 1; i++) {
      const tri = [ordered[0], ordered[i], ordered[i + 1]];
      for (const p of tri) {
        positions.push(p.x, p.y, p.z);
        normals.push(n.x, n.y, n.z);
        if (useYZ) uvs.push(p.z * uvScale, p.y * uvScale);
        else if (useXZ) uvs.push(p.x * uvScale, p.z * uvScale);
        else uvs.push(p.x * uvScale, p.y * uvScale);
      }
    }
  }

  if (positions.length < 9) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * @typedef {Object} FractureCell
 * @property {THREE.BufferGeometry} geometry  centred on its own centroid
 * @property {THREE.Vector3} offset           centroid in tile-local space
 * @property {Float32Array} hullPoints        flat xyz for Rapier convexHull
 * @property {number} volume                  approximate, used for mass tiering
 */

/**
 * Fracture an axis-aligned box into convex cells.
 *
 * @param {{x:number,y:number,z:number}} size full extents of the tile
 * @param {{cells?:number, seed?:number, bias?:THREE.Vector3, uvScale?:number}} [opts]
 *   bias — scales the random plane normal per axis. For a thin wall panel, bias
 *   the thin axis down so you get tall slabs rather than confetti.
 * @returns {FractureCell[]}
 */
export function fractureBox(size, opts = {}) {
  const {
    cells = 12,
    seed = 1337,
    bias = new THREE.Vector3(1, 1, 1),
    uvScale = 0.5,
    // Fraction of the tile's thinnest dimension below which a cell is discarded.
    minThicknessRatio = 0.09,
  } = opts;
  const rand = mulberry32(seed);

  const hx = size.x * 0.5, hy = size.y * 0.5, hz = size.z * 0.5;
  const minThickness = Math.min(size.x, size.y, size.z) * minThicknessRatio;

  let regions = [{ planes: boxPlanes(hx, hy, hz), points: null }];
  regions[0].points = cellVertices(regions[0].planes);

  const tmpCentroid = new THREE.Vector3();

  let guard = 0;
  while (regions.length < cells && guard++ < cells * 14) {
    // Always split the chunkiest region so shard sizes stay reasonably even.
    let target = 0, best = -Infinity;
    for (let i = 0; i < regions.length; i++) {
      const v = looseVolume(regions[i].points);
      if (v > best) { best = v; target = i; }
    }
    const region = regions[target];

    const n = new THREE.Vector3(
      (rand() * 2 - 1) * bias.x,
      (rand() * 2 - 1) * bias.y,
      (rand() * 2 - 1) * bias.z
    );
    if (n.lengthSq() < 1e-6) continue;
    n.normalize();

    // Jitter the cut off-centre so the pattern is not suspiciously symmetric.
    const c = centroidOf(region.points, tmpCentroid).clone();
    c.x += (rand() * 2 - 1) * hx * 0.28;
    c.y += (rand() * 2 - 1) * hy * 0.28;
    c.z += (rand() * 2 - 1) * hz * 0.28;
    const d = -n.dot(c);

    const frontPlanes = [...region.planes, { n: n.clone(), d }];
    const backPlanes  = [...region.planes, { n: n.clone().negate(), d: -d }];
    const frontPts = cellVertices(frontPlanes);
    const backPts  = cellVertices(backPlanes);

    // Reject slivers — they produce degenerate hulls and jittery contacts.
    if (frontPts.length < 4 || backPts.length < 4) continue;
    if (looseVolume(frontPts) < best * 0.04 || looseVolume(backPts) < best * 0.04) continue;
    if (inscribedRadius(frontPts, frontPlanes) < minThickness) continue;
    if (inscribedRadius(backPts, backPlanes) < minThickness) continue;

    regions.splice(target, 1,
      { planes: frontPlanes, points: frontPts },
      { planes: backPlanes,  points: backPts }
    );
  }

  const out = [];
  for (const region of regions) {
    const offset = centroidOf(region.points, new THREE.Vector3()).clone();
    const local = region.points.map((p) => p.clone().sub(offset));

    // Shift the cell's planes into the same centred frame as its vertices.
    const localPlanes = region.planes.map((plane) => ({
      n: plane.n,
      d: plane.d + plane.n.dot(offset),
    }));

    const geometry = buildCellGeometry(local, localPlanes, uvScale);
    if (!geometry) continue; // degenerate cell

    const hullPoints = new Float32Array(local.length * 3);
    for (let i = 0; i < local.length; i++) {
      hullPoints[i * 3]     = local[i].x;
      hullPoints[i * 3 + 1] = local[i].y;
      hullPoints[i * 3 + 2] = local[i].z;
    }

    out.push({ geometry, offset, hullPoints, volume: looseVolume(local) });
  }

  return out;
}
