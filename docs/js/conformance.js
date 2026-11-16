// conformance.js
// The test vectors of the specification (Section 11), run in the browser.
// Each test returns { id, name, expected, got, pass }.

import { sha256, hmacSha256 } from './sha256.js';
import {
  crc16, computeCrcExtra, MESSAGES, MSG, buildFrame, toHex, fromHex, Receiver, DEMO_KEY,
  writeChecksum, dissect, decodePayload, HEARTBEAT_FIELDS,
} from './protocol.js';

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// Worked examples from Section 10 of the spec.
export const VECTORS = {
  heartbeat: 'fd 09 00 00 00 01 01 00 00 00 00 00 00 00 02 03 81 04 03 9f e6',
  telemetry: 'fd 0d 00 00 01 01 01 10 a4 00 40 e2 01 00 12 2f 00 00 c2 01 57 09 63 23 55',
  signed: 'fd 0d 01 00 02 01 01 10 a4 00 40 e2 01 00 12 2f 00 00 c2 01 57 09 63 95 95 00 00 e1 f5 05 00 00 7c 74 72 59 ab 19',
  ack: 'fd 01 00 00 03 01 01 12 a4 00 01 49 1b',
};
export const TELEMETRY_FIELDS = { time_ms: 123456, altitude_cm: 12050, speed_cms: 450, battery_pct: 87, satellites: 9, status: 0x63 };
export const SIGNED_TS = 100000000;

export function buildVectors() {
  return {
    heartbeat: buildFrame({ msgid: MSG.HEARTBEAT, fields: HEARTBEAT_FIELDS, seq: 0, sysid: 1 }),
    telemetry: buildFrame({ msgid: MSG.DRONE_TELEMETRY, fields: TELEMETRY_FIELDS, seq: 1, sysid: 1 }),
    signed: buildFrame({ msgid: MSG.DRONE_TELEMETRY, fields: TELEMETRY_FIELDS, seq: 2, sysid: 1,
      sign: { key: DEMO_KEY, linkId: 0, timestamp: SIGNED_TS } }),
    ack: buildFrame({ msgid: MSG.DRONE_ACK, fields: { command: 1, result: 0 }, seq: 3, sysid: 1 }),
  };
}

// A receiver whose clock sits just after the example timestamp (year 2015),
// so the vector of 10.3 is fresh for it.
const testReceiver = (opts = {}) => new Receiver({ key: DEMO_KEY, clock: () => SIGNED_TS + 1000, ...opts });

