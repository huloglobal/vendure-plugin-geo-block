/**
 * Pure building blocks for the Geo Block engagement features: stat keys
 * and labels, the set-up checks, report rows and the banner summary.
 * No imports from the plugin module, so tests (and anything else) can
 * load this file in any order.
 */
import { DigestStat, DigestTip, formatStat } from '@huloglobal/vendure-licence-sdk';

export const SHORT_ID = 'vendure-plugin-geo-block';
export const PLUGIN_DISPLAY_NAME = 'Geo Block';
export const ADMIN_ROUTE = 'geo-block';

/** What the free tier loses — shown to trial/free installs and in the report. */
export const PREMIUM_FEATURES: string[] = [
    'All 37 region presets and subdivisions',
    'Soft-block (show a notice instead of a wall)',
    'Audit log and blocked-traffic stats',
    'Simulate rules before going live',
    'Weekly e-mail report and set-up checklist',
];


/** The numbers reported to the licence server and used by the report. */
export interface GeoStats {
    requestsBlocked: number;
    requestsSoftBlocked: number;
    uniqueIpsBlocked: number;
}

export const STAT_LABELS: Record<keyof GeoStats, string> = {
    requestsBlocked: 'unwanted visits blocked',
    requestsSoftBlocked: 'visitors shown the soft-block notice',
    uniqueIpsBlocked: 'distinct addresses blocked',
};


export interface SetupItem {
    key: string;
    label: string;
    done: boolean;
    hint: string;
    tab?: string;
    url?: string;
}

/** The subset of a channel row the set-up checks look at. */
export interface ChannelSetupRow {
    enabled: boolean;
    allowedRegions: string[];
    extraAllowed: string[];
    blockedCountries: string[];
    ipAllowlist: string[];
    blockMessage: string;
    blockRedirectUrl: string;
    blockLogoUrl: string;
}

const num = (v: any): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Normalise one aggregate row (MySQL returns DECIMAL strings, PG floats). */
export function statsFromRow(row: any): GeoStats {
    return {
        requestsBlocked: num(row?.blocked),
        requestsSoftBlocked: num(row?.softBlocked),
        uniqueIpsBlocked: num(row?.uniqueIps),
    };
}

/** JSON array or comma list stored in a channel TEXT column → string[]. */
export function listFromColumn(raw: any): string[] {
    if (Array.isArray(raw)) return raw.filter(v => typeof v === 'string');
    if (typeof raw !== 'string' || !raw.length) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string');
    } catch { /* comma list */ }
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** The four set-up checks, in the order the landing page and the report
 *  tips show them. Pure — the service feeds it real channel rows. */
export function buildSetupItems(channels: ChannelSetupRow[], simulated: boolean): SetupItem[] {
    // Inverse of the admin page's first-run test: a channel counts as set up
    // once enforcement is on or any rule list has been filled in.
    const hasRules = channels.some(c =>
        c.enabled || c.allowedRegions.length > 0 || c.extraAllowed.length > 0 || c.blockedCountries.length > 0);
    const blockPage = channels.some(c => !!(c.blockMessage || c.blockRedirectUrl || c.blockLogoUrl));
    const allowlist = channels.some(c => c.ipAllowlist.length > 0);
    return [
        {
            key: 'rules', label: 'Set rules on a channel', done: hasRules, tab: 'rules',
            hint: 'Pick a region preset or a country list and switch enforcement on. Nothing is blocked until a channel is enabled.',
        },
        {
            key: 'block-page', label: 'Customise the block page', done: blockPage, tab: 'message',
            hint: 'Add your own message, a logo or a redirect so blocked visitors see your brand rather than the default notice.',
        },
        {
            key: 'allowlist', label: 'Allow-list your own IP', done: allowlist, tab: 'allowlist',
            hint: 'Add your office or VPN address so you can never lock yourself out while testing rules.',
        },
        {
            key: 'simulate', label: 'Run a simulation', done: simulated, tab: 'simulate',
            hint: 'Try a visitor from a blocked country in the Simulate tab before going live.',
        },
    ];
}

/** Report tips: the first three undone checklist items. */
export function tipsFromItems(items: SetupItem[], adminUrl: string | null): DigestTip[] {
    return items.filter(i => !i.done).slice(0, 3).map(i => ({
        title: i.label,
        body: i.hint,
        url: i.url || (adminUrl ? `${adminUrl}?tab=${i.tab || ''}` : undefined),
        linkLabel: 'Open in Admin',
    }));
}

/** Week-on-week report rows. */
export function digestStats(current: GeoStats, previous: GeoStats): DigestStat[] {
    return (Object.keys(STAT_LABELS) as Array<keyof GeoStats>).map(key => ({
        key, label: STAT_LABELS[key], value: current[key], previous: previous[key], format: 'count' as const,
    }));
}

/** Top `n` non-zero stats for the banner's "So far: …" line. */
export function topRecentStats(stats: GeoStats, n = 3): Array<{ label: string; value: string }> {
    return (Object.keys(STAT_LABELS) as Array<keyof GeoStats>)
        .map(key => ({ key, label: STAT_LABELS[key], value: stats[key] }))
        .filter(s => s.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, n)
        .map(s => ({ label: s.label, value: formatStat({ key: s.key, label: s.label, value: s.value, format: 'count' }) }));
}

/** `<publicBaseUrl>/admin/extensions/geo-block`, or null without a base URL. */
export function adminUrlFor(publicBaseUrl: string | undefined): string | null {
    const base = String(publicBaseUrl || '').trim().replace(/\/+$/, '');
    return base ? `${base}/admin/extensions/${ADMIN_ROUTE}` : null;
}
