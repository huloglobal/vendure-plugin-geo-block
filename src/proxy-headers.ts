import { Request } from 'express';

/**
 * Reverse-proxy aware visitor IP extraction.
 *
 * Order of precedence:
 *   1. Cloudflare's `CF-Connecting-IP` (always the real client IP,
 *      regardless of how many proxies sit in front of the worker).
 *   2. `True-Client-IP` (Akamai / Cloudflare Enterprise).
 *   3. `X-Real-IP` (nginx / Caddy default when proxying).
 *   4. `X-Forwarded-For`, right-most hop that is not a trusted proxy.
 *   5. Express's `req.ip` — only useful when `app.set('trust proxy', ...)`
 *      has been set on the Vendure host, otherwise this is the socket
 *      address of the last hop.
 *
 * Returns `null` if none of the headers are populated and `req.ip`
 * isn't available — the caller should treat this as "unknown" and
 * skip IP-dependent enrichment rather than fail.
 */
export type TrustedIpHeader = 'cf-connecting-ip' | 'true-client-ip' | 'x-real-ip' | 'x-forwarded-for';

/** `::ffff:203.0.113.5` → `203.0.113.5`; IPv6 lower-cased. */
export function normaliseIp(ip: string | null | undefined): string | null {
    const v = String(ip || '').trim();
    if (!v) return null;
    const m = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    return (m ? m[1] : v).toLowerCase().slice(0, 64);
}

/** Express's compiled `trust proxy` predicate (Vendure `apiOptions.trustProxy`). */
function trustFn(req: Request): ((addr: string, i: number) => boolean) | null {
    try {
        const fn = (req as any).app?.get?.('trust proxy fn');
        return typeof fn === 'function' ? fn : null;
    } catch {
        return null;
    }
}

/** True when the connection's immediate peer is a proxy the host trusts via
 *  Express `trust proxy`. Edge headers (country, region) are only believable
 *  then — a client talking to the server directly can send any header. */
export function peerIsTrustedProxy(req: Request): boolean {
    const fn = trustFn(req);
    const peer = (req as any).socket?.remoteAddress || (req as any).connection?.remoteAddress;
    if (!fn || !peer) return false;
    try { return !!fn(peer, 0); } catch { return false; }
}

/**
 * The visitor's IP. By default this is Express's `req.ip`, which honours
 * the host's `trust proxy` setting and cannot be forged by the client.
 * Vendor headers (`CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`,
 * `X-Forwarded-For`) are only consulted when the host opts in with
 * `trustedIpHeaders` — otherwise anyone could send
 * `X-Forwarded-For: <office IP>` and walk through the IP allowlist.
 * For `X-Forwarded-For` the right-most hop that is not itself a trusted
 * proxy is used: hops to the left of it were written by the client.
 */
export function getRealIp(req: Request, trusted: TrustedIpHeader[] = []): string | null {
    const headers = req.headers || {};
    for (const name of trusted) {
        const raw = String(headers[name] || '').trim();
        if (!raw) continue;
        const value = name === 'x-forwarded-for' ? rightMostUntrustedHop(req, raw) : raw;
        const ip = normaliseIp(value);
        if (ip) return ip;
    }
    return normaliseIp((req as any).ip) || null;
}

function rightMostUntrustedHop(req: Request, xff: string): string | null {
    const hops = xff.split(',').map(h => h.trim()).filter(Boolean);
    if (!hops.length) return null;
    const fn = trustFn(req);
    for (let i = hops.length - 1; i >= 0; i--) {
        const hop = normaliseIp(hops[i]) || hops[i];
        let isTrusted = false;
        try { isTrusted = !!fn && !!fn(hop, hops.length - i); } catch { isTrusted = false; }
        if (!isTrusted) return hops[i];
    }
    return hops[0];
}

export type CountryHeader = 'cf-ipcountry' | 'x-akamai-edgescape' | 'x-country-code';
const DEFAULT_COUNTRY_HEADERS: CountryHeader[] = ['cf-ipcountry', 'x-akamai-edgescape', 'x-country-code'];

/** The country headers believed for this request: the host's explicit
 *  `trustedCountryHeaders` list, else the vendor defaults — but only when the
 *  request came through a trusted proxy (Express `trust proxy`). */
function countryHeadersInForce(req: Request, configured?: CountryHeader[]): CountryHeader[] {
    if (Array.isArray(configured)) return configured;
    return peerIsTrustedProxy(req) ? DEFAULT_COUNTRY_HEADERS : [];
}

/**
 * Cloudflare / Akamai / Fastly populate the visitor's resolved country on
 * the inbound request when the corresponding feature is enabled. Reading
 * the upstream value avoids a per-request GeoIP lookup. Returns the
 * ISO 3166-1 alpha-2 country code or `null`.
 *
 * Trusted only per `countryHeadersInForce`. The first header in force that
 * is PRESENT decides: when Cloudflare sends `XX` / `T1` the answer is
 * "unknown", not whatever `X-Country-Code` the client added (edges pass
 * other vendors' headers through untouched).
 */
export function getResolvedCountry(req: Request, configured?: CountryHeader[]): string | null {
    const headers = req.headers || {};
    for (const name of countryHeadersInForce(req, configured)) {
        const raw = String(headers[name] || '').trim();
        if (!raw) continue;
        if (name === 'x-akamai-edgescape') {
            const m = raw.match(/country_code=([A-Z]{2})/i);
            return m ? m[1].toUpperCase() : null;
        }
        const cc = raw.toUpperCase();
        if (cc === 'XX' || cc === 'T1' || !/^[A-Z]{2}$/.test(cc)) return null;
        return cc;
    }
    return null;
}

/**
 * Cloudflare's `cf-region-code` carries the ISO 3166-2 subdivision
 * (e.g. `ENG`, `SCT`, `CA`) when the "Send subdivision data" option is
 * enabled in the dashboard. Trusted only when `cf-ipcountry` is. Returns
 * the bare code without the country prefix, or `null` if unavailable.
 */
export function getResolvedRegion(req: Request, configured?: CountryHeader[]): string | null {
    if (!countryHeadersInForce(req, configured).includes('cf-ipcountry')) return null;
    const headers = req.headers || {};
    const cf = String(headers['cf-region-code'] || '').trim().toUpperCase();
    if (cf && /^[A-Z0-9]{1,4}$/.test(cf)) return cf;
    return null;
}
