import { describe, expect, it } from 'vitest';
import { ipMatchesAny, isFreeTierPreset, isIpOrCidr, parseIp } from './geo-regions';
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

describe('ipMatchesAny — IPv6 and CIDR (B4)', () => {
    it('matches IPv6 CIDR ranges, which used to be string-compared and never matched', () => {
        expect(ipMatchesAny('2001:db8:abcd:12::1', ['2001:db8:abcd::/48'])).toBe(true);
        expect(ipMatchesAny('2001:db8:abce::1', ['2001:db8:abcd::/48'])).toBe(false);
        expect(ipMatchesAny('2001:0DB8:0000:0000:0000:0000:0000:0001', ['2001:db8::1'])).toBe(true);
        expect(ipMatchesAny('2001:db8::1', ['2001:db8:0:0::/64'])).toBe(true);
        expect(ipMatchesAny('fe80::1%eth0', ['fe80::/10'])).toBe(true);
        expect(ipMatchesAny('2001:db8::1', ['2001:db8::/129'])).toBe(false);
    });
    it('keeps IPv4 CIDR and IPv4-mapped behaviour', () => {
        expect(ipMatchesAny('203.0.113.77', ['203.0.113.0/24'])).toBe(true);
        expect(ipMatchesAny('::ffff:203.0.113.77', ['203.0.113.0/24'])).toBe(true);
        expect(ipMatchesAny('203.0.113.77', ['::ffff:203.0.113.0/120'])).toBe(true);
        expect(ipMatchesAny('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
        expect(ipMatchesAny('203.0.113.77', ['2001:db8::/32'])).toBe(false);
        expect(ipMatchesAny('not-an-ip', ['0.0.0.0/8'])).toBe(false);
    });
    it('parses IPv6 forms', () => {
        expect(Array.from(parseIp('::1')!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        expect(parseIp('1:2:3:4:5:6:7:8:9')).toBeNull();
        expect(parseIp('1::2::3')).toBeNull();
        expect(Array.from(parseIp('::ffff:c000:20a')!)).toEqual([192, 0, 2, 10]);
        expect(parseIp('64:ff9b::192.0.2.1')!.length).toBe(16);
    });
    it('isIpOrCidr refuses wide or malformed ranges', () => {
        expect(isIpOrCidr('2001:db8::/32')).toBe(true);
        expect(isIpOrCidr('203.0.113.0/24')).toBe(true);
        expect(isIpOrCidr('0.0.0.0/0')).toBe(false);
        expect(isIpOrCidr('::/0')).toBe(false);
        expect(isIpOrCidr('203.0.113.0/33')).toBe(false);
        expect(isIpOrCidr('banana')).toBe(false);
    });
    it('free-tier presets', () => {
        expect(isFreeTierPreset('EU')).toBe(true);
        expect(isFreeTierPreset('gcc')).toBe(false);
    });
});
