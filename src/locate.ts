/**
 * Where a visitor's country comes from, in order:
 *   1. a trusted edge header (Cloudflare / Akamai / Fastly — see proxy-headers);
 *   2. the host's own MaxMind-format database file (`maxmindDbPath`), read
 *      locally — never downloaded, no service called;
 *   3. nothing: the country is unknown and the visitor is allowed (fail open).
 */
import { Request } from 'express';
import { getOptions } from './plugin';
import { getRealIp, getResolvedCountry, getResolvedRegion, peerIsTrustedProxy } from './proxy-headers';
import { LocalCountryDb } from './mmdb';

export type CountrySource = 'cdn' | 'maxmind' | 'none';

let db: LocalCountryDb | null = null;
let dbPath: string | null = null;
/** When an edge country header was last believed (for the diagnostic). */
let cdnSeenAt: number | null = null;

export function localCountryDb(): LocalCountryDb | null {
    const p = String(getOptions().maxmindDbPath || '').trim();
    if (!p) { db = null; dbPath = null; return null; }
    if (!db || dbPath !== p) { db = new LocalCountryDb(p); dbPath = p; }
    return db;
}

export function locate(req: Request, ip: string | null = getRealIp(req, getOptions().trustedIpHeaders)): { country: string | null; region: string | null; source: CountrySource } {
    const opts = getOptions();
    const country = getResolvedCountry(req, opts.trustedCountryHeaders);
    if (country) {
        cdnSeenAt = Date.now();
        return { country, region: getResolvedRegion(req, opts.trustedCountryHeaders), source: 'cdn' };
    }
    try {
        const hit = localCountryDb()?.lookup(ip);
        if (hit?.country) return { country: hit.country, region: hit.region, source: 'maxmind' };
    } catch { /* fail open */ }
    return { country: null, region: null, source: 'none' };
}

/** Country-source diagnostic for the admin page: what THIS request resolved
 *  to and why, plus which sources are configured. Never echoes header values
 *  other than the country code itself. */
export function diagnose(req: Request) {
    const opts = getOptions();
    const ip = getRealIp(req, opts.trustedIpHeaders);
    const viaTrustedProxy = peerIsTrustedProxy(req);
    const loc = locate(req, ip);
    const present = ['cf-ipcountry', 'x-akamai-edgescape', 'x-country-code'].filter(h => !!req.headers?.[h]);
    const headersInForce = Array.isArray(opts.trustedCountryHeaders)
        ? opts.trustedCountryHeaders
        : (viaTrustedProxy ? ['cf-ipcountry', 'x-akamai-edgescape', 'x-country-code'] : []);
    const notes: string[] = [];
    if (loc.source === 'none') {
        if (present.length && !headersInForce.length) {
            notes.push('A country header is present but not trusted: the request did not come through a proxy listed in Vendure apiOptions.trustProxy. Set trustProxy (or the trustedCountryHeaders option) to match your edge.');
        } else if (!present.length) {
            notes.push('No CDN country header reached Vendure. Enable IP geolocation at your CDN (Cloudflare: Network → IP Geolocation) or set maxmindDbPath to a local GeoLite2-Country.mmdb file.');
        }
        if (!opts.maxmindDbPath) notes.push('No local MaxMind database is configured (maxmindDbPath).');
        notes.push('While the country is unknown visitors are allowed; IP allowlists, business hours and maintenance still apply.');
    }
    return {
        ip,
        country: loc.country,
        region: loc.region,
        source: loc.source,
        viaTrustedProxy,
        countryHeadersPresent: present,
        countryHeadersTrusted: headersInForce,
        trustedIpHeaders: opts.trustedIpHeaders || [],
        cdnHeaderLastSeenAt: cdnSeenAt ? new Date(cdnSeenAt).toISOString() : null,
        maxmind: localCountryDb()?.status() ?? { configured: false },
        notes,
    };
}
