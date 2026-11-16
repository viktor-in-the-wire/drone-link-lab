// sim.js
// The simulated world: a drone, a ground station, the radio link between
// them, and an attacker who can listen to and inject into that link.
//
// The drone and the ground station never share JavaScript objects; they only
// exchange Uint8Array frames built and checked by protocol.js. Everything the
// ground station "knows" about the drone comes from frames it accepted.

import {
  Sender, Receiver, DEMO_KEY, MSG, CMD, CMD_NAMES, MODES, STATUS, HEARTBEAT_FIELDS,
  MESSAGES, readMsgId, payloadLayout, writeChecksum, SYSID_DRONE, SYSID_GCS, ACK_RESULTS,
} from './protocol.js';

export const LATENCY = 0.9;             // seconds a frame takes to cross the (visual) link
const TELEMETRY_PERIOD = 0.2;           // 5 Hz
const HEARTBEAT_PERIOD = 1.0;           // 1 Hz
const COMMAND_TIMEOUT = 2.5;            // resend a command if no DRONE_ACK arrives
const HOME_SAFE_ALT = 15;               // RTH climbs to at least this altitude (m)
const AUTO_ALT = 20, AUTO_RADIUS = 25;  // AUTO mode flies a circle around home

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Simulation {
  constructor() {
    this.listeners = {};
    this.defences = { requireSignature: true, checkTimestamp: true };
    this.linkQuality = 0;   // % of radio frames that are dropped or corrupted
    this.reset();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((fn) => fn(data)); }
  log(text, level = 'info', important = false) { this.emit('log', { t: this.t, text, level, important }); }

  reset() {
    this.t = 0;
    this.nextId = 1;
    // True physical state of the drone (drawn by the 3D view).
    this.drone = {
      x: 0, z: 0, alt: 0, vx: 0, vz: 0, vAlt: 0, yaw: 0, pitch: 0, roll: 0, prop: 0,
      armed: true, mode: 2, battery: 100, sats: 3, satTarget: 9 + Math.floor(Math.random() * 4),
      returning: false, landing: false, failsafe: false, takeoff: 12, timeMs: 0, nextSat: 0.6,
    };
    this.input = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };

    // Each side owns a sender (SEQ + monotonic timestamp) and a receiver (R1..R7).
    this.droneTx = new Sender({ sysid: SYSID_DRONE, key: DEMO_KEY });
    this.gcsTx = new Sender({ sysid: SYSID_GCS, key: DEMO_KEY });
    this.gcsRx = new Receiver({ key: DEMO_KEY, ...this.defences });
    this.droneRx = new Receiver({ key: DEMO_KEY });

    this.frames = [];       // frames on the link (for drawing)
    this.captured = [];     // what the eavesdropper has recorded
    this.intercept = null;  // 'noise' | 'tamper': modify the next telemetry frame
    this.gcs = { tlm: null, spoof: null, pending: null, rthRequested: false, tlmCount: 0 };
    this.stats = { sent: 0, accepted: 0, rejected: 0, dropped: 0, codes: { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0 } };
    this.history = [];      // ground-station view of altitude and battery over time
    this.timers = { tlm: 0, hb: 0.5 };
    this.emit('reset');
    this.log('link up: drone SYSID 1 ⇄ ground station SYSID 255, signing key loaded', 'info', true);
  }

  setDefence(name, on) {
    this.defences[name] = on;
    this.gcsRx[name] = on;
    this.log(`defence "${name === 'requireSignature' ? 'require signature' : 'check timestamp'}" ${on ? 'ON' : 'OFF'}`, on ? 'ok' : 'warn', true);
  }

  get lost() { return this.gcsRx.lostFor(SYSID_DRONE); }

  /* -------------------------------------------------------------- */
  /* Link                                                            */
  /* -------------------------------------------------------------- */

  transmit(bytes, from, to, kind = 'normal', note = '') {
    const fromAttacker = from === 'attacker';
    const fr = {
      id: this.nextId++, bytes, from, to, kind, note,
      name: MESSAGES.get(readMsgId(bytes))?.name ?? 'UNKNOWN',
      sentAt: this.t, start: fromAttacker ? 0.5 : 0,
      arriveAt: this.t + (fromAttacker ? LATENCY * 0.5 : LATENCY),
      dropped: false, result: null,
    };
    // Link quality: a share of radio frames is lost or damaged in transit.
    if (!fromAttacker && this.linkQuality > 0 && Math.random() * 100 < this.linkQuality) {
      if (Math.random() < 0.5) {
        fr.dropped = true;
        fr.dropAt = this.t + LATENCY * (0.3 + Math.random() * 0.4);
        this.stats.dropped++;
      } else {
        const bit = Math.floor(Math.random() * bytes.length * 8);
        bytes[bit >> 3] ^= 1 << (bit & 7);
        fr.kind = 'corrupt';
        fr.note = `bit ${bit} flipped by interference`;
      }
    }
    this.stats.sent++;
    this.frames.push(fr);
    this.emit('sent', fr);
    return fr;
  }

  /* -------------------------------------------------------------- */
  /* Drone side                                                      */
  /* -------------------------------------------------------------- */

  statusByte() {
    const d = this.drone;
    let s = d.mode << 5;
    if (d.armed) s |= STATUS.ARMED;
    if (d.sats >= 6) s |= STATUS.GPS_LOCK;
    if (d.battery < 20) s |= STATUS.LOW_BATTERY;
    if (d.returning) s |= STATUS.RETURNING;
    if (d.failsafe) s |= STATUS.FAILSAFE;
    return s;
  }

  telemetryFields() {
    const d = this.drone;
    return {
      time_ms: Math.floor(d.timeMs) >>> 0,
      altitude_cm: Math.round(d.alt * 100),
      speed_cms: Math.round(Math.hypot(d.vx, d.vz) * 100),
      battery_pct: Math.max(0, Math.round(d.battery)),
      satellites: d.sats,
      status: this.statusByte(),
    };
  }

  sendTelemetry() {
    const fields = this.telemetryFields();
    const bytes = this.droneTx.build(MSG.DRONE_TELEMETRY, fields);
    // The eavesdropper records every frame it hears.
    this.captured.push({ t: this.t, bytes: bytes.slice(), fields });
    while (this.captured.length && this.t - this.captured[0].t > 55) this.captured.shift();

    let kind = 'normal', note = '';
    if (this.intercept === 'noise') {
      // Flip one bit inside the payload or checksum: only the CRC can notice.
      const len = bytes[1];
      const bit = (10 * 8) + Math.floor(Math.random() * (len + 2) * 8);
      bytes[bit >> 3] ^= 1 << (bit & 7);
      kind = 'noise'; note = `bit ${bit} (byte ${bit >> 3}) flipped`;
    } else if (this.intercept === 'tamper') {
      // Man in the middle: raise the altitude by 300 m, then fix up the CRC.
      // The CRC is public arithmetic, so this is easy. The HMAC is not.
      const alt = payloadLayout(MSG.DRONE_TELEMETRY).find((f) => f.name === 'altitude_cm');
      const dv = new DataView(bytes.buffer, bytes.byteOffset + 10 + alt.offset, 4);
      const forged = dv.getInt32(0, true) + 30000;
      dv.setInt32(0, forged, true);
      writeChecksum(bytes);
      kind = 'tamper'; note = `altitude_cm → ${forged}, CRC recomputed`;
    }
    if (kind !== 'normal') this.log(`attacker: ${kind === 'noise' ? 'injected noise' : 'tampered with'} DRONE_TELEMETRY seq ${bytes[4]} (${note})`, 'attack', true);
    this.intercept = null;
    this.transmit(bytes, 'drone', 'gcs', kind, note);
  }

  sendHeartbeat() {
    this.transmit(this.droneTx.build(MSG.HEARTBEAT, HEARTBEAT_FIELDS), 'drone', 'gcs');
  }

  /** The drone acts on a verified command and answers with DRONE_ACK. */
  applyCommand(command, param) {
    const d = this.drone;
    switch (command) {
      case CMD.RETURN_HOME:
        if (!d.armed || d.alt < 0.1) return 1;
        d.returning = true; d.landing = false; return 0;
      case CMD.LAND:
        if (!d.armed || d.alt < 0.1) return 1;
        d.landing = true; return 0;
      case CMD.SET_MODE:
        if (!MODES[param]) return 2;
        d.mode = param; d.returning = false; d.landing = false;
        if (param === 3 && d.armed && d.alt < 0.1) d.takeoff = AUTO_ALT;
        return 0;
      default: return 2;
    }
  }

  /* -------------------------------------------------------------- */
  /* Ground-station side                                             */
  /* -------------------------------------------------------------- */

  sendCommand(command, param = 0, isRetry = false) {
    const bytes = this.gcsTx.build(MSG.DRONE_COMMAND, { param, command, target_system: SYSID_DRONE });
    const tries = isRetry ? this.gcs.pending.tries + 1 : 1;
    this.gcs.pending = { command, param, tries, sentAt: this.t };
    const label = command === CMD.SET_MODE ? `SET_MODE ${MODES[param]}` : CMD_NAMES[command];
    this.log(`ground → drone: DRONE_COMMAND ${label}${isRetry ? ` (retry ${tries - 1})` : ''}`, 'info', true);
    this.transmit(bytes, 'gcs', 'drone');
  }

  setMode(mode) { this.sendCommand(CMD.SET_MODE, mode); }
  returnHome() { this.sendCommand(CMD.RETURN_HOME); }
  land() { this.sendCommand(CMD.LAND); }

  // ARM / DISARM go over the (simulated) RC channel, not over DLP.
  arm() {
    const d = this.drone;
    if (d.armed) return;
    if (d.battery <= 5) { this.log('ARM refused: battery empty', 'warn', true); return; }
    d.armed = true; d.failsafe = false;
    if (d.mode === 3) d.takeoff = AUTO_ALT;
    this.log('RC: ARM', 'ok', true);
  }
  disarm() {
    const d = this.drone;
    if (!d.armed) return;
    if (d.alt > 0.3) { this.log('RC: DISARM refused while airborne (land first)', 'warn', true); return; }
    d.armed = false; this.log('RC: DISARM', 'info', true);
  }
  toggleArm() { this.drone.armed ? this.disarm() : this.arm(); }

  skipToLowBattery() { this.drone.battery = Math.min(this.drone.battery, 21); this.log('battery set to 21% (demo shortcut)', 'info', true); }

  /* -------------------------------------------------------------- */
  /* Attacks (they only touch this simulated link)                   */
  /* -------------------------------------------------------------- */

  attackNoise() { this.intercept = 'noise'; }
  attackTamper() { this.intercept = 'tamper'; }

  attackForge() {
    // The attacker knows the format and the CRC, but not the key. It signs
    // with a key of its own; the frame is well formed in every other way.
    const last = this.captured[this.captured.length - 1];
    const fields = {
      ...(last?.fields ?? this.telemetryFields()),
      battery_pct: 8,
      status: ((last?.fields.status ?? this.statusByte()) | STATUS.LOW_BATTERY),
    };
    const fake = new Sender({ sysid: SYSID_DRONE, key: crypto.getRandomValues(new Uint8Array(32)) });
    fake.seq = last ? (last.bytes[4] + 1) & 0xff : 0;
    const bytes = fake.build(MSG.DRONE_TELEMETRY, fields);
    this.log('attacker: forged DRONE_TELEMETRY (battery 8%, LOW_BATTERY) with valid CRC, guessed key', 'attack', true);
    this.transmit(bytes, 'attacker', 'gcs', 'forge', 'battery 8%, LOW_BATTERY, signed with a guessed key');
  }

  attackReplay() {
    // Re-send a genuine, correctly signed frame recorded earlier.
    let pick = null;
    for (const c of this.captured) if (this.t - c.t >= 15) pick = c;
    pick ||= this.captured[0];
    if (!pick) { this.log('attacker: nothing captured yet', 'warn', true); return; }
    const age = (this.t - pick.t).toFixed(1);
    const note = `recorded ${age} s ago: alt ${(pick.fields.altitude_cm / 100).toFixed(1)} m, batt ${pick.fields.battery_pct}%`;
    this.log(`attacker: replayed DRONE_TELEMETRY seq ${pick.bytes[4]} (${note})`, 'attack', true);
    this.transmit(pick.bytes.slice(), 'attacker', 'gcs', 'replay', note);
  }

  /* -------------------------------------------------------------- */
  /* Frame delivery                                                  */
  /* -------------------------------------------------------------- */

  deliver(fr) {
    if (fr.to === 'gcs') this.deliverToGcs(fr);
    else this.deliverToDrone(fr);
    fr.processedAt = this.t;
    this.emit('processed', fr);
    if (['noise', 'tamper', 'forge', 'replay'].includes(fr.kind)) this.emit('attack', fr);
  }

  deliverToGcs(fr) {
    const r = this.gcsRx.process(fr.bytes);
    fr.result = r;
    if (!r.ok) {
      this.stats.rejected++;
      this.stats.codes[r.code]++;
      this.log(`${r.code} ${r.reason}: ${fr.name} seq ${fr.bytes[4] ?? '?'} (${r.detail})`, 'reject', true);
      return;
    }
    this.stats.accepted++;
    const spoofed = ['forge', 'tamper', 'replay'].includes(fr.kind);
    if (r.gap) this.log(`SEQ gap: ${r.gap} frame${r.gap > 1 ? 's' : ''} lost before seq ${r.seq}`, 'warn');

    if (r.msgid === MSG.DRONE_TELEMETRY) {
      const f = r.fields;
      this.gcs.tlm = { ...f, at: this.t, spoofed };
      this.history.push({ t: this.t, alt: f.altitude_cm / 100, batt: f.battery_pct, spoofed });
      while (this.history.length && this.t - this.history[0].t > 60) this.history.shift();
      if (spoofed) {
        this.gcs.spoof = { kind: fr.kind, at: this.t, fields: f };
        this.log(`ACCEPTED SPOOFED DRONE_TELEMETRY seq ${r.seq}: ground station now believes alt ${(f.altitude_cm / 100).toFixed(1)} m, batt ${f.battery_pct}%`, 'attack', true);
      } else if (this.gcs.tlmCount++ % 5 === 0) {
        this.log(`accepted DRONE_TELEMETRY seq ${r.seq}`, 'ok');
      }
      // Ground-station policy: LOW_BATTERY → order the drone home (once).
      if (f.status & STATUS.LOW_BATTERY) {
        if (!this.gcs.rthRequested && !(f.status & STATUS.RETURNING)) {
          this.gcs.rthRequested = true;
          this.log(`LOW_BATTERY reported (${f.battery_pct}%): ground station orders RETURN_HOME`, 'warn', true);
          this.sendCommand(CMD.RETURN_HOME);
        }
      } else {
        this.gcs.rthRequested = false;
      }
    } else if (r.msgid === MSG.HEARTBEAT) {
      this.log(`accepted HEARTBEAT seq ${r.seq}`, 'ok');
    } else if (r.msgid === MSG.DRONE_ACK) {
      const p = this.gcs.pending;
      if (p && p.command === r.fields.command) this.gcs.pending = null;
      this.log(`accepted DRONE_ACK ${CMD_NAMES[r.fields.command] ?? r.fields.command}: ${ACK_RESULTS[r.fields.result] ?? r.fields.result}`, r.fields.result ? 'warn' : 'ok', true);
    }
  }

  deliverToDrone(fr) {
    const r = this.droneRx.process(fr.bytes);
    fr.result = r;
    if (!r.ok) {
      this.stats.rejected++;
      this.stats.codes[r.code]++;
      this.log(`drone rejected ${fr.name}: ${r.code} ${r.reason}`, 'reject', true);
      return;
    }
    this.stats.accepted++;
    if (r.msgid === MSG.DRONE_COMMAND && r.fields.target_system === SYSID_DRONE) {
      const result = this.applyCommand(r.fields.command, r.fields.param);
      this.transmit(this.droneTx.build(MSG.DRONE_ACK, { command: r.fields.command, result }), 'drone', 'gcs');
    }
  }

  /* -------------------------------------------------------------- */
  /* Physics                                                         */
  /* -------------------------------------------------------------- */

  physics(dt) {
    const d = this.drone, inp = this.input;
    d.timeMs += dt * 1000;

    // GPS: satellites come into view one by one after start.
    if (d.sats < d.satTarget && this.t > d.nextSat) { d.sats++; d.nextSat = this.t + 0.5 + Math.random() * 0.6; }

    const fwd = { x: Math.cos(d.yaw), z: -Math.sin(d.yaw) };
    const right = { x: Math.sin(d.yaw), z: Math.cos(d.yaw) };
    let wvx = 0, wvz = 0, desUp = 0, faceVelocity = false;

    if (d.armed) {
      if (d.landing) {
        desUp = d.alt > 3 ? -2.2 : -1.0;
      } else if (d.returning) {
        const dist = Math.hypot(d.x, d.z);
        if (d.alt < HOME_SAFE_ALT - 0.5 && dist > 3) desUp = 2;
        else if (dist > 1.2) {
          const sp = Math.min(7, dist * 0.6);
          wvx = (-d.x / dist) * sp; wvz = (-d.z / dist) * sp; faceVelocity = true;
        } else {
          d.landing = true;
          this.log('home reached: landing', 'info', true);
        }
      } else if (d.mode === 3) {
        // AUTO: climb to AUTO_ALT and fly a circle around home.
        desUp = clamp((AUTO_ALT - d.alt) * 0.6, -2, 2);
        if (d.alt > 3) {
          const r = Math.hypot(d.x, d.z) || 0.001;
          const a = Math.atan2(d.z, d.x);
          const radial = clamp((AUTO_RADIUS - r) * 0.3, -4, 4);
          wvx = -Math.sin(a) * 6 + Math.cos(a) * radial;
          wvz = Math.cos(a) * 6 + Math.sin(a) * radial;
          faceVelocity = true;
        }
      } else {
        // MANUAL / STABILIZE / LOITER: stick control.
        const scale = d.mode === 4 ? 5 : 8;
        const desF = inp.pitch * scale, desR = inp.roll * scale;
        wvx = desF * fwd.x + desR * right.x;
        wvz = desF * fwd.z + desR * right.z;
        desUp = inp.throttle * 3;
        if (d.mode === 1 && d.alt > 0.05) desUp -= 0.4;  // MANUAL: no altitude hold
        d.yaw = wrapAngle(d.yaw - inp.yaw * 1.6 * dt);
      }
      if (d.takeoff) {
        if (d.alt < d.takeoff - 0.3) desUp = Math.max(desUp, 2.5);
        else d.takeoff = 0;
      }
    }

    const onGround = d.alt <= 0.01 && desUp <= 0;
    if (onGround || !d.armed) { wvx = 0; wvz = 0; }
    if (!d.armed && d.alt > 0) desUp = -4;

    const k = 1 - Math.exp(-dt * 2.2);
    d.vx += (wvx - d.vx) * k;
    d.vz += (wvz - d.vz) * k;
    d.vAlt += (desUp - d.vAlt) * (1 - Math.exp(-dt * 3));
    d.x += d.vx * dt;
    d.z += d.vz * dt;
    d.alt = clamp(d.alt + d.vAlt * dt, 0, 120);
    if (d.alt === 0 && d.vAlt < 0) d.vAlt = 0;

    if (d.landing && d.alt <= 0.01) {
      d.landing = false; d.returning = false; d.armed = false; d.takeoff = 0;
      d.vx = d.vz = d.vAlt = 0;
      this.log('touchdown: motors disarmed', 'info', true);
    }

    const speed = Math.hypot(d.vx, d.vz);
    if (faceVelocity && speed > 0.5) {
      const target = Math.atan2(-d.vz, d.vx);
      d.yaw = wrapAngle(d.yaw + wrapAngle(target - d.yaw) * (1 - Math.exp(-dt * 2)));
    }

    // Visual attitude: lean into the direction of travel.
    const vF = d.vx * fwd.x + d.vz * fwd.z, vR = d.vx * right.x + d.vz * right.z;
    const ka = 1 - Math.exp(-dt * 4);
    d.pitch += (clamp(vF / 8, -1, 1) * 0.3 - d.pitch) * ka;
    d.roll += (clamp(vR / 8, -1, 1) * 0.3 - d.roll) * ka;
    const propTarget = d.armed ? (d.alt > 0.05 || desUp > 0 ? 1 + Math.max(0, d.vAlt) * 0.1 : 0.4) : 0;
    d.prop += (propTarget - d.prop) * (1 - Math.exp(-dt * 2));

    // Battery: idle drain, more when hovering, moving or climbing.
    if (d.armed) {
      d.battery -= (0.08 + (d.alt > 0.05 ? 0.14 : 0) + 0.03 * speed + 0.1 * Math.max(0, d.vAlt)) * dt;
      d.battery = Math.max(0, d.battery);
      if (d.battery <= 5 && d.alt > 0.05 && !d.failsafe) {
        d.failsafe = true; d.landing = true;
        this.log('FAILSAFE: battery critical, landing now', 'warn', true);
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* Main step                                                       */
  /* -------------------------------------------------------------- */

  step(dt) {
    this.t += dt;
    this.physics(dt);

    this.timers.tlm += dt;
    this.timers.hb += dt;
    if (this.timers.tlm >= TELEMETRY_PERIOD) { this.timers.tlm -= TELEMETRY_PERIOD; this.sendTelemetry(); }
    if (this.timers.hb >= HEARTBEAT_PERIOD) { this.timers.hb -= HEARTBEAT_PERIOD; this.sendHeartbeat(); }

    // Commands are confirmed by DRONE_ACK; resend after a timeout (UDP gives no guarantee).
    const p = this.gcs.pending;
    if (p && this.t - p.sentAt > COMMAND_TIMEOUT) {
      if (p.tries < 3) this.sendCommand(p.command, p.param, true);
      else { this.log(`no DRONE_ACK for ${CMD_NAMES[p.command]} after 3 tries`, 'warn', true); this.gcs.pending = null; }
    }

    for (const fr of this.frames) {
      if (fr.dropped) {
        if (!fr.lost && this.t >= fr.dropAt) { fr.lost = true; this.emit('processed', fr); }
      } else if (!fr.result && this.t >= fr.arriveAt) {
        this.deliver(fr);
      }
    }
    // Keep frames around briefly after arrival so the link view can animate them.
    this.frames = this.frames.filter((fr) => this.t - (fr.dropped ? fr.dropAt : fr.arriveAt) < 1.4);
  }
}
