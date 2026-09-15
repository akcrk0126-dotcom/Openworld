/**
 * main.js — composition root.
 *
 * Boot order is load-bearing:
 *   1. Rapier WASM must be initialised before any body is described.
 *   2. Fracture patterns must be baked before the ShardPool, because the pool
 *      allocates one InstancedMesh per unique shard geometry up front.
 *   3. Chunks can then be registered in any order.
 *
 * The whole sequence runs inside one try/catch that reports to the boot screen.
 * Startup here spans CDN resolution, WASM init and geometry baking — three
 * things that fail for reasons outside the code — so a failure has to be
 * visible on the page, not just in the console.
 */

import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { BootScreen } from './core/BootScreen.js';
import { PhysicsWorld, GROUPS } from './physics/PhysicsWorld.js';
import { FracturePatternLibrary } from './destruction/FracturePatternLibrary.js';
import { ShardPool } from './destruction/ShardPool.js';
import { DestructionManager } from './destruction/DestructionManager.js';
import { DestructibleChunk } from './world/DestructibleChunk.js';
import { FreeLookController } from './gameplay/FreeLookController.js';

// ---------------------------------------------------------------- materials

/** Cheap procedural grain so flat-shaded shards still read as a real surface. */
function grainTexture(base, speckle, contrast = 18, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (Math.random() - 0.5) * contrast;
    image.data[i] += n;
    image.data[i + 1] += n;
    image.data[i + 2] += n;
  }
  ctx.putImageData(image, 0, 0);

  ctx.fillStyle = speckle;
  for (let i = 0; i < size * 1.6; i++) {
    ctx.globalAlpha = Math.random() * 0.25;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// -------------------------------------------------------------------- boot

async function boot() {
  BootScreen.armWatchdog();

  if (location.protocol === 'file:') {
    throw new Error(
      'This page is open over file://, which blocks ES modules and CDN imports.\n' +
      'Serve the folder instead:  python3 -m http.server 8080'
    );
  }

  // -- renderer ------------------------------------------------------------
  BootScreen.stage('Creating the WebGL context');
  const canvas = document.getElementById('viewport');
  if (!canvas) throw new Error('No <canvas id="viewport"> in the document');

  const engine = new Engine({ canvas });

  // -- physics -------------------------------------------------------------
  const physics = await PhysicsWorld.create({
    gravity: { x: 0, y: -24, z: 0 },
    onProgress: (msg) => BootScreen.stage(msg),
  });
  BootScreen.stage('Physics engine ready');

  // -- materials -----------------------------------------------------------
  const brickMaterial = new THREE.MeshStandardMaterial({
    map: grainTexture('#9a5b43', '#5e3324', 26),
    roughness: 0.94,
    metalness: 0.0,
  });
  const concreteMaterial = new THREE.MeshStandardMaterial({
    map: grainTexture('#8d8f88', '#5a5c57', 16),
    roughness: 0.98,
    metalness: 0.0,
  });

  // -- scene ---------------------------------------------------------------
  BootScreen.stage('Building the scene');
  engine.scene.background = new THREE.Color('#10151a');
  engine.scene.fog = new THREE.Fog('#10151a', 32, 130);
  engine.camera.position.set(0, 4.2, 22);

  const key = new THREE.DirectionalLight('#ffd9a8', 2.6);
  key.position.set(18, 26, 12);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 90;
  key.shadow.camera.left = -34;
  key.shadow.camera.right = 34;
  key.shadow.camera.top = 34;
  key.shadow.camera.bottom = -34;
  key.shadow.bias = -0.0008;
  key.shadow.camera.updateProjectionMatrix();
  engine.scene.add(key);
  engine.scene.add(new THREE.HemisphereLight('#7fa3c4', '#2b2622', 0.85));

  // Ground: visual plane + one static collider. Not destructible.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: '#2f3630', roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  engine.scene.add(ground);
  physics.createStaticCuboid({ x: 0, y: -1, z: 0 }, { x: 120, y: 1, z: 120 }, { collisionGroups: GROUPS.world });

  // -- fracture patterns ---------------------------------------------------
  // Wall panels are thin, so the fracture bias on Z is low: we want tall slabs
  // and angular chips, not cubes. Floor slabs get the inverse treatment.
  BootScreen.stage('Baking fracture patterns');
  const library = new FracturePatternLibrary();

  library.bake('wall-brick', { x: 1, y: 1, z: 0.4 }, {
    variants: 2, cells: 11, seed: 4211,
    bias: new THREE.Vector3(1, 1, 0.3), uvScale: 0.9,
  });
  library.bake('floor-slab', { x: 1.2, y: 0.35, z: 1.2 }, {
    variants: 2, cells: 9, seed: 8807,
    bias: new THREE.Vector3(1, 0.3, 1), uvScale: 0.8,
  });

  if (library.shapeCount === 0) {
    throw new Error('Fracture baking produced no shards — check ConvexGeometry resolved correctly');
  }
  BootScreen.stage(`Baked ${library.shapeCount} shard shapes`);

  const shardPool = new ShardPool({
    scene: engine.scene,
    physics,
    library,
    materials: { 'wall-brick': brickMaterial, 'floor-slab': concreteMaterial },
    capacityPerShape: 12,
    maxActive: 480,
    settleDelay: 3.5,
    maxLifetime: 18,
    fadeTime: 0.5,
    killPlaneY: -30,
  });

  const destruction = new DestructionManager({ physics, shardPool, library });

  // -- level ---------------------------------------------------------------
  BootScreen.stage('Placing destructible geometry');
  const chunks = [];

  function wall(origin, tilesX, tilesY, rotationY = 0) {
    const chunk = new DestructibleChunk({
      scene: engine.scene, physics,
      archetype: 'wall-brick',
      material: brickMaterial,
      tileSize: { x: 1, y: 1, z: 0.4 },
      dimensions: { x: tilesX, y: tilesY, z: 1 },
      origin, rotationY,
      hitPoints: 100,
    });
    chunks.push(chunk);
    return chunk;
  }

  wall(new THREE.Vector3(-7, 0, -6), 14, 8);
  wall(new THREE.Vector3(-14, 0, 2), 10, 6, Math.PI / 2);
  wall(new THREE.Vector3(9, 0, -2), 10, 6, -Math.PI / 2);

  chunks.push(new DestructibleChunk({
    scene: engine.scene, physics,
    archetype: 'floor-slab',
    material: concreteMaterial,
    tileSize: { x: 1.2, y: 0.35, z: 1.2 },
    dimensions: { x: 10, y: 1, z: 10 },
    origin: new THREE.Vector3(-6, 5, 6),
    hitPoints: 80,
  }));

  // -- weapons -------------------------------------------------------------
  const controller = new FreeLookController(engine.camera, canvas);
  const rayDirection = new THREE.Vector3();

  const WEAPONS = {
    0: { label: 'Rifle',    damage: 130, force: 5.6,  splashRadius: 0 },
    2: { label: 'Breacher', damage: 420, force: 11.5, splashRadius: 2.3 },
  };

  controller.onFire.push((button) => {
    const weapon = WEAPONS[button];
    if (!weapon) return;
    controller.getDirection(rayDirection);
    destruction.fireRay({
      origin: engine.camera.position,
      direction: rayDirection,
      ...weapon,
    });
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // -- loop ----------------------------------------------------------------
  engine.addFixed(() => physics.step());
  engine.addFrame((dt) => {
    controller.update(dt);
    destruction.update(dt);
  });

  const readout = {
    fps: document.getElementById('stat-fps'),
    shards: document.getElementById('stat-shards'),
    bodies: document.getElementById('stat-bodies'),
    tiles: document.getElementById('stat-tiles'),
  };
  let smoothedFps = 60;
  let accum = 0;
  engine.addFrame((dt) => {
    smoothedFps += (1 / Math.max(dt, 1e-4) - smoothedFps) * 0.08;
    accum += dt;
    if (accum < 0.2) return;
    accum = 0;
    if (readout.fps) readout.fps.textContent = smoothedFps.toFixed(0);
    if (readout.shards) readout.shards.textContent = `${shardPool.activeCount} / ${shardPool.maxActive}`;
    if (readout.bodies) readout.bodies.textContent = physics.bodyCount;
    if (readout.tiles) readout.tiles.textContent = destruction.stats.tilesDestroyed;
  });

  // Handy for console poking during tuning.
  Object.assign(globalThis, { engine, physics, shardPool, destruction, library, chunks });

  BootScreen.done();
  engine.start();
}

boot().catch((error) => BootScreen.fail(error));
