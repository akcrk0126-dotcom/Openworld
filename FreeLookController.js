/**
 * FreeLookController.js
 * Minimal pointer-lock flight camera + fire input. Deliberately not a character
 * controller — swap it for Rapier's KinematicCharacterController when you move
 * past the destruction prototype stage.
 */

import * as THREE from 'three';

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class FreeLookController {
  constructor(camera, domElement, { speed = 14, boost = 3, sensitivity = 0.0022 } = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.speed = speed;
    this.boost = boost;
    this.sensitivity = sensitivity;

    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.locked = false;
    /** @type {Array<(button:number)=>void>} */
    this.onFire = [];

    this._bind();
  }

  _bind() {
    this.dom.addEventListener('click', () => {
      if (!this.locked) this.dom.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      for (const fn of this.onFire) fn(e.button);
    });

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  getDirection(out) {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
  }

  update(dt) {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));

    _forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _right.crossVectors(_forward, _up).normalize();

    const v = this.speed * (this.keys.has('ShiftLeft') ? this.boost : 1) * dt;
    if (this.keys.has('KeyW')) this.camera.position.addScaledVector(_forward, v);
    if (this.keys.has('KeyS')) this.camera.position.addScaledVector(_forward, -v);
    if (this.keys.has('KeyD')) this.camera.position.addScaledVector(_right, v);
    if (this.keys.has('KeyA')) this.camera.position.addScaledVector(_right, -v);
    if (this.keys.has('Space')) this.camera.position.addScaledVector(_up, v);
    if (this.keys.has('KeyC')) this.camera.position.addScaledVector(_up, -v);
  }
}
