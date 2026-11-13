/**
 * Reverse-DNS verification for crawlers that publish it (Googlebot, Bingbot).
 *
 * A User-Agent is not identity: anyone can send `Googlebot`. With
 * `verifyBots` on, a request whose User-Agent claims to be one of these
 * crawlers keeps the crawler exemption only when its IP reverse-resolves to
 * the crawler's own domain AND that host name forward-resolves back to the
 * same IP (Google's and Microsoft's documented method). Uses the server's own
 * resolver; no third-party service. Results are cached per IP for a day
 * (failures for an hour), and lookups time out after 2 s — a slow resolver
 * then costs the claimed crawler its exemption, never a real shopper anything.
 */
import { promises as dnsPromises } from 'dns';
import { parseIp } from './geo-regions';
import { isPublicIp } from './mmdb';

/** UA token (lower-case) → host-name suffixes its reverse DNS must end with. */
export const VERIFIABLE_BOTS: Record<string, string[]> = {
    'googlebot': ['.googlebot.com', '.google.com', '.googleusercontent.com'],
    'google-inspectiontool': ['.googlebot.com', '.google.com'],
    'storebot-google': ['.googlebot.com', '.google.com'],
    'adsbot-google': ['.googlebot.com', '.google.com'],
    'mediapartners-google': ['.googlebot.com', '.google.com'],
    'bingbot': ['.search.msn.com'],
    'adidxbot': ['.search.msn.com'],
    'bingpreview': ['.search.msn.com'],
};

/** Which verifiable crawler a User-Agent claims to be (null = none). */
export function claimedVerifiableBot(ua: string): string | null {
    const lower = String(ua || '').toLowerCase();
    for (const key of Object.keys(VERIFIABLE_BOTS)) if (lower.includes(key)) return key;
    return null;
}

export interface DnsLike {
    reverse(ip: string): Promise<string[]>;
    resolve4(host: string): Promise<string[]>;
    resolve6(host: string): Promise<string[]>;
}

const sameIp = (a: string, b: string): boolean => {
    const x = parseIp(a); const y = parseIp(b);
    return !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('dns timeout')), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

export class CrawlerVerifier {
    private cache = new Map<string, { ok: boolean; exp: number }>();

    constructor(private readonly dns: DnsLike = dnsPromises, private readonly timeoutMs = 2000) {}

    /** True when `ip` is a genuine `bot` crawler (key of VERIFIABLE_BOTS). */
    async verify(bot: string, ip: string | null | undefined): Promise<boolean> {
        const suffixes = VERIFIABLE_BOTS[bot];
        if (!suffixes || !ip || !isPublicIp(ip)) return false;
        const key = `${bot}|${ip}`;
        const hit = this.cache.get(key);
        if (hit && hit.exp > Date.now()) return hit.ok;
        let ok = false;
        try {
            const hosts = await withTimeout(this.dns.reverse(ip), this.timeoutMs);
            for (const raw of hosts || []) {
                const host = String(raw).toLowerCase().replace(/\.$/, '');
                if (!suffixes.some(s => host.endsWith(s))) continue;
                const v6 = (parseIp(ip)?.length ?? 4) === 16;
                const addrs = await withTimeout(v6 ? this.dns.resolve6(host) : this.dns.resolve4(host), this.timeoutMs);
                if ((addrs || []).some(a => sameIp(a, ip))) { ok = true; break; }
            }
        } catch {
            ok = false;
        }
        if (this.cache.size > 5000) this.cache.clear();
        this.cache.set(key, { ok, exp: Date.now() + (ok ? 86_400_000 : 3_600_000) });
        return ok;
    }
}
