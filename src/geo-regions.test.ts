import { describe, expect, it } from 'vitest';
import { ipMatchesAny } from './geo-regions';
import { getRealIp, normaliseIp } from './proxy-headers';
import { checkSchedule } from './schedule';

describe('ipMatchesAny', () => {
    it('matches plain IPv4 and CIDR ranges', () => {
        expect(ipMatchesAny('203.0.113.5', ['203.0.113.5'])).toBe(true);
        expect(ipMatchesAny('203.0.113.77', ['203.0.113.0/24'])).toBe(true);
        expect(ipMatchesAny('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
    });
    it('sees through IPv4-mapped IPv6 (dual-stack req.ip) and ignores case', () => {
        expect(ipMatchesAny('::ffff:203.0.113.5', ['203.0.113.5'])).toBe(true);
        expect(ipMatchesAny('::FFFF:203.0.113.5', ['203.0.113.0/24'])).toBe(true);
        expect(ipMatchesAny('2001:DB8::1', ['2001:db8::1'])).toBe(true);
    });
});

describe('getRealIp', () => {
    const req = (headers: Record<string, string>, ip = '10.0.0.9') => ({ headers, ip } as any);
    it('uses req.ip by default and ignores spoofable proxy headers', () => {
        expect(getRealIp(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.9', 'cf-connecting-ip': '198.51.100.2' }))).toBe('10.0.0.9');
    });
    it('honours only the headers the host trusts, in order', () => {
        // Right-most hop: the left-most one is whatever the client sent.
        expect(getRealIp(req({ 'x-forwarded-for': '198.51.100.1, 198.51.100.3' }), ['x-forwarded-for'])).toBe('198.51.100.3');
        expect(getRealIp(req({ 'cf-connecting-ip': '::ffff:198.51.100.2' }), ['cf-connecting-ip'])).toBe('198.51.100.2');
        expect(getRealIp(req({}), ['cf-connecting-ip'])).toBe('10.0.0.9');
        expect(normaliseIp('')).toBeNull();
    });
});

describe('checkSchedule normalisation', () => {
    it('accepts day numbers given as strings and never yields a 24:xx hour', () => {
        const monday = new Date('2026-09-28T09:30:00Z'); // a Monday
        const s: any = { timezone: 'Europe/London', days: ['1'], from: '09:00', to: '17:00', action: 'block' };
        expect(checkSchedule(s, monday).inHours).toBe(true);
        const midnight = new Date('2026-09-28T23:30:00Z'); // 00:30 BST Tuesday
        const r = checkSchedule({ ...s, days: ['2'], from: '00:00', to: '01:00' }, midnight);
        expect(r.localTime && r.localTime.startsWith('24')).toBe(false);
    });
});
