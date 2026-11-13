import { describe, expect, it } from 'vitest';
import {
    adminUrlFor,
    buildSetupItems,
    ChannelSetupRow,
    digestStats,
    listFromColumn,
    PREMIUM_FEATURES,
    statsFromRow,
    tipsFromItems,
    topRecentStats,
} from './engagement-core';

const blank: ChannelSetupRow = {
    enabled: false, allowedRegions: [], extraAllowed: [], blockedCountries: [], ipAllowlist: [],
    blockMessage: '', blockRedirectUrl: '', blockLogoUrl: '',
};

describe('statsFromRow', () => {
    it('reads MySQL DECIMAL strings and PG numbers alike, zero when absent', () => {
        expect(statsFromRow({ blocked: '12', softBlocked: 3, uniqueIps: '7' }))
            .toEqual({ requestsBlocked: 12, requestsSoftBlocked: 3, uniqueIpsBlocked: 7 });
        expect(statsFromRow({ blocked: null, softBlocked: undefined, uniqueIps: 'x' }))
            .toEqual({ requestsBlocked: 0, requestsSoftBlocked: 0, uniqueIpsBlocked: 0 });
        expect(statsFromRow(undefined)).toEqual({ requestsBlocked: 0, requestsSoftBlocked: 0, uniqueIpsBlocked: 0 });
    });
});

describe('listFromColumn', () => {
    it('accepts JSON arrays, comma lists, arrays and empties', () => {
        expect(listFromColumn('["EU","GB"]')).toEqual(['EU', 'GB']);
        expect(listFromColumn('EU, GB')).toEqual(['EU', 'GB']);
        expect(listFromColumn(['EU', 1 as any])).toEqual(['EU']);
        expect(listFromColumn(null)).toEqual([]);
        expect(listFromColumn('')).toEqual([]);
    });
});

describe('buildSetupItems', () => {
    it('is all undone for a fresh install', () => {
        const items = buildSetupItems([blank], false);
        expect(items.map(i => i.key)).toEqual(['rules', 'block-page', 'allowlist', 'simulate']);
        expect(items.every(i => !i.done)).toBe(true);
        expect(items.every(i => !!i.tab && !!i.hint)).toBe(true);
    });
    it('mirrors the first-run test: rules count once enforcement is on OR any list is filled', () => {
        expect(buildSetupItems([{ ...blank, enabled: true }], false)[0].done).toBe(true);
        expect(buildSetupItems([{ ...blank, blockedCountries: ['RU'] }], false)[0].done).toBe(true);
        expect(buildSetupItems([blank, { ...blank, allowedRegions: ['EU'] }], false)[0].done).toBe(true);
    });
    it('block page, allowlist and simulate are independent real checks', () => {
        const items = buildSetupItems([{ ...blank, blockLogoUrl: 'https://x/logo.svg', ipAllowlist: ['203.0.113.1'] }], true);
        expect(items.map(i => i.done)).toEqual([false, true, true, true]);
    });
    it('handles no channels at all', () => {
        expect(buildSetupItems([], false).every(i => !i.done)).toBe(true);
    });
});

describe('tipsFromItems', () => {
    it('takes at most three undone items, in order, linking to the admin tab', () => {
        const tips = tipsFromItems(buildSetupItems([blank], false), 'https://shop.example.com/admin/extensions/geo-block');
        expect(tips).toHaveLength(3);
        expect(tips[0].title).toBe('Set rules on a channel');
        expect(tips[0].url).toBe('https://shop.example.com/admin/extensions/geo-block?tab=rules');
        expect(tips[2].title).toBe('Allow-list your own IP');
    });
    it('is empty when everything is done and has no url without a base URL', () => {
        const done = buildSetupItems([{ ...blank, enabled: true, blockMessage: 'Hi', ipAllowlist: ['1.1.1.1'] }], true);
        expect(tipsFromItems(done, null)).toEqual([]);
        expect(tipsFromItems(buildSetupItems([blank], false), null)[0].url).toBeUndefined();
    });
});

describe('digestStats / topRecentStats', () => {
    const cur = { requestsBlocked: 40, requestsSoftBlocked: 0, uniqueIpsBlocked: 1234 };
    const prev = { requestsBlocked: 20, requestsSoftBlocked: 5, uniqueIpsBlocked: 0 };
    it('emits every key with its previous value and count format', () => {
        const rows = digestStats(cur, prev);
        expect(rows.map(r => r.key)).toEqual(['requestsBlocked', 'requestsSoftBlocked', 'uniqueIpsBlocked']);
        expect(rows[0]).toMatchObject({ value: 40, previous: 20, format: 'count' });
        expect(rows[1]).toMatchObject({ value: 0, previous: 5 });
    });
    it('keeps only non-zero figures, largest first, formatted', () => {
        expect(topRecentStats(cur)).toEqual([
            { label: 'distinct addresses blocked', value: '1,234' },
            { label: 'unwanted visits blocked', value: '40' },
        ]);
        expect(topRecentStats({ requestsBlocked: 0, requestsSoftBlocked: 0, uniqueIpsBlocked: 0 })).toEqual([]);
    });
});

describe('adminUrlFor / PREMIUM_FEATURES', () => {
    it('builds the extensions URL and tolerates trailing slashes or nothing', () => {
        expect(adminUrlFor('https://shop.example.com/')).toBe('https://shop.example.com/admin/extensions/geo-block');
        expect(adminUrlFor('')).toBeNull();
        expect(adminUrlFor(undefined)).toBeNull();
    });
    it('lists the five premium features (weekly report + checklist premium since 0.15.0)', () => {
        expect(PREMIUM_FEATURES).toHaveLength(5);
        expect(PREMIUM_FEATURES.join(' ')).toMatch(/Weekly e-mail report/);
    });
});
