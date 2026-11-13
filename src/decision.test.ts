import { describe, expect, it } from 'vitest';
import { decide, httpStatusFor, refusesPurchase, RulesForDecision, sanitiseMaintenance, sanitiseSchedule } from './decision';
import { isIpOrCidr } from './geo-regions';

const base = (over: Partial<RulesForDecision> = {}): RulesForDecision => ({
    enabled: true,
    mode: 'block',
    allowedCountries: ['GB', 'FR'],
    blockedCountries: [],
    allowedGbRegions: [],
    allowedSubdivisions: {},
    blockMessage: '',
    blockRedirectUrl: null,
    blockLogoUrl: null,
    ipAllowlist: [],
    schedule: null,
    maintenance: null,
    ...over,
});
const view = { premium: true, purpose: 'view' as const };
const buy = { premium: true, purpose: 'purchase' as const };
const visitor = (country: string | null, extra: any = {}) => ({ ip: '81.2.69.1', country, region: null, isCrawler: false, ...extra });

describe('decide()', () => {
    it('allows listed countries and blocks others with the default message', () => {
        expect(decide(base(), visitor('GB'), view)).toMatchObject({ allowed: true, reason: 'ok' });
        const v = decide(base(), visitor('US'), view);
        expect(v).toMatchObject({ allowed: false, reason: 'country-not-allowed', mode: 'block' });
        expect(v.message).toMatch(/not available in your country/);
    });
    it('fails open on an unknown country', () => {
        expect(decide(base(), visitor(null), buy).allowed).toBe(true);
    });
    it('IP allowlist (IPv6 CIDR) beats everything', () => {
        const r = base({ ipAllowlist: ['2001:db8:abcd::/48'], maintenance: { startsAt: '2000-01-01T00:00:00Z', endsAt: '2100-01-01T00:00:00Z' } });
        expect(decide(r, visitor('US', { ip: '2001:db8:abcd:1::5' }), buy)).toMatchObject({ allowed: true, reason: 'ip-allowlist' });
    });
    it('crawlers are exempt for page views only, never for purchases', () => {
        expect(decide(base(), visitor('US', { isCrawler: true }), view)).toMatchObject({ allowed: true, reason: 'bot-allowlist' });
        expect(decide(base(), visitor('US', { isCrawler: true }), buy)).toMatchObject({ allowed: false });
    });
    it('channel maintenance window refuses with 503 semantics and its own message; its IPs bypass', () => {
        const now = new Date('2026-12-01T23:00:00Z');
        const r = base({ enabled: false, maintenance: { startsAt: '2026-12-01T22:00:00Z', endsAt: '2026-12-02T01:00:00Z', allowedIps: ['198.51.100.7'], message: 'Upgrading' } });
        const v = decide(r, visitor('GB'), { ...view, now });
        expect(v).toMatchObject({ allowed: false, reason: 'maintenance', mode: 'block', message: 'Upgrading' });
        expect(v.retryAfterSec).toBe(7200);
        expect(httpStatusFor(v.reason)).toBe(503);
        expect(decide(r, visitor('GB', { ip: '198.51.100.7' }), { ...view, now }).allowed).toBe(true);
        expect(decide(r, visitor('GB'), { ...view, now: new Date('2026-12-02T02:00:00Z') }).allowed).toBe(true);
    });
    it('the init-option maintenance window still applies to every channel', () => {
        const now = new Date('2026-12-01T23:00:00Z');
        const v = decide(base({ enabled: false }), visitor('GB'), { ...view, now, globalMaintenance: { startsAt: '2026-12-01T22:00:00Z', endsAt: '2026-12-02T00:00:00Z' } });
        expect(v).toMatchObject({ allowed: false, reason: 'maintenance' });
    });
    it('schedule: soft stays soft only with premium', () => {
        const schedule = { timezone: 'UTC', days: [1] as any, from: '09:00', to: '17:00', outsideAction: 'soft' as const };
        const sunday = new Date('2026-11-15T12:00:00Z');
        expect(decide(base({ schedule }), visitor('GB'), { ...view, now: sunday }).mode).toBe('soft');
        expect(decide(base({ schedule }), visitor('GB'), { premium: false, purpose: 'view', now: sunday }).mode).toBe('block');
    });
    it('a soft block never refuses a purchase; a full block does', () => {
        expect(refusesPurchase(decide(base({ mode: 'soft' }), visitor('US'), buy))).toBe(false);
        expect(refusesPurchase(decide(base(), visitor('US'), buy))).toBe(true);
        expect(refusesPurchase(decide(base({ enabled: false }), visitor('US'), buy))).toBe(false);
    });
    it('status codes', () => {
        expect(httpStatusFor('country-not-allowed')).toBe(403);
        expect(httpStatusFor('schedule')).toBe(503);
    });
});

describe('sanitisers', () => {
    it('maintenance window', () => {
        expect(sanitiseMaintenance(null, isIpOrCidr)).toBeNull();
        expect(sanitiseMaintenance({ startsAt: '', endsAt: '' }, isIpOrCidr)).toBeNull();
        const m = sanitiseMaintenance({ startsAt: '2026-12-01T22:00:00Z', endsAt: '2026-12-02T01:00:00Z', allowedIps: ['2001:db8::/48', '2001:db8::/48'], message: ' hi ' }, isIpOrCidr)!;
        expect(m).toEqual({ startsAt: '2026-12-01T22:00:00.000Z', endsAt: '2026-12-02T01:00:00.000Z', allowedIps: ['2001:db8::/48'], message: 'hi' });
        expect(() => sanitiseMaintenance({ startsAt: '2026-12-02', endsAt: '2026-12-01' }, isIpOrCidr)).toThrow(/after/);
        expect(() => sanitiseMaintenance({ startsAt: '2026-01-01', endsAt: '2026-03-01' }, isIpOrCidr)).toThrow(/31 days/);
        expect(() => sanitiseMaintenance({ startsAt: '2026-12-01', endsAt: '2026-12-02', allowedIps: ['0.0.0.0/0'] }, isIpOrCidr)).toThrow(/CIDR/);
    });
    it('schedule', () => {
        expect(sanitiseSchedule(null)).toBeNull();
        expect(sanitiseSchedule({ from: '9:00', to: '17:30', days: ['1', 2, 9], timezone: 'Europe/London', outsideAction: 'soft' }))
            .toEqual({ timezone: 'Europe/London', days: [1, 2], from: '09:00', to: '17:30', outsideAction: 'soft' });
        expect(() => sanitiseSchedule({ from: '25:00', to: '10:00' })).toThrow(/HH:MM/);
        expect(() => sanitiseSchedule({ from: '09:00' })).toThrow(/both/);
        expect(() => sanitiseSchedule({ days: [1], timezone: 'Mars/Olympus' })).toThrow(/time zone/);
        expect(sanitiseSchedule({ outsideAction: 'block' })).toBeNull();
    });
});
