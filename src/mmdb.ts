/**
 * MaxMind DB (`.mmdb`) reader for the country fallback.
 *
 * Reads a database file the HOST already has on disk (GeoLite2-Country,
 * GeoLite2-City, GeoIP2-Country, DB-IP Lite in MMDB form…). Nothing is ever
 * downloaded and no service is called: when no file is configured, or it
 * cannot be read, every lookup answers `null` and the plugin behaves exactly
 * as before (country unknown → allowed).
 *
 * A small self-contained implementation of the published MaxMind DB format
 * (https://maxmind.github.io/MaxMind-DB/): binary search tree + data section
 * decoder. Only what a country lookup needs is exposed.
 */
import * as fs from 'fs';
import { parseIp } from './geo-regions';

const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);

export interface MmdbMetadata {
    nodeCount: number;
    recordSize: number;
    ipVersion: number;
    databaseType: string;
    buildEpoch: number;
}

export interface MmdbCountry {
    country: string | null;
    region: string | null;
}

class Decoder {
    constructor(private readonly buf: Buffer, private readonly pointerBase: number) {}

    /** Decode the value at `offset`; returns it and the offset after it. */
    decode(offset: number, depth = 0): [any, number] {
        if (depth > 32) throw new Error('mmdb: data nested too deeply');
        const ctrl = this.buf[offset++];
        let type = ctrl >> 5;
        if (type === 1) {
            // Pointer: the value lives elsewhere; the cursor moves past the pointer only.
            const ss = (ctrl >> 3) & 0x3;
            const vvv = ctrl & 0x7;
            let p: number;
            if (ss === 0) { p = (vvv << 8) | this.buf[offset]; offset += 1; }
            else if (ss === 1) { p = ((vvv << 16) | this.buf.readUInt16BE(offset)) + 2048; offset += 2; }
            else if (ss === 2) { p = ((vvv << 24) | this.buf.readUIntBE(offset, 3)) + 526336; offset += 3; }
            else { p = this.buf.readUInt32BE(offset); offset += 4; }
            const [value] = this.decode(this.pointerBase + p, depth + 1);
            return [value, offset];
        }
        if (type === 0) type = 7 + this.buf[offset++];
        let size = ctrl & 0x1f;
        if (size === 29) size = 29 + this.buf[offset++];
        else if (size === 30) { size = 285 + this.buf.readUInt16BE(offset); offset += 2; }
        else if (size === 31) { size = 65821 + this.buf.readUIntBE(offset, 3); offset += 3; }
        switch (type) {
            case 2: return [this.buf.toString('utf8', offset, offset + size), offset + size];
            case 3: return [this.buf.readDoubleBE(offset), offset + 8];
            case 4: return [this.buf.subarray(offset, offset + size), offset + size];
            case 5: case 6: case 9: case 10: {
                let n = 0;
                for (let i = 0; i < size; i++) n = n * 256 + this.buf[offset + i];
                return [n, offset + size];
            }
            case 8: {
                let n = 0;
                for (let i = 0; i < size; i++) n = (n << 8) | this.buf[offset + i];
                if (size === 4) n = n | 0;
                return [n, offset + size];
            }
            case 7: {
                const out: Record<string, any> = {};
                for (let i = 0; i < size; i++) {
                    const [k, o1] = this.decode(offset, depth + 1);
                    const [v, o2] = this.decode(o1, depth + 1);
                    out[String(k)] = v;
                    offset = o2;
                }
                return [out, offset];
            }
            case 11: {
                const out: any[] = [];
                for (let i = 0; i < size; i++) {
                    const [v, o] = this.decode(offset, depth + 1);
                    out.push(v);
                    offset = o;
                }
                return [out, offset];
            }
            case 14: return [size !== 0, offset];
            case 15: return [this.buf.readFloatBE(offset), offset + 4];
            default: throw new Error(`mmdb: unsupported data type ${type}`);
        }
    }
}

export class MmdbReader {
    readonly metadata: MmdbMetadata;
    private readonly treeSize: number;
    private readonly data: Decoder;
    private ipv4Start = -1;

    constructor(private readonly buf: Buffer) {
        const at = buf.lastIndexOf(METADATA_MARKER);
        if (at < 0) throw new Error('mmdb: metadata marker not found — not a MaxMind DB file');
        const metaStart = at + METADATA_MARKER.length;
        const [meta] = new Decoder(buf, metaStart).decode(metaStart);
        const nodeCount = Number(meta?.node_count);
        const recordSize = Number(meta?.record_size);
        if (!Number.isInteger(nodeCount) || nodeCount <= 0 || ![24, 28, 32].includes(recordSize)) {
            throw new Error('mmdb: unsupported metadata (node_count / record_size)');
        }
        this.metadata = {
            nodeCount, recordSize,
            ipVersion: Number(meta.ip_version) || 4,
            databaseType: String(meta.database_type || ''),
            buildEpoch: Number(meta.build_epoch) || 0,
        };
        this.treeSize = ((recordSize * 2) / 8) * nodeCount;
        if (this.treeSize + 16 > at) throw new Error('mmdb: search tree overruns the file');
        this.data = new Decoder(buf, this.treeSize + 16);
    }

    private record(node: number, bit: number): number {
        const b = this.buf;
        switch (this.metadata.recordSize) {
            case 24: {
                const o = node * 6 + bit * 3;
                return b.readUIntBE(o, 3);
            }
            case 28: {
                const o = node * 7;
                if (bit === 0) return ((b[o + 3] & 0xf0) << 20) | b.readUIntBE(o, 3);
                return ((b[o + 3] & 0x0f) << 24) | b.readUIntBE(o + 4, 3);
            }
            default: return b.readUInt32BE(node * 8 + bit * 4);
        }
    }

