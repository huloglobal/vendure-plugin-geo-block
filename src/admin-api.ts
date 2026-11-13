/**
 * Vendure Admin API extensions for HULO Geo-block.
 *
 * Exposes the same operator capabilities as the REST controller but
 * through GraphQL so customers using the Vendure Admin API directly
 * (custom dashboards, codegen-generated TS clients, the Admin UI) get
 * strong typing and the standard Vendure auth + channel context.
 *
 * Storefront paths (/geo-block/check, /geo-block/site-config,
 * /geo-block/revoked.json) intentionally stay REST — they're
 * anonymous, high-frequency, and serve non-JSON in some cases. Mixing
 * those into the Shop API would add session/channel middleware to
 * every page-load with no value to anyone.
 */
import { Injectable } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { gql } from 'graphql-tag';
import { Allow, Ctx, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import { isLicensed, premiumFeatureError, adapterFor } from '@huloglobal/vendure-licence-sdk';
import {
    FREE_TIER_PRESET_KEYS,
    isAllowed,
    isFreeTierPreset,
    isIpOrCidr,
    REGION_PRESETS,
    resolveAllowedCountries,
} from './geo-regions';
import { sanitiseMaintenance, sanitiseSchedule } from './decision';
import { GeoBlockChannelRules } from './channel-rules';
import { GeoBlockPlugin } from './plugin';
import { channelPermitted } from './channel-access';

export const geoBlockAdminApiSchema = gql`
    type GeoBlockPreset {
        key: String!
        label: String!
        kind: String!
        description: String!
        countryCount: Int
        requiresLicence: Boolean!
    }

    type GeoBlockPresetList {
        tier: String!
        items: [GeoBlockPreset!]!
    }

    type GeoBlockChannelConfig {
        channelId: Int!
        channelToken: String!
        channelName: String
        enabled: Boolean!
        mode: String!
        allowedCountries: [String!]!
        blockedCountries: [String!]!
        allowedGbRegions: [String!]!
        regionPreset: String
        blockMessage: String
        blockRedirectUrl: String
        ipAllowlist: [String!]!
        "Business-hours schedule as JSON (null = none)."
        scheduleJson: String
        "This channel's maintenance window as JSON (null = none)."
        maintenanceJson: String
        "Server-side purchase enforcement (off by default)."
        enforcePurchases: Boolean!
        "True when the last save would have blocked every visitor, so the rules were left switched off."
        lockout: Boolean
    }

    type GeoBlockStatsTotals {
        totalEvents: Int!
        blocked: Int!
        softBlocked: Int!
        allowed: Int!
    }

    type GeoBlockStatsCountryRow {
        country: String!
        n: Int!
    }

    type GeoBlockStatsDayRow {
        day: String!
        n: Int!
    }

    type GeoBlockStats {
        days: Int!
        channelId: Int!
        totals: GeoBlockStatsTotals!
        topCountries: [GeoBlockStatsCountryRow!]!
        daily: [GeoBlockStatsDayRow!]!
    }

    type GeoBlockVerdict {
        allowed: Boolean!
        reason: String!
        mode: String!
    }

    input GeoBlockSaveChannelInput {
        channelToken: String!
        enabled: Boolean
        mode: String
        allowedCountries: [String!]
        blockedCountries: [String!]
        allowedGbRegions: [String!]
        regionPreset: String
        blockMessage: String
        blockRedirectUrl: String
        ipAllowlist: [String!]
        "JSON business-hours schedule; empty string clears it."
        scheduleJson: String
        "JSON maintenance window {startsAt, endsAt, allowedIps, message}; empty string clears it."
        maintenanceJson: String
        enforcePurchases: Boolean
    }

    input GeoBlockSimulateInput {
        channelToken: String!
        country: String
        region: String
    }

    extend type Query {
        geoBlockPresets: GeoBlockPresetList!
        geoBlockChannels: [GeoBlockChannelConfig!]!
        geoBlockStats(channelId: Int!, days: Int): GeoBlockStats!
    }

    extend type Mutation {
        geoBlockSaveChannel(input: GeoBlockSaveChannelInput!): GeoBlockChannelConfig!
        geoBlockSimulate(input: GeoBlockSimulateInput!): GeoBlockVerdict!
    }
`;

@Resolver()
@Injectable()
export class GeoBlockAdminResolver {
    constructor(private connection: TransactionalConnection, private rules: GeoBlockChannelRules) {}

    @Query()
    @Allow(Permission.ReadCatalog)
    geoBlockPresets(): { tier: string; items: any[] } {
        const licensed = GeoBlockPlugin.hasPremiumAccess();
        const annotated = REGION_PRESETS.map(p => ({
            ...p,
            requiresLicence: !FREE_TIER_PRESET_KEYS.includes(p.key),
        }));
        return {
            tier: licensed ? 'paid' : 'free',
            items: licensed
                ? annotated
                : annotated.filter(p => FREE_TIER_PRESET_KEYS.includes(p.key)),
        };
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    async geoBlockChannels(@Ctx() ctx: RequestContext): Promise<any[]> {
        // Channel-scoped: only return the channels the caller can see.
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT id AS channelId, token AS channelToken, code AS channelName,
                    \`customFieldsGeoblockenabled\`          AS enabled,
                    \`customFieldsGeoblockmode\`             AS mode,
                    \`customFieldsGeoblockallowedcountries\` AS allowedCountries,
                    \`customFieldsGeoblockblockedcountries\` AS blockedCountries,
                    \`customFieldsGeoblockallowedgbregions\` AS allowedGbRegions,
                    \`customFieldsGeoblockallowedregions\`   AS regionPreset,
                    \`customFieldsGeoblockblockmessage\`     AS blockMessage,
                    \`customFieldsGeoblockblockredirecturl\` AS blockRedirectUrl,
                    \`customFieldsGeoblockipallowlist\`      AS ipAllowlist,
                    \`customFieldsGeoblockschedule\`         AS scheduleJson,
                    \`customFieldsGeoblockmaintenance\`      AS maintenanceJson,
                    \`customFieldsGeoblockenforcepurchases\` AS enforcePurchases
             FROM channel`,
            [],
        );
        return rows.filter((r: any) => channelPermitted(ctx, { id: r.channelId }, [Permission.ReadCatalog])).map((r: any) => ({
            channelId: Number(r.channelId),
            channelToken: String(r.channelToken),
            channelName: r.channelName || null,
            enabled: !!r.enabled,
            mode: r.mode || 'block',
            allowedCountries: splitList(r.allowedCountries),
            blockedCountries: splitList(r.blockedCountries),
            allowedGbRegions: splitList(r.allowedGbRegions),
            regionPreset: splitList(r.regionPreset)[0] || null,
            blockMessage: r.blockMessage || null,
            blockRedirectUrl: r.blockRedirectUrl || null,
            ipAllowlist: splitList(r.ipAllowlist),
            scheduleJson: r.scheduleJson || null,
            maintenanceJson: r.maintenanceJson || null,
            enforcePurchases: !!Number(r.enforcePurchases || 0),
        }));
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    async geoBlockStats(
        @Ctx() ctx: RequestContext,
        @Args('channelId') channelId: number,
        @Args('days') daysInput?: number,
    ): Promise<any> {
        if (!GeoBlockPlugin.hasPremiumAccess()) {
            throw new Error(premiumFeatureError('vendure-plugin-geo-block').message);
        }
        if (!channelPermitted(ctx, { id: channelId }, [Permission.ReadCatalog])) throw new Error('channel not found');
        const days = Math.min(Math.max(Number(daysInput) || 30, 1), 365);
        const where = `\`channelId\` = ? AND \`createdAt\` >= DATE_SUB(NOW(), INTERVAL ? DAY)`;
        const params = [channelId, days];
        const totals = await adapterFor(this.connection.rawConnection).query(
            `SELECT COUNT(*) AS totalEvents,
                    SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END)      AS blocked,
                    SUM(CASE WHEN decision = 'soft-block' THEN 1 ELSE 0 END) AS softBlocked,
                    SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END)      AS allowed
             FROM geo_block_event WHERE ${where}`,
            params,
        );
        const topCountries = await adapterFor(this.connection.rawConnection).query(
            `SELECT country, COUNT(*) AS n FROM geo_block_event WHERE ${where}
             GROUP BY country ORDER BY n DESC LIMIT 20`,
            params,
        );
        const daily = await adapterFor(this.connection.rawConnection).query(
            `SELECT DATE(\`createdAt\`) AS day, COUNT(*) AS n FROM geo_block_event WHERE ${where}
             GROUP BY DATE(\`createdAt\`) ORDER BY day`,
            params,
        );
        const t = (totals as any[])[0] || {};
        return {
            days,
            channelId,
            totals: {
                totalEvents: Number(t.totalEvents) || 0,
                blocked: Number(t.blocked) || 0,
                softBlocked: Number(t.softBlocked) || 0,
                allowed: Number(t.allowed) || 0,
            },
            topCountries: topCountries.map((r: any) => ({ country: r.country || 'XX', n: Number(r.n) })),
            daily: daily.map((r: any) => ({ day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day), n: Number(r.n) })),
        };
    }

    @Mutation()
    @Allow(Permission.UpdateCatalog)
    async geoBlockSaveChannel(@Ctx() ctx: RequestContext, @Args('input') input: any): Promise<any> {
        if (!input?.channelToken) throw new Error('channelToken required');
        // The input names the channel: require UpdateCatalog in THAT channel.
        if (!channelPermitted(ctx, { token: String(input.channelToken) }, [Permission.UpdateCatalog])) throw new Error('channel not found');
        const existingRows = await adapterFor(this.connection.rawConnection).query(
            `SELECT \`customFieldsGeoblockenabled\`          AS enabled,
                    \`customFieldsGeoblockallowedregions\`   AS allowedRegions,
                    \`customFieldsGeoblockallowedcountries\` AS allowedCountries,
                    \`customFieldsGeoblockblockedcountries\` AS blockedCountries
             FROM channel WHERE token = ?`,
            [input.channelToken],
        );
        const existing = (existingRows as any[])[0];
        if (!existing) throw new Error('channel not found');
        const set: string[] = [];
        const params: any[] = [];
        const cleanList = (val: any[], valid?: (x: string) => boolean): string[] => {
            const out = Array.from(new Set(val.filter((x: any) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean).slice(0, 500)));
            const bad = valid ? out.filter(x => !valid(x)) : [];
            if (bad.length) throw new Error(`Invalid value(s): ${bad.slice(0, 5).join(', ')}`);
            return out;
        };
        // Same columns and JSON-array storage as the REST save route (the two used to disagree).
        const push = (col: string, val: any) => {
            if (val === undefined) return;
            set.push(`\`${col}\` = ?`);
            params.push(Array.isArray(val) ? JSON.stringify(val) : val);
        };
        const isCountry = (x: string) => /^[A-Z]{2}$/.test(x);
        let regionList: string[] | undefined;
        if (input.regionPreset !== undefined) {
            const key = input.regionPreset ? String(input.regionPreset).toUpperCase() : '';
            if (key && key !== 'WORLDWIDE' && !REGION_PRESETS.some(p => String(p.key).toUpperCase() === key)) throw new Error(`Unknown region preset ${key}`);
            // Free tier: 5 of the 37 presets — enforced here too, not only in the UI.
            // A preset already saved on this channel (while licensed) may stay.
            const saved = splitList(existing.allowedRegions).map(x => x.toUpperCase());
            if (key && !GeoBlockPlugin.hasPremiumAccess() && !isFreeTierPreset(key) && !saved.includes(key)) {
                throw new Error(premiumFeatureError('vendure-plugin-geo-block').message + ` (region preset ${key}; the free tier offers ${FREE_TIER_PRESET_KEYS.join(', ')})`);
            }
            regionList = key ? [key] : [];
        }
        const allowedCountries = input.allowedCountries === undefined || input.allowedCountries === null ? undefined : cleanList(input.allowedCountries.map((c: string) => String(c).toUpperCase()), isCountry);
        const blockedCountries = input.blockedCountries === undefined || input.blockedCountries === null ? undefined : cleanList(input.blockedCountries.map((c: string) => String(c).toUpperCase()), isCountry);
        // Lockout refusal: rules that would block every visitor are saved switched off.
        let enabled: boolean | undefined = input.enabled === undefined || input.enabled === null ? undefined : !!input.enabled;
        const finalEnabled = enabled ?? !!Number(existing.enabled || 0);
        const resolved = resolveAllowedCountries({
            regions: regionList ?? splitList(existing.allowedRegions),
            extraAllowed: allowedCountries ?? splitList(existing.allowedCountries),
            blocked: blockedCountries ?? splitList(existing.blockedCountries),
        });
        const lockout = finalEnabled && resolved.allowed !== null && resolved.allowed.length === 0;
        if (lockout) enabled = false;
        push('customFieldsGeoblockenabled', enabled);
        push('customFieldsGeoblockmode', input.mode === undefined || input.mode === null ? undefined : (input.mode === 'soft' ? 'soft' : 'block'));
        push('customFieldsGeoblockallowedcountries', allowedCountries);
        push('customFieldsGeoblockblockedcountries', blockedCountries);
        push('customFieldsGeoblockallowedgbregions', input.allowedGbRegions == null ? undefined : cleanList(input.allowedGbRegions.map((c: string) => String(c).toUpperCase())));
        push('customFieldsGeoblockallowedregions', regionList);
        push('customFieldsGeoblockblockmessage', input.blockMessage == null ? undefined : String(input.blockMessage).slice(0, 4000));
        push('customFieldsGeoblockblockredirecturl', input.blockRedirectUrl == null ? undefined : (/^https?:\/\/[^\s]+$/i.test(String(input.blockRedirectUrl)) ? String(input.blockRedirectUrl).slice(0, 2048) : ''));
        push('customFieldsGeoblockipallowlist', input.ipAllowlist == null ? undefined : cleanList(input.ipAllowlist.map((x: string) => String(x).toLowerCase()), isIpOrCidr));
        if (input.scheduleJson != null) {
            const sch = input.scheduleJson === '' ? null : sanitiseSchedule(JSON.parse(String(input.scheduleJson)));
            push('customFieldsGeoblockschedule', sch ? JSON.stringify(sch) : null);
        }
        if (input.maintenanceJson != null) {
            const m = input.maintenanceJson === '' ? null : sanitiseMaintenance(JSON.parse(String(input.maintenanceJson)), isIpOrCidr);
            push('customFieldsGeoblockmaintenance', m ? JSON.stringify(m) : null);
        }
        push('customFieldsGeoblockenforcepurchases', input.enforcePurchases == null ? undefined : !!input.enforcePurchases);
        if (!set.length) throw new Error('no fields to update');
        params.push(input.channelToken);
        await adapterFor(this.connection.rawConnection).query(
            `UPDATE channel SET ${set.join(', ')} WHERE token = ?`,
            params,
        );
        this.rules.invalidate(String(input.channelToken));
        const rows = await this.geoBlockChannels(ctx);
        const row = rows.find((r: any) => r.channelToken === input.channelToken);
        return row ? { ...row, lockout } : row;
    }

    @Mutation()
    @Allow(Permission.ReadCatalog)
    async geoBlockSimulate(@Ctx() ctx: RequestContext, @Args('input') input: any): Promise<any> {
        if (!GeoBlockPlugin.hasPremiumAccess()) {
            throw new Error(premiumFeatureError('vendure-plugin-geo-block').message);
        }
        if (!channelPermitted(ctx, { token: String(input?.channelToken || '') }, [Permission.ReadCatalog])) throw new Error('channel not found');
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT \`customFieldsGeoblockenabled\`          AS enabled,
                    \`customFieldsGeoblockallowedregions\`   AS allowedRegions,
                    \`customFieldsGeoblockallowedcountries\` AS allowedCountries,
                    \`customFieldsGeoblockblockedcountries\` AS blockedCountries,
                    \`customFieldsGeoblockallowedgbregions\` AS allowedGbRegions,
                    \`customFieldsGeoblockmode\`             AS mode
             FROM channel WHERE token = ?`,
            [input.channelToken],
        );
        const r = (rows as any[])[0];
        if (!r) throw new Error('channel not found');
        // Same resolution as /check and the REST simulator: presets + extra − blocked.
        const resolved = resolveAllowedCountries({
            regions: splitList(r.allowedRegions),
            extraAllowed: splitList(r.allowedCountries),
            blocked: splitList(r.blockedCountries),
        });
        const verdict = isAllowed(input.country || null, input.region || null, {
            enabled: !!Number(r.enabled || 0),
            allowedCountries: resolved.allowed,
            blockedCountries: resolved.blocked,
            allowedGbRegions: splitList(r.allowedGbRegions),
            allowedSubdivisions: {},
        });
        return { allowed: verdict.allowed, reason: verdict.reason, mode: r.mode || 'block' };
    }
}

/** List columns are stored as JSON arrays (by both save routes and by
 *  Vendure's own list custom fields); older rows may be comma-separated. */
function splitList(raw: any): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(v => typeof v === 'string');
    const text = String(raw).trim();
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string');
        } catch { /* fall through to CSV */ }
    }
    return text.split(',').map(s => s.trim()).filter(Boolean);
}
