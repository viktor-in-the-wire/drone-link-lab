// protocol.js
// The Drone Link Protocol (DLP): frame building, parsing, CRC, CRC_EXTRA,
// signing and the receiver pipeline. This is the ONLY place where bytes are
// produced or checked; the simulation, the inspector and the conformance
// panel all go through these functions, so nothing on the page is faked.
//
// Frame (all multi-byte values little-endian):
//
//   0     1     2         3       4     5      6       7..9    10..      n+10..n+11  n+12..n+24
//   STX | LEN | INCOMPAT | COMPAT | SEQ | SYSID | COMPID | MSGID | PAYLOAD | CHECKSUM | SIGNATURE BLOCK
//   0xFD                                                  3 B     LEN B     2 B        13 B (optional)
//
//   unsigned size = 12 + LEN, signed size = 25 + LEN

import { hmacSha256 } from './sha256.js';

export const STX = 0xfd;
export const INCOMPAT_SIGNED = 0x01;      // INCOMPAT_FLAGS bit 0: frame carries a signature block
export const HEADER_LEN = 10;
export const SIGNATURE_BLOCK_LEN = 13;    // LINK_ID (1) + TIMESTAMP (6) + SIGNATURE (6)
export const MIN_FRAME = 12;
export const MAX_FRAME = 280;
export const SYSID_DRONE = 1;
export const SYSID_GCS = 255;
export const COMPID = 1;
export const LINK_ID = 0;
export const UNIX_2015 = 1420070400;      // 2015-01-01 00:00 GMT, the signing epoch
export const STALE_LIMIT = 6_000_000;     // one minute in 10 µs units

// The demo key is PUBLIC (bytes 00 01 02 ... 1f). Never use it for anything real.
export const DEMO_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

export const MSG = { HEARTBEAT: 0, DRONE_TELEMETRY: 42000, DRONE_COMMAND: 42001, DRONE_ACK: 42002 };
export const CMD = { RETURN_HOME: 1, LAND: 2, SET_MODE: 3 };
export const CMD_NAMES = { 1: 'RETURN_HOME', 2: 'LAND', 3: 'SET_MODE' };
export const ACK_RESULTS = { 0: 'accepted', 1: 'rejected', 2: 'unsupported' };
export const MODES = { 1: 'MANUAL', 2: 'STABILIZE', 3: 'AUTO', 4: 'LOITER' };
export const MODE_IDS = { MANUAL: 1, STABILIZE: 2, AUTO: 3, LOITER: 4 };

// Telemetry status byte: bits 0-4 are flags, bits 5-7 hold the flight mode.
export const STATUS = { ARMED: 0x01, GPS_LOCK: 0x02, LOW_BATTERY: 0x04, RETURNING: 0x08, FAILSAFE: 0x10 };
export const statusMode = (s) => (s >> 5) & 0b111;
export const statusFlags = (s) => Object.keys(STATUS).filter((k) => s & STATUS[k]);

/* ------------------------------------------------------------------ */
/* Checksum: CRC-16/MCRF4XX (a.k.a. X.25 in the MAVLink docs)          */
/* init 0xFFFF, poly 0x1021 reflected, no final XOR                    */
/* ------------------------------------------------------------------ */