    private startNode(bytes: Uint8Array): number {
        if (bytes.length === 16 || this.metadata.ipVersion !== 6) return 0;
        // IPv4 in an IPv6 tree: walk 96 zero bits once (::a.b.c.d).
        if (this.ipv4Start < 0) {
            let node = 0;
            for (let i = 0; i < 96 && node < this.metadata.nodeCount; i++) node = this.record(node, 0);
            this.ipv4Start = node;
        }
        return this.ipv4Start;
    }

    /** The raw record for an address, or null when the database has none. */
    get(ip: string): any | null {
        const bytes = parseIp(ip);
        if (!bytes) return null;
        if (bytes.length === 16 && this.metadata.ipVersion === 4) return null;
        const { nodeCount } = this.metadata;
        let node = this.startNode(bytes);
        const bits = bytes.length * 8;
        for (let i = 0; i < bits && node < nodeCount; i++) {
            const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
            node = this.record(node, bit);
        }
        if (node <= nodeCount) return null; // == nodeCount: no data for this network
        const offset = node - nodeCount + this.treeSize;
        if (offset >= this.buf.length) return null;
        return this.data.decode(offset)[0];
    }

    /** ISO country (and first subdivision, City databases) for an address. */
    country(ip: string): MmdbCountry | null {
        const rec = this.get(ip);
        if (!rec || typeof rec !== 'object') return null;
        const cc = String(rec.country?.iso_code || rec.registered_country?.iso_code || '').toUpperCase();
        if (!/^[A-Z]{2}$/.test(cc)) return null;
        const sub = Array.isArray(rec.subdivisions) ? String(rec.subdivisions[0]?.iso_code || '').toUpperCase() : '';
        return { country: cc, region: /^[A-Z0-9]{1,4}$/.test(sub) ? sub : null };
    }
}

/** Private, loopback, link-local and other non-routable addresses never have a country. */
export function isPublicIp(ip: string | null | undefined): boolean {
    const b = parseIp(ip);
    if (!b) return false;
    if (b.length === 4) {
        const [a, c] = [b[0], b[1]];
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && c >= 64 && c <= 127) return false; // CGNAT
        if (a === 169 && c === 254) return false;
        if (a === 172 && c >= 16 && c <= 31) return false;
        if (a === 192 && c === 168) return false;
        if (a === 192 && c === 0 && b[2] === 2) return false; // TEST-NET-1
        if (a === 198 && (c === 18 || c === 19)) return false;
        if (a === 198 && c === 51 && b[2] === 100) return false; // TEST-NET-2
        if (a === 203 && c === 0 && b[2] === 113) return false; // TEST-NET-3
        return true;
    }
    if (b.every((x, i) => i === 15 ? x <= 1 : x === 0)) return false; // :: and ::1
    if ((b[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false; // fe80::/10
    if (b[0] === 0xff) return false; // multicast
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation
    return true;
}

/**
 * Lazily opened, mtime-aware wrapper around one local database file. The file
 * is re-read when it changes on disk (checked at most every `recheckMs`), so a
 * host's own `geoipupdate` cron keeps it fresh without a restart. Lookups are
 * memoised (bounded). Every failure is swallowed: the fallback then answers
 * null and the plugin carries on as if there were no database.
 */
export class LocalCountryDb {
    private reader: MmdbReader | null = null;
    private loadedMtime = 0;
    private lastCheck = 0;
    private error: string | null = null;
    private cache = new Map<string, MmdbCountry | null>();

    constructor(private readonly path: string, private readonly recheckMs = 10 * 60_000) {}

    private refresh(): void {
        const now = Date.now();
        if (this.lastCheck && now - this.lastCheck < this.recheckMs) return;
        this.lastCheck = now;
        try {
            const st = fs.statSync(this.path);
            if (this.reader && st.mtimeMs === this.loadedMtime) return;
            if (!st.isFile() || st.size > 512 * 1024 * 1024) throw new Error('not a regular file under 512 MB');
            this.reader = new MmdbReader(fs.readFileSync(this.path));
            this.loadedMtime = st.mtimeMs;
            this.cache.clear();
            this.error = null;
        } catch (e: any) {
            // Keep a previously loaded database if the new copy is mid-write.
            this.error = String(e?.code || e?.message || e).slice(0, 200);
        }
    }

    lookup(ip: string | null | undefined): MmdbCountry | null {
        if (!ip || !isPublicIp(ip)) return null;
        this.refresh();
        if (!this.reader) return null;
        if (this.cache.has(ip)) return this.cache.get(ip)!;
        let hit: MmdbCountry | null = null;
        try { hit = this.reader.country(ip); } catch { hit = null; }
        if (this.cache.size > 10_000) this.cache.clear();
        this.cache.set(ip, hit);
        return hit;
    }

    /** For the admin diagnostic. Never exposes more than the file name. */
    status(): { configured: true; loaded: boolean; file: string; databaseType: string | null; builtAt: string | null; error: string | null } {
        this.refresh();
        const m = this.reader?.metadata;
        return {
            configured: true,
            loaded: !!this.reader,
            file: this.path.split(/[\\/]/).pop() || '',
            databaseType: m?.databaseType || null,
            builtAt: m?.buildEpoch ? new Date(m.buildEpoch * 1000).toISOString() : null,
            error: this.error,
        };
    }
}
