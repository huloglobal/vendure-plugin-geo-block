import { describe, expect, it } from 'vitest';
import { getRealIp, getResolvedCountry, getResolvedRegion } from './proxy-headers';

/** A request as Express hands it to the controller: `trust proxy fn` is what
 *  `app.set('trust proxy', …)` (Vendure `apiOptions.trustProxy`) compiles to. */
function req(headers: Record<string, string>, peer: string, trusted: string[] = []) {
    const fn = (addr: string) => trusted.includes(addr);
    return {
        headers,
        ip: peer,
        socket: { remoteAddress: peer },
        app: { get: (k: string) => (k === 'trust proxy fn' ? fn : undefined) },
    } as any;
}

describe('country headers are only trusted from a trusted proxy', () => {
    it('ignores CF-IPCountry / X-Country-Code / Akamai sent straight by a client', () => {
        // Direct client, no trust proxy configured: a blocked visitor claims GB.
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'GB' }, '203.0.113.9'))).toBeNull();
        expect(getResolvedCountry(req({ 'x-country-code': 'GB' }, '203.0.113.9'))).toBeNull();
        expect(getResolvedCountry(req({ 'x-akamai-edgescape': 'country_code=GB' }, '203.0.113.9'))).toBeNull();
        expect(getResolvedRegion(req({ 'cf-region-code': 'ENG' }, '203.0.113.9'))).toBeNull();
    });

    it('honours them when the request arrived through a trusted proxy', () => {
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'fr' }, '127.0.0.1', ['127.0.0.1']))).toBe('FR');
        expect(getResolvedRegion(req({ 'cf-ipcountry': 'GB', 'cf-region-code': 'SCT' }, '127.0.0.1', ['127.0.0.1']))).toBe('SCT');
    });

    it('does not fall through to a client-supplied vendor header when Cloudflare says XX / T1', () => {
        const r = req({ 'cf-ipcountry': 'T1', 'x-country-code': 'GB' }, '127.0.0.1', ['127.0.0.1']);
        expect(getResolvedCountry(r)).toBeNull();
    });

    it('an explicit trustedCountryHeaders list is used as configured (host asserts its edge strips them)', () => {
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'GB' }, '203.0.113.9'), ['cf-ipcountry'])).toBe('GB');
        expect(getResolvedCountry(req({ 'x-country-code': 'GB' }, '203.0.113.9'), ['cf-ipcountry'])).toBeNull();
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'GB' }, '127.0.0.1', ['127.0.0.1']), [])).toBeNull();
    });
});

describe('X-Forwarded-For opt-in takes the right-most untrusted hop', () => {
    it('a client-prepended hop cannot pick the visitor IP', () => {
        // Client sends "X-Forwarded-For: 192.0.2.1" (an allow-listed office IP);
        // the trusted proxy appends the real peer 198.51.100.7.
        const r = req({ 'x-forwarded-for': '192.0.2.1, 198.51.100.7' }, '127.0.0.1', ['127.0.0.1']);
        expect(getRealIp(r, ['x-forwarded-for'])).toBe('198.51.100.7');
    });
    it('skips trusted proxy hops from the right', () => {
        const r = req({ 'x-forwarded-for': '192.0.2.1, 198.51.100.7, 10.0.0.2' }, '127.0.0.1', ['127.0.0.1', '10.0.0.2']);
        expect(getRealIp(r, ['x-forwarded-for'])).toBe('198.51.100.7');
    });
});
