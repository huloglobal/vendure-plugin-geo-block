import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPublicIp, LocalCountryDb, MmdbReader } from './mmdb';
import { parseIp } from './geo-regions';

// ── A tiny MaxMind DB writer, enough to build fixtures ────────────────────
function ctrl(type: number, size: number): number[] {
    const out: number[] = [];
    const head = type <= 7 ? type << 5 : 0;
    let sizeBits: number; const extra: number[] = [];
    if (size < 29) sizeBits = size;
    else if (size < 285) { sizeBits = 29; extra.push(size - 29); }
    else { sizeBits = 30; const v = size - 285; extra.push(v >> 8, v & 0xff); }
    out.push(head | sizeBits);
    if (type > 7) out.push(type - 7);
    return out.concat(extra);
}
function enc(v: any): number[] {
    if (typeof v === 'string') { const b = Array.from(Buffer.from(v, 'utf8')); return [...ctrl(2, b.length), ...b]; }
    if (typeof v === 'boolean') return ctrl(14, v ? 1 : 0);
    if (typeof v === 'number') {
        const bytes: number[] = []; let n = v;
        while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
        return [...ctrl(v > 0xffffffff ? 9 : 6, bytes.length), ...bytes];
    }
    if (Array.isArray(v)) return [...ctrl(11, v.length), ...v.flatMap(enc)];
    const keys = Object.keys(v);
    return [...ctrl(7, keys.length), ...keys.flatMap(k => [...enc(k), ...enc(v[k])])];
}
type Slot = { node: number } | { data: number } | null;
function buildDb(ipVersion: 4 | 6, networks: Array<[string, number, any]>): Buffer {
    const nodes: Array<[Slot, Slot]> = [[null, null]];
    const data: number[] = [];
    for (const [ip, prefix, value] of networks) {
        let bytes = parseIp(ip)!;
        let bits = prefix;
        if (ipVersion === 6 && bytes.length === 4) { const b = new Uint8Array(16); b.set(bytes, 12); bytes = b; bits += 96; }
        const offset = data.length; data.push(...enc(value));
        let node = 0;
        for (let i = 0; i < bits; i++) {
            const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
            if (i === bits - 1) { nodes[node][bit] = { data: offset }; break; }
            let next = nodes[node][bit];
            if (!next || !('node' in next)) { nodes.push([null, null]); next = { node: nodes.length - 1 }; nodes[node][bit] = next; }
            node = (next as any).node;
        }
    }
    const n = nodes.length;
    const rec = (s: Slot) => (!s ? n : 'node' in s ? s.node : n + 16 + s.data);
    const tree: number[] = [];
    for (const [l, r] of nodes) for (const v of [rec(l), rec(r)]) tree.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    const meta = enc({ node_count: n, record_size: 24, ip_version: ipVersion, database_type: 'Test-Country', build_epoch: 1_700_000_000, binary_format_major_version: 2 });
    return Buffer.from([...tree, ...new Array(16).fill(0), ...data, 0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com'), ...meta]);
}

describe('MmdbReader', () => {
    const v6 = buildDb(6, [
        ['81.2.69.0', 24, { country: { iso_code: 'GB' }, subdivisions: [{ iso_code: 'ENG' }] }],
        ['2a02:c7f::', 32, { country: { iso_code: 'GB' } }],
        ['8.8.8.0', 24, { registered_country: { iso_code: 'US' } }],
    ]);
    it('reads metadata and resolves IPv4 inside an IPv6 tree', () => {
        const r = new MmdbReader(v6);
        expect(r.metadata.ipVersion).toBe(6);
        expect(r.metadata.databaseType).toBe('Test-Country');
        expect(r.country('81.2.69.142')).toEqual({ country: 'GB', region: 'ENG' });
        expect(r.country('::ffff:81.2.69.1')).toEqual({ country: 'GB', region: 'ENG' });
        expect(r.country('8.8.8.8')).toEqual({ country: 'US', region: null });
        expect(r.country('81.2.70.1')).toBeNull();
    });
    it('resolves IPv6 networks', () => {
        const r = new MmdbReader(v6);
        expect(r.country('2a02:c7f:1234::1')?.country).toBe('GB');
        expect(r.country('2a03::1')).toBeNull();
    });
    it('handles an IPv4-only database', () => {
        const r = new MmdbReader(buildDb(4, [['5.6.7.0', 24, { country: { iso_code: 'FR' } }]]));
        expect(r.country('5.6.7.8')?.country).toBe('FR');
        expect(r.country('2a02:c7f::1')).toBeNull();
    });
    it('refuses a file that is not an MMDB', () => {
        expect(() => new MmdbReader(Buffer.from('hello world'))).toThrow(/marker/);
    });
});

describe('LocalCountryDb', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mmdb-'));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    it('answers from the local file and never for private addresses', () => {
        const file = path.join(dir, 'test.mmdb');
        fs.writeFileSync(file, buildDb(6, [['81.2.69.0', 24, { country: { iso_code: 'GB' } }], ['10.0.0.0', 8, { country: { iso_code: 'US' } }]]));
        const db = new LocalCountryDb(file);
        expect(db.lookup('81.2.69.142')?.country).toBe('GB');
        expect(db.lookup('10.1.2.3')).toBeNull();
        const st = db.status();
        expect(st.loaded).toBe(true);
        expect(st.file).toBe('test.mmdb');
        expect(st.builtAt).toMatch(/^2023-/);
    });
    it('fails open on a missing or corrupt file', () => {
        const missing = new LocalCountryDb(path.join(dir, 'nope.mmdb'));
        expect(missing.lookup('81.2.69.142')).toBeNull();
        expect(missing.status().loaded).toBe(false);
        expect(missing.status().error).toBe('ENOENT');
        const bad = path.join(dir, 'bad.mmdb');
        fs.writeFileSync(bad, 'garbage');
        expect(new LocalCountryDb(bad).lookup('81.2.69.142')).toBeNull();
    });
    it('isPublicIp', () => {
        for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '2001:db8::1', '203.0.113.9']) expect(isPublicIp(ip), ip).toBe(false);
        for (const ip of ['81.2.69.142', '8.8.8.8', '2a02:c7f::1']) expect(isPublicIp(ip), ip).toBe(true);
    });
});

// Cross-check against the reference reader on a real GeoLite2 database when one is on this machine.
const REAL = [process.env.GEO_TEST_MMDB || '', '/root/node_modules.prev-hulo/geolite2-redist/dbs/GeoLite2-City.mmdb'].find(p => !!p && fs.existsSync(p));
describe.skipIf(!REAL)('MmdbReader vs mmdb-lib on GeoLite2', () => {
    it('agrees on country and subdivision for a sample of addresses', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Reader } = require('mmdb-lib');
        const buf = fs.readFileSync(REAL!);
        const ref = new Reader(buf);
        const mine = new MmdbReader(buf);
        const ips = ['81.2.69.142', '8.8.8.8', '1.1.1.1', '2a02:c7f::1', '2001:4860:4860::8888', '89.160.20.112', '175.16.199.1', '216.160.83.56', '5.9.0.1', '41.0.0.1', '200.1.1.1'];
        for (let i = 0; i < 300; i++) ips.push([1 + (i * 37) % 222, (i * 91) % 256, (i * 13) % 256, 7].join('.'));
        for (const ip of ips) {
            const r = ref.get(ip);
            const expected = r?.country?.iso_code || r?.registered_country?.iso_code || null;
            expect(mine.country(ip)?.country ?? null, ip).toBe(expected);
        }
    });
});
