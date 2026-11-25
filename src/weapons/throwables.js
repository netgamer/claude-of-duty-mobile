import * as THREE from 'three';

/**
 * PLAYER THROWABLES — frag grenade and flashbang.
 *
 * The HUD has always drawn two equipment counts (a frag and a flashbang) and the
 * desktop action table has always bound `grenade` to KeyG, but nothing in the
 * game ever read either: the counts were the HUD's own defaults and the key was
 * dead. On a phone there was not even a control to press. This module is the
 * missing half — a small inventory, a lobbed projectile on the same rigid-body
 * + fuse model the AI already uses (see ai/index.js throwGrenade), and the
 * explosion/flash events the rest of the game already handles:
 *
 *   frag  -> `explosion` (fx draws it, player takes falloff damage, AI reacts)
 *   flash -> `flashbang` (ui whites the screen out) + a small `explosion`
 *
 * Counts are what `weapons.getHudState()` reports as lethalCount/tacticalCount,
 * so the HUD row and the touch buttons always agree.
 */

const DEFS = {
  frag: {
    label: 'FRAG',
    count: 2,
    fuse: 2.35,
    radius: 6.5,
    damage: 120,
    color: 0x2c3226,
    roughness: 0.62,
    metalness: 0.85,
  },
  flash: {
    label: 'FLASH',
    count: 1,
    fuse: 1.65,
    radius: 3.2,
    damage: 8,
    color: 0x9aa0a6,
    roughness: 0.45,
    metalness: 0.7,
  },
};

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

export class Throwables {
  constructor(ctx) {
    this.ctx = ctx;
    this.phys = null;
    this.root = new THREE.Group();
    this.root.name = 'ow-throwables';
    (ctx.scene ?? ctx.camera).add(this.root);

    this.counts = { frag: DEFS.frag.count, flash: DEFS.flash.count };
    this._live = [];
    this._cooldown = 0;
    this._geo = new THREE.IcosahedronGeometry(0.045, 1);
    this._mat = {
      frag: new THREE.MeshStandardMaterial({
        color: DEFS.frag.color,
        roughness: DEFS.frag.roughness,
        metalness: DEFS.frag.metalness,
      }),
      flash: new THREE.MeshStandardMaterial({
        color: DEFS.flash.color,
        roughness: DEFS.flash.roughness,
        metalness: DEFS.flash.metalness,
      }),
    };

    this._offRespawn = ctx.events.on('player:respawn', () => this.restock());
  }

  /* ====================================================================== */

  get lethalCount() {
    return this.counts.frag;
  }

  get tacticalCount() {
    return this.counts.flash;
  }

  /** Back to a full loadout — called on respawn. */
  restock() {
    this.counts.frag = DEFS.frag.count;
    this.counts.flash = DEFS.flash.count;
  }

  canThrow(type) {
    return (this.counts[type] ?? 0) > 0 && this._cooldown <= 0;
  }

  /**
   * Lob the selected throwable from the eye along the view.
   *
   * `minSpeed` is enough to clear the player's own capsule but not enough to be
   * a bullet: a real frag throw is 12-16 m/s. The forward share is the camera's
   * world direction (the viewmodel's muzzle is not the throw hand), plus 2.4 m/s
   * UP so it arcs instead of skidding, plus what the player was already carrying.
   */
  throw(type = 'frag') {
    const def = DEFS[type];
    if (!def || !this.canThrow(type)) return false;
    const phys = this.phys ?? (this.phys = this.ctx.peek('physics'));
    if (!phys) return false;

    const cam = this.ctx.camera;
    cam.getWorldDirection(_v);
    _p.copy(cam.position).addScaledVector(_v, 0.42);
    const player = this.ctx.peek('player');
    const vel = new THREE.Vector3().copy(_v).multiplyScalar(13.5).addScaledVector(UP, 2.4);
    const pv = player?.velocity;
    if (pv) vel.addScaledVector(pv, 0.5);

    const mesh = new THREE.Mesh(this._geo, this._mat[type]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);

    const body = phys.addRigidBody({
      shape: 'sphere',
      radius: 0.05,
      mass: 0.42,
      position: _p.clone(),
      velocity: { x: vel.x, y: vel.y, z: vel.z },
      restitution: 0.28,
      friction: 0.7,
      lifetime: 10,
      object3D: mesh,
      surfaceType: 'metal',
    });

    this._live.push({ type, def, body, mesh, fuse: def.fuse });
    this.counts[type]--;
    this._cooldown = 0.85;

    // A small kick so the throw is felt, and the cue audio already knows.
    player?.cameraRig?.addTrauma?.(0.1);
    this.ctx.events.emit('throwable:throw', {
      type,
      count: this.counts[type],
      position: mesh.position,
    });
    return true;
  }

  /* ====================================================================== */

  update(dt) {
    if (this._cooldown > 0) this._cooldown -= dt;
    if (!this._live.length) return;

    for (let i = this._live.length - 1; i >= 0; i--) {
      const g = this._live[i];
      g.fuse -= dt;
      if (g.fuse > 0) continue;

      const p = g.body?.position ?? g.mesh.position;
      const at = new THREE.Vector3(p.x, p.y, p.z);
      if (g.type === 'flash') {
        // The UI owns the white-out; the explosion is only the bang and smoke.
        this.ctx.events.emit('flashbang', { position: at, radius: g.def.radius });
        this.ctx.events.emit('explosion', {
          position: at,
          radius: g.def.radius,
          damage: g.def.damage,
          source: 'player',
          flash: true,
        });
      } else {
        this.ctx.events.emit('explosion', {
          position: at,
          radius: g.def.radius,
          damage: g.def.damage,
          source: 'player',
        });
      }

      this.phys?.removeRigidBody?.(g.body);
      g.mesh.removeFromParent();
      this._live.splice(i, 1);
    }
  }

  dispose() {
    this._offRespawn?.();
    for (const g of this._live) {
      this.phys?.removeRigidBody?.(g.body);
      g.mesh.removeFromParent();
    }
    this._live.length = 0;
    this.root.removeFromParent();
    this._geo.dispose();
    for (const m of Object.values(this._mat)) m.dispose();
  }
}

export { DEFS as THROWABLE_DEFS };
