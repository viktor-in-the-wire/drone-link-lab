// drone3d.js
// The quadcopter, drawn as blueprint line art with Three.js.
//
// Every part is a mesh with an invisible white "occluder" material (so lines
// behind a surface are hidden) plus its edges as fat lines (LineSegments2 +
// LineMaterial) for a crisp 1.5 px stroke. Nothing is ever shaded.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const BLUE = 0x2563eb, DEEP = 0x1d4ed8, PALE = 0x93c5fd, GRID = 0xe0e7ff;
const WORLD_SCALE = 0.15;                 // scene units per simulated metre (ground scroll)
const altToY = (a) => 0.44 + 2.2 * (1 - Math.exp(-Math.max(0, a) / 25));  // compressed altitude
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class DroneView {
  constructor(host, { reducedMotion = false } = {}) {
    this.host = host;
    this.reducedMotion = reducedMotion;
    this.visible = true;
    this.materials = [];

    // Renderer: white background, pixel ratio capped at 2.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.setAttribute('aria-label', 'Wireframe quadcopter. Drag to rotate, scroll or pinch to zoom.');
    this.renderer.domElement.setAttribute('role', 'img');
    host.appendChild(this.renderer.domElement);

    // Overlay for blueprint callouts (SVG leader lines + HTML labels).
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'callout-lines');
    this.svg.setAttribute('aria-hidden', 'true');
    host.appendChild(this.svg);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'callout-labels';
    host.appendChild(this.labelLayer);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    this.camera.position.set(4.7, 2.7, 4.9);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3.2;
    this.controls.maxDistance = 16;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.autoRotate = !reducedMotion;
    this.controls.autoRotateSpeed = 0.55;
    // Stop the idle orbit while the user drags; resume after a few seconds.
    let idleTimer = 0;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; clearTimeout(idleTimer); });
    this.controls.addEventListener('end', () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { this.controls.autoRotate = !this.reducedMotion; }, 4000);
    });

    // Shared materials.
    this.occluder = new THREE.MeshBasicMaterial({
      color: 0xffffff, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.lineMat = this.mat(BLUE, 1.5);
    this.deepMat = this.mat(DEEP, 1.7);
    this.paleMat = this.mat(PALE, 1, { dashed: true, dashSize: 0.06, gapSize: 0.05 });
    this.axisMat = this.mat(PALE, 1, { dashed: true, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0 });
    this.rulerMat = this.mat(BLUE, 1.1);

    this.buildGround();
    this.buildDrone();
    this.buildRuler();
    this.buildCallouts();

    this.explodeClock = reducedMotion ? null : 1.6;  // start exploded, then assemble
    this.camLift = 0;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  /** A fat-line material that tracks the canvas resolution. */
  mat(color, linewidth, extra = {}) {
    const m = new LineMaterial({ color, linewidth, worldUnits: false, ...extra });
    this.materials.push(m);
    return m;
  }

  /** Mesh (invisible occluder) + its edges (visible lines). */
  part(geometry, material = this.lineMat, threshold = 20) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geometry, this.occluder));
    const edges = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(geometry, threshold));
    const lines = new LineSegments2(edges, material);
    g.add(lines);
    return g;
  }

  /** Lines only, from a flat list of segment endpoints. */
  segments(points, material) {
    const geo = new LineSegmentsGeometry().setPositions(points);
    const l = new LineSegments2(geo, material);
    if (material.dashed) l.computeLineDistances();
    return l;
  }

  circlePoints(r, n = 48, y = 0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      pts.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r);
    }
    return pts;
  }

  buildGround() {
    // Faint grid; it scrolls under the drone as the drone moves.
    this.grid = new THREE.GridHelper(16, 32, GRID, GRID);
    this.scene.add(this.grid);
    // Home marker: a crosshair circle at the launch point.
    const p = this.circlePoints(0.28, 40);
    p.push(-0.42, 0, 0, 0.42, 0, 0, 0, 0, -0.42, 0, 0, 0.42);
    this.home = this.segments(p, this.rulerMat);
    this.home.position.y = 0.002;
    this.scene.add(this.home);
  }

  buildDrone() {
    this.drone = new THREE.Group();           // position + yaw/pitch/roll
    this.drone.rotation.order = 'YZX';
    this.scene.add(this.drone);
    this.parts = [];
    const add = (obj, pos, dir, parent = this.drone) => {
      obj.position.copy(pos);
      parent.add(obj);
      this.parts.push({ obj, base: pos.clone(), dir });
      return obj;
    };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    // Plan-view outline (x forward, y = right) extruded upward with a chamfer.
    const plate = (pts, depth, bevel, scale = 1) => {
      const s = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x * scale, z * scale)));
      const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 4 });
      g.translate(0, 0, -depth / 2);
      g.rotateX(Math.PI / 2);
      return g;
    };
    const HULL = [[0.6, 0.11], [0.36, 0.27], [-0.38, 0.27], [-0.54, 0.14], [-0.54, -0.14], [-0.38, -0.27], [0.36, -0.27], [0.6, -0.11]];

    // Fuselage: chamfered lower hull + raised canopy shell + nose arrow.
    const hull = add(new THREE.Group(), V(0, 0, 0), V(0, 0, 0));
    hull.add(this.part(plate(HULL, 0.12, 0.03), this.deepMat, 15));
    const canopy = this.part(plate(HULL, 0.05, 0.04, 0.72), this.lineMat, 15);
    canopy.position.set(-0.03, 0.12, 0);
    const canopyGroup = add(new THREE.Group(), V(0, 0, 0), V(0, 0.45, 0));
    canopyGroup.add(canopy);
    canopyGroup.add(this.segments([0.36, 0.172, 0, 0.18, 0.172, 0.07, 0.36, 0.172, 0, 0.18, 0.172, -0.07, 0.18, 0.172, 0.07, 0.18, 0.172, -0.07], this.deepMat));
    // Status LEDs on the nose.
    for (const z of [-0.06, 0.06]) {
      const led = this.segments(this.circlePoints(0.018, 12), this.deepMat);
      led.rotation.z = Math.PI / 2;
      led.position.set(0.635, 0, z);
      hull.add(led);
    }

    // GPS mast with puck, and two antenna whips at the tail.
    const mast = add(new THREE.Group(), V(-0.3, 0.17, 0), V(-0.15, 1.0, 0));
    mast.add(this.segments([0, 0, 0, 0, 0.2, 0], this.lineMat));
    this.gps = this.part(new THREE.CylinderGeometry(0.1, 0.1, 0.035, 24), this.deepMat, 40);
    this.gps.position.y = 0.22;
    mast.add(this.gps);
    mast.add(this.segments([-0.05, 0.24, 0, 0.05, 0.24, 0, 0, 0.24, -0.05, 0, 0.24, 0.05], this.lineMat));
    const whips = add(new THREE.Group(), V(-0.5, 0.04, 0), V(-0.6, 0.25, 0));
    for (const z of [-0.1, 0.1]) whips.add(this.segments([0, 0, z, -0.16, 0.3, z * 2.2], this.lineMat));

    // Battery pack with two straps, slung under the hull.
    this.battery = add(new THREE.Group(), V(-0.04, -0.14, 0), V(0, -0.6, 0));
    this.battery.add(this.part(new THREE.BoxGeometry(0.58, 0.1, 0.3), this.lineMat));
    for (const x of [-0.14, 0.14]) {
      const strap = this.part(new THREE.BoxGeometry(0.04, 0.115, 0.315), this.lineMat);
      strap.position.x = x;
      this.battery.add(strap);
    }

    // Four tapered arms with fold joints, motors and propellers on the diagonals.
    this.props = [];
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const dir = V(Math.cos(a), 0, Math.sin(a));
      const arm = new THREE.Group();
      const beam = new THREE.CylinderGeometry(0.03, 0.046, 0.84, 4);
      beam.rotateY(Math.PI / 4);
      beam.rotateZ(-Math.PI / 2);            // thin end points outward (+x)
      const beamPart = this.part(beam, this.lineMat, 20);
      beamPart.position.x = 0.42;
      arm.add(beamPart);
      const joint = this.part(new THREE.BoxGeometry(0.12, 0.09, 0.12), this.lineMat);
      joint.position.x = 0.03;
      arm.add(joint);
      arm.rotation.y = -a;
      add(arm, dir.clone().multiplyScalar(0.3), dir.clone().multiplyScalar(0.35));

      // Motor: mount plate, stator, tapered bell with vents, shaft cap.
      const motor = new THREE.Group();
      const mount = this.part(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 24), this.lineMat, 40);
      mount.position.y = 0.0;
      const stator = this.part(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 24), this.lineMat, 40);
      stator.position.y = 0.035;
      const bell = this.part(new THREE.CylinderGeometry(0.1, 0.12, 0.09, 24), this.deepMat, 40);
      bell.position.y = 0.1;
      const cap = this.part(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 12), this.lineMat, 40);
      cap.position.y = 0.16;
      motor.add(mount, stator, bell, cap);
      const vents = [];
      for (let v = 0; v < 8; v++) {
        const t = (v / 8) * Math.PI * 2;
        vents.push(Math.cos(t) * 0.12, 0.06, Math.sin(t) * 0.12, Math.cos(t) * 0.1, 0.14, Math.sin(t) * 0.1);
      }
      motor.add(this.segments(vents, this.lineMat));
      add(motor, dir.clone().multiplyScalar(1.2).setY(0.02), dir.clone().multiplyScalar(0.85).setY(0.2));
      if (k === 0) this.motor = motor;

      const prop = new THREE.Group();
      const spin = new THREE.Group();
      prop.add(spin);
      for (let bl = 0; bl < 2; bl++) {
        const s = new THREE.Shape();
        s.moveTo(0.04, -0.028);
        s.bezierCurveTo(0.18, -0.085, 0.42, -0.07, 0.55, -0.014);
        s.quadraticCurveTo(0.575, 0.006, 0.545, 0.02);
        s.bezierCurveTo(0.4, 0.03, 0.2, 0.05, 0.04, 0.028);
        s.closePath();
        const g = new THREE.ShapeGeometry(s, 12);
        g.rotateX(-Math.PI / 2);
        g.rotateY(bl * Math.PI);
        const blade = this.part(g, this.lineMat, 10);
        blade.rotation.x = (k % 2 ? 1 : -1) * 0.12;   // a hint of pitch
        spin.add(blade);
      }
      spin.add(this.part(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 16), this.lineMat, 40));
      const disc = this.segments(this.circlePoints(0.56, 64), this.paleMat);
      disc.visible = false;
      prop.add(disc);
      add(prop, dir.clone().multiplyScalar(1.2).setY(0.2), dir.clone().multiplyScalar(0.85).setY(0.65));
      this.props.push({ spin, disc, dir: k % 2 ? 1 : -1 });
    }

    // Landing gear: two splayed struts per side and skids with upturned tips.
    for (const side of [-1, 1]) {
      const z0 = side * 0.17, z1 = side * 0.34;
      const leg = this.segments([
        0.2, -0.06, z0, 0.24, -0.44, z1,
        -0.2, -0.06, z0, -0.24, -0.44, z1,
        0.22, -0.25, (z0 + z1) / 2 + side * 0.0, -0.22, -0.25, (z0 + z1) / 2,
        -0.46, -0.44, z1, 0.46, -0.44, z1,
        0.46, -0.44, z1, 0.56, -0.37, z1,
        -0.46, -0.44, z1, -0.56, -0.37, z1,
      ], this.deepMat);
      add(leg, V(0, 0, 0), V(0, -0.7, side * 0.3));
    }

    // Camera gimbal under the nose: mount, yoke, camera body and lens.
    // The pivot counter-rotates so the camera stays level in flight.
    const gimbal = new THREE.Group();
    gimbal.add(this.part(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 20), this.lineMat, 40));
    this.gimbalPivot = new THREE.Group();
    this.gimbalPivot.position.y = -0.1;
    gimbal.add(this.gimbalPivot);
    gimbal.add(this.segments([0, -0.01, -0.1, 0, -0.1, -0.1, 0, -0.01, 0.1, 0, -0.1, 0.1, 0, -0.01, -0.1, 0, -0.01, 0.1], this.lineMat));
    this.gimbalPivot.add(this.part(new THREE.BoxGeometry(0.15, 0.11, 0.15), this.deepMat));
    const lens = this.part(new THREE.CylinderGeometry(0.045, 0.05, 0.06, 20), this.lineMat, 40);
    lens.rotation.z = Math.PI / 2;
    lens.position.x = 0.1;
    this.gimbalPivot.add(lens);
    const glass = this.segments(this.circlePoints(0.028, 16), this.lineMat);
    glass.rotation.z = Math.PI / 2;
    glass.position.x = 0.131;
    this.gimbalPivot.add(glass);
    this.gimbal = add(gimbal, V(0.38, -0.08, 0), V(0.55, -1.0, 0));

    // Dashed assembly axis, visible only in the exploded view.
    this.axis = this.segments([0, -1.6, 0, 0, 1.9, 0], this.axisMat);
    this.drone.add(this.axis);

    // Plumb line and dashed footprint on the ground (plan projection).
    this.plumb = this.segments([0, 0, 0, 0, 1, 0], this.rulerMat);
    this.scene.add(this.plumb);
    this.footprint = this.segments(this.circlePoints(1.05, 72, 0.004), this.paleMat);
    this.scene.add(this.footprint);
  }

  buildRuler() {
    // Altitude ruler (compressed scale) with ticks and a moving marker.
    this.ruler = new THREE.Group();
    this.ruler.position.set(-2.1, 0, -1.4);
    const pts = [0, 0, 0, 0, altToY(100), 0];
    this.rulerTicks = [0, 5, 10, 20, 40, 80];
    for (const a of this.rulerTicks) { const y = altToY(a) - 0.44; pts.push(0, y, 0, 0.12, y, 0); }
    for (let a = 0; a <= 40; a += 2.5) { const y = altToY(a) - 0.44; pts.push(0, y, 0, 0.06, y, 0); }
    this.ruler.add(this.segments(pts, this.rulerMat));
    this.marker = this.segments([-0.14, 0, 0, 0.2, 0, 0, -0.14, 0, 0, -0.06, 0.05, 0, -0.14, 0, 0, -0.06, -0.05, 0], this.deepMat);
    this.ruler.add(this.marker);
    this.scene.add(this.ruler);
    this.rulerLabels = this.rulerTicks.map((a) => {
      const el = document.createElement('span');
      el.className = 'ruler-label';
      el.textContent = a === 0 ? '0 m' : `${a}`;
      this.labelLayer.appendChild(el);
      return { el, y: altToY(a) - 0.44 };
    });
    this.altLabel = document.createElement('span');
    this.altLabel.className = 'ruler-label ruler-alt';
    this.labelLayer.appendChild(this.altLabel);
  }

  buildCallouts() {
    const anchor = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };
    this.callouts = [
      { anchor: anchor(this.motor, 0, 0.08, 0), dy: -54 },
      { anchor: anchor(this.gps, 0, 0.03, 0), dy: -62 },
      { anchor: anchor(this.drone, 0.45, 0.06, 0.2), dy: 40 },
      { anchor: anchor(this.battery, 0, -0.05, 0.12), dy: 66 },
    ].map((c) => {
      c.el = document.createElement('span');
      c.el.className = 'callout';
      this.labelLayer.appendChild(c.el);
      c.line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      c.dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.dot.setAttribute('r', '3');
      this.svg.append(c.line, c.dot);
      return c;
    });
  }

  /** Move the whole view (canvas + overlay) into another container. */
  mountInto(slot) {
    if (this.host.parentElement !== slot) slot.appendChild(this.host);
    this.resize();
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const m of this.materials) m.resolution.set(w, h);
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.size = { w, h };
  }

  setReducedMotion(on) {
    this.reducedMotion = on;
    this.controls.autoRotate = !on;
  }

  /** Play the exploded view: separate, hold, reassemble. */
  explode() {
    this.explodeClock = 0;
  }

  explodeAmount(dt) {
    if (this.explodeClock === null) return 0;
    this.explodeClock += dt;
    const t = this.explodeClock;
    if (t > 3.4) { this.explodeClock = null; return 0; }
    if (t < 0.9) return ease(t / 0.9);
    if (t < 2.1) return 1;
    return 1 - ease((t - 2.1) / 1.3);
  }

  project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.size.w, y: (-p.y * 0.5 + 0.5) * this.size.h, behind: p.z > 1 };
  }

  /**
   * Advance and draw one frame.
   * @param {number} dt seconds
   * @param {object} s  drone state from the simulation + labels
   */
  frame(dt, s) {
    if (!this.visible) return;

    // Exploded view.
    const ex = this.explodeAmount(dt);
    for (const p of this.parts) p.obj.position.copy(p.base).addScaledVector(p.dir, ex);
    this.axisMat.opacity = ex;

    // Pose: altitude (compressed), yaw, pitch (nose down = forward), roll.
    const y = altToY(s.alt);
    this.drone.position.y = y;
    this.drone.rotation.set(s.roll, s.yaw, -s.pitch);
    const bob = s.armed && s.alt > 0.05 && !this.reducedMotion ? Math.sin(performance.now() / 600) * 0.025 : 0;
    this.drone.position.y += bob;

    const lift = (y - 0.44) * 0.75 - this.camLift;  // keep the drone framed as it climbs
    this.camLift += lift;
    this.camera.position.y += lift;
    this.controls.target.y += lift;

    // Ground scrolls under the drone; home marker sits at the launch point.
    const cell = 0.5;
    this.grid.position.set(-((s.x * WORLD_SCALE) % cell), 0, -((s.z * WORLD_SCALE) % cell));
    this.home.position.set(-s.x * WORLD_SCALE, 0.002, -s.z * WORLD_SCALE);
    this.home.visible = Math.hypot(this.home.position.x, this.home.position.z) < 7.5;

    // Propellers: spin when armed; with reduced motion show the dashed disc instead.
    for (const p of this.props) {
      if (this.reducedMotion) {
        p.disc.visible = s.prop > 0.2;
      } else {
        if (!s.paused) p.spin.rotation.y += p.dir * s.prop * 38 * dt;
        p.disc.visible = s.prop > 0.6;
      }
    }

    this.marker.position.y = y - 0.44;
    // Keep the camera level (gimbal) and drop a plumb line to the ground.
    this.gimbalPivot.rotation.set(-s.roll, 0, s.pitch);
    this.plumb.scale.y = Math.max(0.001, this.drone.position.y - 0.44);
    this.plumb.visible = this.drone.position.y > 0.5;
    this.footprint.scale.setScalar(1 + (y - 0.44) * 0.08);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.drawOverlay(s);
  }

  drawOverlay(s) {
    this.drone.updateMatrixWorld(true);
    const center = this.project(this.drone.getWorldPosition(new THREE.Vector3()));
    const texts = [
      s.armed ? 'ARMED' : 'DISARMED',
      s.gps ? `GPS_LOCK · ${s.sats} SAT` : `NO GPS · ${s.sats} SAT`,
      `MODE: ${s.modeName}${s.returning ? ' · RTH' : ''}`,
      `BATT ${Math.round(s.battery)}%${s.battery < 20 ? ' LOW' : ''}`,
    ];
    this.callouts.forEach((c, i) => {
      const a = this.project(c.anchor.getWorldPosition(new THREE.Vector3()));
      const side = a.x >= center.x ? 1 : -1;
      const ly = Math.max(14, Math.min(this.size.h - 14, a.y + c.dy));
      const ex = a.x + side * 36;
      const lx = Math.max(8, Math.min(this.size.w - 8, ex + side * 46));
      c.line.setAttribute('points', `${a.x},${a.y} ${ex},${ly} ${lx},${ly}`);
      c.dot.setAttribute('cx', a.x);
      c.dot.setAttribute('cy', a.y);
      if (c.el.textContent !== texts[i]) c.el.textContent = texts[i];
      c.el.style.transform = `translate(${side > 0 ? lx + 6 : lx - 6}px, ${ly}px) translate(${side > 0 ? '0' : '-100%'}, -50%)`;
    });
    this.ruler.updateMatrixWorld(true);
    for (const r of this.rulerLabels) {
      const p = this.project(this.ruler.localToWorld(new THREE.Vector3(0.16, r.y, 0)));
      r.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(0, -50%)`;
    }
    const m = this.project(this.ruler.localToWorld(new THREE.Vector3(-0.18, this.marker.position.y, 0)));
    this.altLabel.textContent = `ALT ${s.alt.toFixed(1)} m`;
    this.altLabel.style.transform = `translate(${m.x}px, ${m.y}px) translate(-100%, -50%)`;
  }
}
