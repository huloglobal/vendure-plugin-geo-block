/**
 * Loads one channel's geo-block rules (raw SQL through the SDK dialect
 * adapter, cached for 10 s) and applies the tier gate. Shared by the REST
 * controller and the purchase enforcement so both see the same rules.
 */
import { Injectable } from '@nestjs/common';
import { Channel, TransactionalConnection } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { resolveAllowedCountries } from './geo-regions';
import { BusinessHoursSchedule } from './schedule';
import { ChannelMaintenance, RulesForDecision } from './decision';

/** JSON.parse a value from a channel row's `text` field, tolerating
 *  null / empty. Returns null on any parse failure. */
export function parseJsonSafely<T = any>(raw: any): T | null {
    if (!raw) return null;
    if (typeof raw === 'object') return raw as T;
    try { return JSON.parse(String(raw)) as T; } catch { return null; }
}

export function parseSubdivisions(raw: any): Record<string, string[]> {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(raw)) {
            if (Array.isArray(v)) out[k.toUpperCase()] = v.filter(x => typeof x === 'string').map(x => x.toUpperCase());
        }
        return out;
    }
    if (typeof raw === 'string') {
        try { return parseSubdivisions(JSON.parse(raw)); } catch { return {}; }
    }
    return {};
}

export const parseList = (raw: any, fallback: string[] = []): string[] => {
    if (Array.isArray(raw)) return raw.filter(v => typeof v === 'string');
    if (typeof raw !== 'string' || !raw.length) return fallback;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string');
    } catch { /* comma-separated legacy value */ }
    return raw.split(',').map(s => s.trim()).filter(Boolean);
};

export function parseMaintenance(raw: any): ChannelMaintenance | null {
    const m = parseJsonSafely<ChannelMaintenance>(raw);
    if (!m || typeof m !== 'object' || !m.startsAt || !m.endsAt) return null;
    return {
        startsAt: String(m.startsAt),
        endsAt: String(m.endsAt),
        allowedIps: Array.isArray(m.allowedIps) ? m.allowedIps.filter(x => typeof x === 'string') : [],
        message: typeof m.message === 'string' ? m.message : undefined,
    };
}

export interface SiteConfig {
    channelToken: string;
    geoBlock: {
        enabled: boolean;
        mode: 'block' | 'soft';
        allowedCountries: string[] | null;
        blockedCountries: string[];
        allowedGbRegions: string[];
        allowedSubdivisions: Record<string, string[]>;
        allowedRegions: string[];
        blockMessage: string;
        blockRedirectUrl: string | null;
        blockLogoUrl: string | null;
    };
    companyData: {
        showCompanyNumber: boolean;
        companyNumber: string;
    };
}

export const DEFAULT_SITE_CONFIG: SiteConfig = {
    channelToken: '',
    geoBlock: {
        enabled: false,
        mode: 'block',
        allowedCountries: ['GB'],
        blockedCountries: [],
        allowedGbRegions: [],
        allowedSubdivisions: {},
        allowedRegions: [],
        blockMessage: '',
        blockRedirectUrl: null,
        blockLogoUrl: null,
    },
    companyData: { showCompanyNumber: false, companyNumber: '' },
};