/** Fold one byte into the running CRC (the MAVLink crc_accumulate step). */
export function crcAccumulate(crc, byte) {
  let tmp = (byte ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

export function crc16(bytes, crc = 0xffff) {
  for (let i = 0; i < bytes.length; i++) crc = crcAccumulate(crc, bytes[i]);
  return crc;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* Fields are listed in WIRE order: largest type first (4, 2, 1 byte), */
/* declared order kept among equal sizes.                              */
/* ------------------------------------------------------------------ */

const TYPE_SIZE = { uint8_t: 1, int8_t: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4 };

export const MESSAGES = new Map();
function define(id, name, crcExtra, fields) {
  const size = fields.reduce((s, [type]) => s + TYPE_SIZE[type], 0);
  MESSAGES.set(id, { id, name, crcExtra, fields, size });
}

define(0, 'HEARTBEAT', 50, [
  ['uint32_t', 'custom_mode'],
  ['uint8_t', 'type'],
  ['uint8_t', 'autopilot'],
  ['uint8_t', 'base_mode'],
  ['uint8_t', 'system_status'],
  ['uint8_t', 'mavlink_version'],
]);
define(42000, 'DRONE_TELEMETRY', 52, [
  ['uint32_t', 'time_ms'],
  ['int32_t', 'altitude_cm'],
  ['uint16_t', 'speed_cms'],
  ['uint8_t', 'battery_pct'],
  ['uint8_t', 'satellites'],
  ['uint8_t', 'status'],
]);
define(42001, 'DRONE_COMMAND', 54, [
  ['uint32_t', 'param'],
  ['uint16_t', 'command'],
  ['uint8_t', 'target_system'],
]);
define(42002, 'DRONE_ACK', 226, [
  ['uint16_t', 'command'],
  ['uint8_t', 'result'],
]);

// HEARTBEAT values used by DLP: quadrotor, ArduPilot, armed + custom mode, active, v3.
export const HEARTBEAT_FIELDS = { custom_mode: 0, type: 2, autopilot: 3, base_mode: 0x81, system_status: 4, mavlink_version: 3 };

/**
 * CRC_EXTRA is derived from the message DEFINITION, so sender and receiver
 * with different field lists produce different checksums:
 *   crc("NAME ") then for each field in wire order: crc("type "), crc("name ")
 *   then fold to 8 bits: (crc & 0xFF) ^ (crc >> 8).
 * (Array fields would also add their length byte; DLP has none.)
 */
export function computeCrcExtra(def) {
  let crc = 0xffff;
  const add = (s) => { for (let i = 0; i < s.length; i++) crc = crcAccumulate(crc, s.charCodeAt(i)); };
  add(def.name + ' ');
  for (const [type, name] of def.fields) { add(type + ' '); add(name + ' '); }
  return ((crc & 0xff) ^ (crc >> 8)) & 0xff;
}

/* ------------------------------------------------------------------ */
/* Payload encoding                                                    */
/* ------------------------------------------------------------------ */

/** Encode the full (untruncated) payload, little-endian, in wire order. */
export function encodePayload(msgid, values) {
  const def = MESSAGES.get(msgid);
  const buf = new Uint8Array(def.size);
  const dv = new DataView(buf.buffer);
  let o = 0;
  for (const [type, name] of def.fields) {
    const v = values[name] ?? 0;
    switch (type) {
      case 'uint8_t': dv.setUint8(o, v); break;
      case 'int8_t': dv.setInt8(o, v); break;
      case 'uint16_t': dv.setUint16(o, v, true); break;
      case 'int16_t': dv.setInt16(o, v, true); break;
      case 'uint32_t': dv.setUint32(o, v >>> 0, true); break;
      case 'int32_t': dv.setInt32(o, v | 0, true); break;
    }
    o += TYPE_SIZE[type];
  }
  return buf;
}

/** Remove trailing zero bytes; the first byte is never removed. */
export function truncatePayload(p) {
  let n = p.length;
  while (n > 1 && p[n - 1] === 0) n--;
  return p.slice(0, n);
}

/** Pad a received payload with zeros to the full size, then decode it. */
export function decodePayload(msgid, bytes) {
  const def = MESSAGES.get(msgid);
  const buf = new Uint8Array(def.size);
  buf.set(bytes.subarray(0, def.size));
  const dv = new DataView(buf.buffer);
  const out = {};
  let o = 0;
  for (const [type, name] of def.fields) {
    switch (type) {
      case 'uint8_t': out[name] = dv.getUint8(o); break;
      case 'int8_t': out[name] = dv.getInt8(o); break;
      case 'uint16_t': out[name] = dv.getUint16(o, true); break;
      case 'int16_t': out[name] = dv.getInt16(o, true); break;
      case 'uint32_t': out[name] = dv.getUint32(o, true); break;
      case 'int32_t': out[name] = dv.getInt32(o, true); break;
    }
    o += TYPE_SIZE[type];
  }
  return out;
}

/** Wire offsets of each payload field (used by the inspector and the attacks). */
export function payloadLayout(msgid) {
  const def = MESSAGES.get(msgid);
  let o = 0;
  return def.fields.map(([type, name]) => { const f = { type, name, offset: o, size: TYPE_SIZE[type] }; o += f.size; return f; });
}

/* ------------------------------------------------------------------ */
/* Small byte helpers                                                  */
/* ------------------------------------------------------------------ */

export const readMsgId = (f) => f[7] | (f[8] << 8) | (f[9] << 16);

// 48-bit little-endian integers. JS numbers hold up to 2^53 exactly, so plain
// arithmetic is fine (bit operators would truncate to 32 bits).
export function writeU48(buf, offset, value) {
  for (let i = 0; i < 6; i++) { buf[offset + i] = value % 256; value = Math.floor(value / 256); }
}
export function readU48(buf, offset) {
  let v = 0;
  for (let i = 5; i >= 0; i--) v = v * 256 + buf[offset + i];
  return v;
}

export const toHex = (bytes, sep = ' ') => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(sep);
export const fromHex = (s) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));
export const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

/** Current time as a DLP timestamp: 10 µs units since 2015-01-01 00:00 GMT. */
export function nowTimestamp(unixMs = Date.now()) {
  return Math.floor((unixMs / 1000 - UNIX_2015) * 100000);
}

/* ------------------------------------------------------------------ */
/* Checksum and signature over a frame                                 */
/* ------------------------------------------------------------------ */

/**
 * Checksum coverage: every byte from LEN to the end of the payload
 * (STX is NOT covered), followed by CRC_EXTRA, which is never sent.
 */
export function computeChecksum(frame, crcExtra = MESSAGES.get(readMsgId(frame))?.crcExtra ?? 0) {
  const len = frame[1];
  const crc = crc16(frame.subarray(1, HEADER_LEN + len));
  return crcAccumulate(crc, crcExtra);
}

/** Write the checksum into the frame, low byte first. */
export function writeChecksum(frame) {
  const c = computeChecksum(frame);
  const o = HEADER_LEN + frame[1];
  frame[o] = c & 0xff;
  frame[o + 1] = c >> 8;
  return c;
}

/**
 * SIGNATURE = first 6 bytes of HMAC-SHA256(key, FRAME || LINK_ID || TIMESTAMP)
 * FRAME is STX ... end of CHECKSUM (12 + LEN bytes).
 */
export function computeSignature(frame, key, linkId, timestamp) {
  const n = 12 + frame[1];
  const data = new Uint8Array(n + 7);
  data.set(frame.subarray(0, n));
  data[n] = linkId;
  writeU48(data, n + 1, timestamp);
  return hmacSha256(key, data).subarray(0, 6);
}

/** Fill in the 13-byte signature block of an already checksummed frame. */
export function signFrame(frame, key, linkId, timestamp) {
  const n = 12 + frame[1];
  frame[n] = linkId;
  writeU48(frame, n + 1, timestamp);
  frame.set(computeSignature(frame, key, linkId, timestamp), n + 7);
}

/** Compare two byte arrays in constant time (no early exit). */
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Building a frame                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build a complete frame.
 * @param {object} o
 * @param {number} o.msgid
 * @param {object} o.fields   payload values by field name
 * @param {number} o.seq      0-255
 * @param {number} o.sysid
 * @param {number} [o.compid=1]
 * @param {{key:Uint8Array, linkId:number, timestamp:number}|null} [o.sign]
 */
export function buildFrame({ msgid, fields, seq, sysid, compid = COMPID, sign = null }) {
  const payload = truncatePayload(encodePayload(msgid, fields));
  const len = payload.length;
  const frame = new Uint8Array(12 + len + (sign ? SIGNATURE_BLOCK_LEN : 0));
  frame[0] = STX;
  frame[1] = len;
  frame[2] = sign ? INCOMPAT_SIGNED : 0x00;   // the signed flag is itself covered by CRC and HMAC
  frame[3] = 0x00;                            // COMPAT_FLAGS
  frame[4] = seq & 0xff;
  frame[5] = sysid;
  frame[6] = compid;
  frame[7] = msgid & 0xff;                    // MSGID, 24 bits, low byte first
  frame[8] = (msgid >> 8) & 0xff;
  frame[9] = (msgid >> 16) & 0xff;
  frame.set(payload, HEADER_LEN);
  writeChecksum(frame);
  if (sign) signFrame(frame, sign.key, sign.linkId, sign.timestamp);
  return frame;
}

/**
 * A sender keeps its own SEQ counter (wraps at 255) and makes every
 * timestamp at least 1 larger than the previous one in the stream.
 */
export class Sender {
  constructor({ sysid, compid = COMPID, key, linkId = LINK_ID, clock = nowTimestamp }) {
    Object.assign(this, { sysid, compid, key, linkId, clock });
    this.seq = 0;
    this.lastTs = 0;
  }
  build(msgid, fields) {
    const timestamp = Math.max(this.clock(), this.lastTs + 1);
    this.lastTs = timestamp;
    const frame = buildFrame({
      msgid, fields, seq: this.seq, sysid: this.sysid, compid: this.compid,
      sign: { key: this.key, linkId: this.linkId, timestamp },
    });
    this.seq = (this.seq + 1) & 0xff;
    return frame;
  }
}

/* ------------------------------------------------------------------ */
/* Dissecting a frame for display (lenient, never trusted)             */
/* ------------------------------------------------------------------ */

/**
 * Split raw bytes into labelled fields for the inspector. This does NOT
 * validate anything; it just shows what is on the wire, even for damaged
 * frames. Groups: header, payload, checksum, signature.
 */
export function dissect(f) {
  const out = [];
  const at = (i) => (i < f.length ? f[i] : undefined);
  const push = (key, label, group, start, size, value) => {
    const bytes = f.subarray(Math.min(start, f.length), Math.min(start + size, f.length));
    out.push({ key, label, group, start, size, bytes, value });
  };
  push('stx', 'STX', 'header', 0, 1, at(0) === STX ? '0xFD' : hex2(at(0) ?? 0));
  push('len', 'LEN', 'header', 1, 1, String(at(1) ?? '-'));
  push('incompat', 'INCOMPAT', 'header', 2, 1, at(2) === 1 ? 'signed' : hex2(at(2) ?? 0));
  push('compat', 'COMPAT', 'header', 3, 1, hex2(at(3) ?? 0));
  push('seq', 'SEQ', 'header', 4, 1, String(at(4) ?? '-'));
  push('sysid', 'SYSID', 'header', 5, 1, at(5) === 1 ? '1 drone' : at(5) === 255 ? '255 gcs' : String(at(5) ?? '-'));
  push('compid', 'COMPID', 'header', 6, 1, String(at(6) ?? '-'));
  const msgid = f.length >= 10 ? readMsgId(f) : -1;
  const def = MESSAGES.get(msgid);
  push('msgid', 'MSGID', 'header', 7, 3, def ? `${msgid} ${def.name}` : String(msgid));
  const len = at(1) ?? 0;
  const payloadEnd = Math.min(HEADER_LEN + len, f.length);
  const payload = f.subarray(Math.min(HEADER_LEN, f.length), payloadEnd);
  const sub = [];
  if (def) {
    const decoded = decodePayload(msgid, payload);
    for (const fld of payloadLayout(msgid)) {
      sub.push({ name: fld.name, type: fld.type, offset: fld.offset, size: fld.size,
        bytes: payload.subarray(Math.min(fld.offset, payload.length), Math.min(fld.offset + fld.size, payload.length)),
        value: decoded[fld.name], truncated: fld.offset + fld.size > payload.length });
    }
  }
  out.push({ key: 'payload', label: 'PAYLOAD', group: 'payload', start: HEADER_LEN, size: len, bytes: payload, value: `${len} B`, sub, def });
  const cs = HEADER_LEN + len;
  push('checksum', 'CHECKSUM', 'checksum', cs, 2, f.length >= cs + 2 ? hex4(f[cs] | (f[cs + 1] << 8)) : '-');
  if (at(2) & INCOMPAT_SIGNED && f.length >= cs + 2 + SIGNATURE_BLOCK_LEN) {
    const s = cs + 2;
    push('link', 'LINK_ID', 'signature', s, 1, String(f[s]));
    push('ts', 'TIMESTAMP', 'signature', s + 1, 6, String(readU48(f, s + 1)));
    push('sig', 'SIGNATURE', 'signature', s + 7, 6, 'HMAC[0:6]');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Receiver pipeline                                                   */
/* ------------------------------------------------------------------ */

export const CHECKS = [
  { id: 'size', code: 'R1', label: 'Size and start byte', rule: '12 ≤ size ≤ 280, byte 0 = 0xFD' },
  { id: 'flags', code: 'R2', label: 'Flags', rule: 'INCOMPAT_FLAGS = 0x01' },
  { id: 'length', code: 'R3', label: 'Length', rule: 'size = 25 + LEN' },
  { id: 'msgid', code: 'R4', label: 'Message id', rule: 'MSGID is known' },
  { id: 'checksum', code: 'R5', label: 'Checksum', rule: 'CRC-16 with CRC_EXTRA' },
  { id: 'signature', code: 'R6', label: 'Signature', rule: 'HMAC-SHA256, constant time' },
  { id: 'timestamp', code: 'R7', label: 'Timestamp', rule: 'newer than stored, < 1 min old' },
];

export const REASONS = {
  R1: 'malformed', R2: 'unsupported flag or unsigned', R3: 'wrong length', R4: 'unknown message',
  R5: 'bad checksum', R6: 'bad signature', R7: 'replay or stale',
};

/**
 * The receiver applies R1..R7 in order. Cheap structural checks come first;
 * NO state changes until the signature has been verified.
 *
 * requireSignature / checkTimestamp exist only so the red-team panel can
 * switch a defence off and show what gets through. With both on (the default)
 * this is exactly the receiver of the specification.
 */
export class Receiver {
  constructor({ key, clock = nowTimestamp, requireSignature = true, checkTimestamp = true } = {}) {
    Object.assign(this, { key, clock, requireSignature, checkTimestamp });
    this.reset();
  }

  reset() {
    this.streams = new Map();   // "sysid:compid:link" -> newest accepted timestamp
    this.seqs = new Map();      // "sysid:compid" -> { last, lost }
  }

  lostFor(sysid, compid = COMPID) { return this.seqs.get(`${sysid}:${compid}`)?.lost ?? 0; }

  process(f) {
    const steps = CHECKS.map((c) => ({ ...c, status: 'idle', detail: '' }));
    let i = 0;
    const pass = (detail) => { steps[i].status = 'pass'; steps[i].detail = detail; i++; };
    const skip = (detail) => { steps[i].status = 'skip'; steps[i].detail = detail; i++; };
    const fail = (detail) => {
      steps[i].status = 'fail'; steps[i].detail = detail;
      const code = steps[i].code;
      return { ok: false, code, reason: REASONS[code], detail, steps };
    };

    // R1: size and start byte.
    if (f.length < MIN_FRAME || f.length > MAX_FRAME || f[0] !== STX) {
      return fail(`${f.length} B, first byte ${f.length ? hex2(f[0]) : 'none'}`);
    }
    pass(`${f.length} B, starts 0xFD`);

    // R2: INCOMPAT_FLAGS. Only "signed" is defined; unsigned frames are not allowed in DLP.
    const flags = f[2];
    const signed = (flags & INCOMPAT_SIGNED) !== 0;
    if (flags & ~INCOMPAT_SIGNED) return fail(`unknown flag ${hex2(flags)}`);
    if (!signed && this.requireSignature) return fail('0x00: unsigned frame');
    pass(signed ? '0x01 signed' : '0x00 unsigned, allowed (defence off)');

    // R3: the datagram size must agree with LEN.
    const len = f[1];
    const expected = (signed ? 25 : 12) + len;
    if (f.length !== expected) return fail(`${f.length} B, expected ${signed ? 25 : 12} + ${len} = ${expected}`);
    pass(`${f.length} = ${signed ? 25 : 12} + ${len}`);

    // R4: message id must be known (we need its CRC_EXTRA and layout).
    const msgid = readMsgId(f);
    const def = MESSAGES.get(msgid);
    if (!def) return fail(`MSGID ${msgid} unknown`);
    pass(`${msgid} ${def.name}`);

    // R5: checksum, seeded with this message's CRC_EXTRA.
    const crc = computeChecksum(f, def.crcExtra);
    const got = f[HEADER_LEN + len] | (f[HEADER_LEN + len + 1] << 8);
    if (crc !== got) return fail(`got ${hex4(got)}, computed ${hex4(crc)}`);
    pass(`${hex4(crc)} (CRC_EXTRA ${def.crcExtra})`);

    // R6: signature. Recompute the HMAC and compare in constant time.
    const sb = HEADER_LEN + len + 2;
    const linkId = signed ? f[sb] : 0;
    const ts = signed ? readU48(f, sb + 1) : null;
    if (!this.requireSignature) {
      skip('not checked (defence off)');
    } else {
      const expect = computeSignature(f, this.key, linkId, ts);
      if (!constantTimeEqual(expect, f.subarray(sb + 7, sb + 13))) {
        return fail(`received ${toHex(f.subarray(sb + 7, sb + 13), '')}, expected ${toHex(expect, '')}`);
      }
      pass(`${toHex(expect, '')} matches`);
    }

    // R7: timestamp must be newer than the stored one for this stream,
    // and not more than one minute older than our clock.
    const sysid = f[5], compid = f[6];
    const streamKey = `${sysid}:${compid}:${linkId}`;
    const stored = this.streams.get(streamKey);
    if (ts === null) {
      skip('unsigned, no timestamp');
    } else if (!this.checkTimestamp) {
      skip('not checked (defence off)');
    } else {
      const now = this.clock();
      if (stored !== undefined && ts <= stored) return fail(`${ts} ≤ stored ${stored}`);
      if (now - ts > STALE_LIMIT) return fail(`${((now - ts) / 100000).toFixed(1)} s older than clock`);
      pass(stored === undefined ? 'first in stream' : `+${ts - stored} after stored`);
    }

    // Accepted. Only now does receiver state change: timestamp, SEQ, lost count.
    if (ts !== null) this.streams.set(streamKey, Math.max(stored ?? 0, ts));
    const seqKey = `${sysid}:${compid}`;
    const s = this.seqs.get(seqKey);
    const seq = f[4];
    let gap = 0;
    if (s) {
      gap = (seq - ((s.last + 1) & 0xff)) & 0xff;   // frames missed; a gap is not an error
      s.lost += gap;
      s.last = seq;
    } else {
      this.seqs.set(seqKey, { last: seq, lost: 0 });
    }

    const fields = decodePayload(msgid, f.subarray(HEADER_LEN, HEADER_LEN + len));
    return { ok: true, code: null, steps, msgid, name: def.name, fields, sysid, compid, seq, gap, timestamp: ts };
  }
}
