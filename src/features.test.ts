/**
 * Unit tests for the 0.15.0 features that need Vendure-ish plumbing:
 * reverse-DNS crawler verification, admin setting overrides, the premium
 * weekly report gate and the server-side purchase enforcement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrawlerVerifier, claimedVerifiableBot } from './bot-verify';
import { effectiveSettings, sanitiseOverrides, setOverrides } from './settings';
import { GeoBlockPlugin } from './plugin';
import { PremiumWeeklyDigest } from './engagement';
import { GeoBlockOrderInterceptor, geoBlockOrderProcess, purchaseRefusal } from './enforcement';

afterEach(() => { vi.restoreAllMocks(); setOverrides({}); });

describe('reverse-DNS crawler verification', () => {
    const dns = (reverse: Record<string, string[]>, forward: Record<string, string[]>) => ({
        reverse: vi.fn(async (ip: string) => { if (!reverse[ip]) throw new Error('ENOTFOUND'); return reverse[ip]; }),
        resolve4: vi.fn(async (h: string) => forward[h] || []),
        resolve6: vi.fn(async (h: string) => forward[h] || []),
    });
    it('accepts a genuine Googlebot (reverse + forward confirmed) and caches it', async () => {
        const d = dns({ '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'] }, { 'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'] });
        const v = new CrawlerVerifier(d);
        expect(await v.verify('googlebot', '66.249.66.1')).toBe(true);
        expect(await v.verify('googlebot', '66.249.66.1')).toBe(true);
        expect(d.reverse).toHaveBeenCalledTimes(1);
    });
    it('refuses a spoofed UA, a wrong domain, a forward mismatch, a DNS failure and private IPs', async () => {
        const d = dns(
            { '1.2.3.4': ['evil.example.com'], '5.6.7.8': ['crawl.googlebot.com.evil.net'], '9.9.9.9': ['x.search.msn.com'] },
            { 'x.search.msn.com': ['9.9.9.10'] },
        );
        const v = new CrawlerVerifier(d);
        expect(await v.verify('googlebot', '1.2.3.4')).toBe(false);
        expect(await v.verify('googlebot', '5.6.7.8')).toBe(false);
        expect(await v.verify('bingbot', '9.9.9.9')).toBe(false);
        expect(await v.verify('bingbot', '8.8.4.4')).toBe(false);
        expect(await v.verify('googlebot', '10.0.0.1')).toBe(false);
        expect(await v.verify('slackbot', '66.249.66.1')).toBe(false);
    });
    it('times out a hung resolver', async () => {
        const v = new CrawlerVerifier({ reverse: () => new Promise(() => undefined), resolve4: async () => [], resolve6: async () => [] }, 20);
        expect(await v.verify('bingbot', '157.55.39.1')).toBe(false);
    });
    it('claimedVerifiableBot', () => {
        expect(claimedVerifiableBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('googlebot');
        expect(claimedVerifiableBot('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe('bingbot');
        expect(claimedVerifiableBot('Slackbot-LinkExpanding 1.0')).toBeNull();
    });
});

describe('admin setting overrides', () => {
    it('init options are the defaults, overrides win, null resets', () => {
        expect(effectiveSettings()).toMatchObject({ botMode: 'strict', verifyBots: false, rateLimit: { capacity: 120, windowMs: 60_000 }, hashAuditIps: true });
        const o = sanitiseOverrides({}, { botMode: 'off', verifyBots: true, rateLimitPerMinute: 300, supportEmail: 'help@shop.test', bogus: 1 });
        expect(o).toEqual({ botMode: 'off', verifyBots: true, rateLimitPerMinute: 300, supportEmail: 'help@shop.test' });
        setOverrides(o);
        expect(effectiveSettings()).toMatchObject({ botAllowlist: false, verifyBots: true, rateLimit: { capacity: 300 }, supportEmail: 'help@shop.test' });
        expect(sanitiseOverrides(o, { botMode: null })).not.toHaveProperty('botMode');
    });
    it('custom bot list and validation', () => {
        setOverrides(sanitiseOverrides({}, { botMode: 'custom', botCustom: ['MyMonitor', 'x', 'MyMonitor'] }));
        expect(effectiveSettings().botAllowlist).toEqual(['MyMonitor']);
        expect(() => sanitiseOverrides({}, { rateLimitPerMinute: 1 })).toThrow();
        expect(() => sanitiseOverrides({}, { supportEmail: 'nope' })).toThrow();
        expect(() => sanitiseOverrides({}, { botMode: 'all' })).toThrow();
    });
});

describe('weekly report is premium', () => {
    it('ticks send nothing while premium is off', async () => {
        let premium = false;
        const send = vi.fn(async () => undefined);
        const prefs: any = {
            all: async () => ({}), get: async () => null, set: async () => undefined,
            cas: async () => true, casDelete: async () => true,
        };
        const d = new PremiumWeeklyDigest({
            pluginId: 'x', pluginName: 'X', prefs,
            collect: async () => ({ stats: [], tips: [], tier: 'paid', licence: null, evalState: null, adminUrl: 'https://a', premiumFeatures: [] } as any),
            send, defaultRecipient: () => 'ops@shop.test',
        }, () => premium);
        expect(await d.tick(new Date('2026-11-16T09:00:00'))).toBe(false);
        expect(send).not.toHaveBeenCalled();
        premium = true;
        expect(await d.tick(new Date('2026-11-16T09:00:00'))).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
    });
});

describe('server-side purchase enforcement', () => {
    const row = (over: any = {}) => ({
        id: 1, token: 'tok', geoBlockEnabled: 1, geoBlockMode: 'block', allowedRegions: '[]', extraAllowed: '["GB"]',
        blockedCountries: '[]', allowedGbRegions: '[]', ipAllowlist: '["198.51.100.7"]', enforcePurchases: 1, ...over,
    });
    const rules = (r: any) => ({ load: vi.fn(async () => r) }) as any;
    const ctx = (country: string | null, over: any = {}) => ({
        apiType: 'shop',
        channel: { token: 'tok' },
        req: { ip: '81.2.69.1', headers: country ? { 'cf-ipcountry': country } : {}, app: { get: () => () => true }, socket: { remoteAddress: '127.0.0.1' } },
        ...over,
    }) as any;

    it('is off unless the channel opts in', async () => {
        expect(await purchaseRefusal(ctx('US'), rules(row({ enforcePurchases: 0 })))).toBeUndefined();
        expect(await purchaseRefusal(ctx('US'), rules(row({ enforcePurchases: null })))).toBeUndefined();
    });
    it('refuses a fully blocked country with the channel message', async () => {
        expect(await purchaseRefusal(ctx('US'), rules(row({ blockMessage: 'We only ship to the UK.' })))).toBe('We only ship to the UK.');
        expect(await purchaseRefusal(ctx('GB'), rules(row()))).toBeUndefined();
    });
    it('fails open: unknown country, admin API, no request, lookup errors', async () => {
        expect(await purchaseRefusal(ctx(null), rules(row()))).toBeUndefined();
        expect(await purchaseRefusal(ctx('US', { apiType: 'admin' }), rules(row()))).toBeUndefined();
        expect(await purchaseRefusal(ctx('US', { req: undefined }), rules(row()))).toBeUndefined();
        expect(await purchaseRefusal(ctx('US'), { load: async () => { throw new Error('db down'); } } as any)).toBeUndefined();
        expect(await purchaseRefusal(ctx('US'), null)).toBeUndefined();
    });
    it('a soft block (premium) is a banner only; on the free tier soft becomes a full block', async () => {
        vi.spyOn(GeoBlockPlugin, 'hasPremiumAccess').mockReturnValue(true);
        expect(await purchaseRefusal(ctx('US'), rules(row({ geoBlockMode: 'soft' })))).toBeUndefined();
        vi.spyOn(GeoBlockPlugin, 'hasPremiumAccess').mockReturnValue(false);
        expect(await purchaseRefusal(ctx('US'), rules(row({ geoBlockMode: 'soft' })))).toBeTruthy();
    });
    it('the IP allowlist still lets the office through; crawlers get no exemption', async () => {
        const c = ctx('US');
        c.req.ip = '198.51.100.7';
        expect(await purchaseRefusal(c, rules(row()))).toBeUndefined();
        const bot = ctx('US');
        bot.req.headers['user-agent'] = 'Googlebot/2.1';
        expect(await purchaseRefusal(bot, rules(row()))).toBeTruthy();
    });
    it('the order process only guards the move to ArrangingPayment; lowering a quantity is always allowed', async () => {
        expect(await geoBlockOrderProcess.onTransitionStart!('ArrangingPayment' as any, 'PaymentAuthorized' as any, { ctx: ctx('US') } as any)).toBeUndefined();
        const i = new GeoBlockOrderInterceptor();
        expect(await i.willAdjustOrderLine(ctx('US'), {} as any, { orderLine: { quantity: 3 }, quantity: 1 })).toBeUndefined();
    });
});

describe('0.15.0 migration', () => {
    it('adds only the missing columns, enforcement defaulting to false, and drops them on down()', async () => {
        const { GeoBlockChannelFields1763020800000 } = await import('./migration');
        const cols = new Set<string>(['customFieldsGeoblockmaintenance']);
        const added: any[] = [];
        const qr: any = {
            hasColumn: async (_t: string, c: string) => cols.has(c),
            addColumn: async (_t: string, c: any) => { added.push(c); cols.add(c.name); },
            dropColumn: async (_t: string, c: string) => { cols.delete(c); },
        };
        const m = new GeoBlockChannelFields1763020800000();
        await m.up(qr);
        await m.up(qr);
        expect(added.map(c => [c.name, c.type, c.default])).toEqual([['customFieldsGeoblockenforcepurchases', 'boolean', false]]);
        await m.down(qr);
        expect(cols.size).toBe(0);
    });
});