export function runConformance() {
  const v = buildVectors();
  const tests = [];
  const t = (id, name, expected, fn) => {
    let got, pass;
    try { [got, pass] = fn(); } catch (e) { got = 'error: ' + e.message; pass = false; }
    tests.push({ id, name, expected, got, pass });
  };
  const same = (a, b) => toHex(a) === toHex(b);

  t('1', 'CRC-16/MCRF4XX of "123456789"', '0x6F91', () => {
    const c = crc16(ascii('123456789'));
    return ['0x' + c.toString(16).toUpperCase(), c === 0x6f91];
  });
  t('2', 'CRC_EXTRA of HEARTBEAT, from its definition', '50', () => {
    const c = computeCrcExtra(MESSAGES.get(0));
    return [String(c), c === 50];
  });
  t('3', 'CRC_EXTRA of TELEMETRY, COMMAND, ACK', '52, 54, 226', () => {
    const got = [42000, 42001, 42002].map((id) => computeCrcExtra(MESSAGES.get(id)));
    return [got.join(', '), got.join() === '52,54,226'];
  });
  t('4', 'Build HEARTBEAT of 10.1', '21 bytes, exact', () => [toHex(v.heartbeat), same(v.heartbeat, fromHex(VECTORS.heartbeat))]);
  t('5a', 'Build DRONE_TELEMETRY of 10.2', '25 bytes, exact', () => [toHex(v.telemetry), same(v.telemetry, fromHex(VECTORS.telemetry))]);
  t('5b', 'Build signed DRONE_TELEMETRY of 10.3', '38 bytes, exact', () => [toHex(v.signed), same(v.signed, fromHex(VECTORS.signed))]);
  t('5c', 'Build truncated DRONE_ACK of 10.4', '13 bytes, exact', () => [toHex(v.ack), same(v.ack, fromHex(VECTORS.ack))]);
  t('6', 'Parse each frame back to its fields', 'original values', () => {
    const tl = decodePayload(42000, v.signed.subarray(10, 23));
    const ack = decodePayload(42002, v.ack.subarray(10, 11));
    const ok = Object.keys(TELEMETRY_FIELDS).every((k) => tl[k] === TELEMETRY_FIELDS[k]) && ack.command === 1 && ack.result === 0
      && dissect(v.heartbeat).find((x) => x.key === 'payload').sub.find((s) => s.name === 'base_mode').value === 0x81;
    return [`alt ${tl.altitude_cm} cm, ack cmd ${ack.command}`, ok];
  });
  t('7', 'Flip one payload bit of 10.2', 'rejected, R5', () => {
    // 10.2 is unsigned, so a strict receiver would stop it at R2 before the
    // checksum. This row isolates the checksum: signature not required.
    const f = v.telemetry.slice(); f[15] ^= 0x04;
    const r = testReceiver({ requireSignature: false }).process(f);
    const strict = v.signed.slice(); strict[15] ^= 0x04;
    const r2 = testReceiver().process(strict);
    return [`${r.code ?? 'accepted'}; signed copy ${r2.code ?? 'accepted'}`, r.code === 'R5' && r2.code === 'R5'];
  });
  t('8', 'Change a payload byte of 10.3, recompute CRC', 'rejected, R6', () => {
    const f = v.signed.slice(); f[20] = 99; writeChecksum(f);
    const r = testReceiver().process(f);
    return [r.code ?? 'accepted', r.code === 'R6'];
  });
  t('9', 'Send the frame of 10.3 twice', '1st accepted, 2nd R7', () => {
    const rx = testReceiver();
    const a = rx.process(v.signed), b = rx.process(v.signed);
    return [`${a.ok ? 'accepted' : a.code}, ${b.code ?? 'accepted'}`, a.ok && b.code === 'R7'];
  });
  t('10', 'INCOMPAT_FLAGS = 0x02', 'rejected, R2', () => {
    const f = v.signed.slice(); f[2] = 0x02;
    const r = testReceiver().process(f);
    return [r.code ?? 'accepted', r.code === 'R2'];
  });
  t('11', 'A 5-byte datagram', 'rejected, R1', () => {
    const r = testReceiver().process(v.signed.slice(0, 5));
    return [r.code ?? 'accepted', r.code === 'R1'];
  });
  t('12', 'LEN does not match the size', 'rejected, R3', () => {
    const f = new Uint8Array(v.signed.length + 1); f.set(v.signed);
    const r = testReceiver().process(f);
    return [r.code ?? 'accepted', r.code === 'R3'];
  });
  t('13', 'Frames with SEQ 0, 1, 4', 'all accepted, 2 lost', () => {
    const rx = testReceiver();
    const res = [0, 1, 4].map((seq, i) => rx.process(buildFrame({ msgid: 42000, fields: TELEMETRY_FIELDS, seq, sysid: 1,
      sign: { key: DEMO_KEY, linkId: 0, timestamp: SIGNED_TS + i + 1 } })));
    const lost = rx.lostFor(1);
    return [`${res.filter((r) => r.ok).length}/3 accepted, ${lost} lost`, res.every((r) => r.ok) && lost === 2];
  });
  t('S1', 'SHA-256("abc"), FIPS 180-4', 'ba7816bf…15ad', () => {
    const h = toHex(sha256(ascii('abc')), '');
    return [h.slice(0, 8) + '…' + h.slice(-4), h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'];
  });
  t('S2', 'HMAC-SHA256, RFC 4231 case 2', '5bdcc146…3843', () => {
    const h = toHex(hmacSha256(ascii('Jefe'), ascii('what do ya want for nothing?')), '');
    return [h.slice(0, 8) + '…' + h.slice(-4), h === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'];
  });
  return tests;
}
