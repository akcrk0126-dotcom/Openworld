/**
 * Engine.js
 * Renderer + scene + camera + a fixed-timestep loop.
 *
 * The loop matters for destruction specifically: a variable timestep makes
 * impulse response frame-rate dependent, so the same shot throws debris further
 * on a 144Hz monitor than on a 60Hz one. Fixed steps with an accumulator, and a
 * hard cap on catch-up steps so a tab-switch stall does not spiral.
 */

import * as THREE from 'three';

export class Engine {
  constructor({ canvas, fixedStep = 1 / 60, maxSubSteps = 5, shadows = true } = {}) {
    this.fixedStep = fixedStep;
    this.maxSubSteps = maxSubSteps;
    this._accumulator = 0;
    this._last = 0;
    this._running = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    if (shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 500);

    /** @type {Array<(dt:number)=>void>} runs at the fixed rate */
    this.fixedSystems = [];
    /** @type {Array<(dt:number)=>void>} runs once per rendered frame */
    this.frameSystems = [];

    this._onResize = () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    };
    addEventListener('resize', this._onResize);
  }

  addFixed(fn) { this.fixedSystems.push(fn); return this; }
  addFrame(fn) { this.frameSystems.push(fn); return this; }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this.renderer.setAnimationLoop(() => this._tick());
  }

  stop() {
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  _tick() {
    const now = performance.now();
    let frameDelta = (now - this._last) / 1000;
    this._last = now;
    // Clamp so returning from a background tab does not dump a second of
    // simulation into one frame and launch every shard into orbit.
    if (frameDelta > 0.25) frameDelta = 0.25;

    this._accumulator += frameDelta;
    let steps = 0;
    while (this._accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      for (const fn of this.fixedSystems) fn(this.fixedStep);
      this._accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === this.maxSubSteps) this._accumulator = 0;

    for (const fn of this.frameSystems) fn(frameDelta);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