/** An absolute http(s) URL (trimmed, at most 2048 characters), else null. */
export function safeHttpUrl(raw: any): string | null {
    const v = String(raw ?? '').trim();
    if (!v || v.length > 2048 || /[\s<>"'`\\]/.test(v)) return null;
    try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:' ? v : null;
    } catch {
        return null;
    }
}

/** Rules for one channel as the storefront and `/check` see them.
 *  Tier gate: unlicensed installs (evaluation expired) force `mode=block`
 *  (no soft-block banner) and ignore the saved subdivision map. The block
 *  decision itself still runs so the free tier genuinely enforces. */
export function buildConfig(token: string, r: any, premium: boolean): SiteConfig {
    const allowedRegions = parseList(r.allowedRegions);
    const extraAllowed = parseList(r.extraAllowed, ['GB']);
    const blockedCountries = parseList(r.blockedCountries);
    const resolved = resolveAllowedCountries({ regions: allowedRegions, extraAllowed, blocked: blockedCountries });
    return {
        channelToken: token,
        geoBlock: {
            enabled: !!Number(r.geoBlockEnabled || 0),
            mode: (premium && r.geoBlockMode === 'soft' ? 'soft' : 'block'),
            allowedCountries: resolved.allowed,
            blockedCountries: resolved.blocked,
            // No default UK regions — hidden unless explicitly configured.
            allowedGbRegions: parseList(r.allowedGbRegions, []),
            allowedSubdivisions: premium ? parseSubdivisions(r.allowedSubdivisionsJson) : {},
            allowedRegions,
            blockMessage: String(r.blockMessage || ''),
            // The channel custom fields can also be edited in the standard
            // Channel form, which does not validate them: only http(s) URLs
            // ever reach the storefront helper (redirect / banner link) or
            // the block page, never `javascript:` or `data:`.
            blockRedirectUrl: safeHttpUrl(r.blockRedirectUrl),
            blockLogoUrl: safeHttpUrl(r.blockLogoUrl),
        },
        companyData: {
            showCompanyNumber: !!Number(r.showCompanyNumber || 0),
            companyNumber: String(r.companyNumber || ''),
        },
    };
}

/** Everything `decide()` needs for one channel row. */
export function rulesFromRow(token: string, row: any, premium: boolean): RulesForDecision {
    const g = buildConfig(token, row, premium).geoBlock;
    return {
        ...g,
        ipAllowlist: parseList(row.ipAllowlist || ''),
        schedule: parseJsonSafely<BusinessHoursSchedule>(row.schedule),
        maintenance: parseMaintenance(row.maintenance),
    };
}

@Injectable()
export class GeoBlockChannelRules {
    /** Channel rules change rarely; `/check`, `/site-config`, `/blocked` and
     *  every add-to-order read them. */
    private rowCache = new Map<string, { row: any; exp: number }>();
    private static readonly ROW_TTL_MS = 10_000;

    constructor(private connection: TransactionalConnection) {}

    async load(token: string): Promise<any | null> {
        const hit = this.rowCache.get(token);
        if (hit && hit.exp > Date.now()) return hit.row;
        const row = await this.loadUncached(token);
        if (this.rowCache.size > 200) this.rowCache.clear();
        this.rowCache.set(token, { row, exp: Date.now() + GeoBlockChannelRules.ROW_TTL_MS });
        return row;
    }

    invalidate(token: string): void {
        this.rowCache.delete(String(token));
    }

    /** `companyData` comes from Channel custom fields the HOST may define
     *  (`showCompanyNumber`, `businessCompanyNumber`); this plugin does not
     *  register them, so they are only selected when they exist. */
    private companyCols: string | null = null;
    private companyColumns(): string {
        if (this.companyCols !== null) return this.companyCols;
        let cols = '';
        try {
            const meta = this.connection.rawConnection.getMetadata(Channel);
            const show = meta.findColumnWithPropertyPath('customFields.showCompanyNumber');
            const num = meta.findColumnWithPropertyPath('customFields.businessCompanyNumber');
            if (show) cols += `\`${show.databaseName}\` AS showCompanyNumber,\n`;
            if (num) cols += `\`${num.databaseName}\` AS companyNumber,\n`;
        } catch { cols = ''; }
        this.companyCols = cols;
        return cols;
    }

    async loadUncached(token: string): Promise<any | null> {
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT id, token,
                    ${this.companyColumns()}
                    \`customFieldsGeoblockenabled\`             AS geoBlockEnabled,
                    \`customFieldsGeoblockmode\`                AS geoBlockMode,
                    \`customFieldsGeoblockallowedregions\`      AS allowedRegions,
                    \`customFieldsGeoblockallowedcountries\`    AS extraAllowed,
                    \`customFieldsGeoblockblockedcountries\`    AS blockedCountries,
                    \`customFieldsGeoblockallowedgbregions\`    AS allowedGbRegions,
                    \`customFieldsGeoblockallowedsubdivisions\` AS allowedSubdivisionsJson,
                    \`customFieldsGeoblockipallowlist\`         AS ipAllowlist,
                    \`customFieldsGeoblockblockmessage\`        AS blockMessage,
                    \`customFieldsGeoblockblockredirecturl\`    AS blockRedirectUrl,
                    \`customFieldsGeoblockblocklogourl\`        AS blockLogoUrl,
                    \`customFieldsGeoblockschedule\`            AS schedule,
                    \`customFieldsGeoblockmaintenance\`         AS maintenance,
                    \`customFieldsGeoblockenforcepurchases\`    AS enforcePurchases
             FROM channel WHERE token = ? LIMIT 1`,
            [token],
        );
        return rows[0] || null;
    }
}
