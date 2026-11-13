/**
 * Merchant engagement for Geo Block: the usage numbers sent with the
 * evaluation ping / heartbeat, the Monday weekly report, the set-up
 * checklist on the admin landing page and the dashboard widget feed.
 *
 * Everything in here is fail-soft — a SQL or SMTP problem is logged and
 * never thrown into the host. Raw SQL goes through the SDK dialect
 * adapter so it runs on MariaDB/MySQL and Postgres alike.
 */
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Logger, ProcessContext, TransactionalConnection } from '@vendure/core';
import {
    adapterFor,
    composeDigest,
    describeLicence,
    DigestMail,
    EffectiveTier,
    formatStat,
    licenceLifecycleNotice,
    PluginPrefs,
    smtpTransportFromEnv,
    WeeklyDigest,
} from '@huloglobal/vendure-licence-sdk';
import { GeoBlockPlugin, getOptions } from './plugin';
import { effectiveSettings } from './settings';
import {
    ADMIN_ROUTE,
    adminUrlFor,
    buildSetupItems,
    ChannelSetupRow,
    digestStats,
    GeoStats,
    listFromColumn,
    PLUGIN_DISPLAY_NAME,
    PREMIUM_FEATURES,
    SetupItem,
    SHORT_ID,
    statsFromRow,
    tipsFromItems,
    topRecentStats,
} from './engagement-core';

export * from './engagement-core';

const loggerCtx = 'GeoBlockEngagement';

/**
 * The weekly report is a premium feature (licence or evaluation). The
 * scheduler keeps running so the report resumes the Monday after a licence
 * returns; while premium is off a tick sends nothing and moves no clock.
 * Settings and history are kept.
 */
export class PremiumWeeklyDigest extends WeeklyDigest {
    constructor(opts: ConstructorParameters<typeof WeeklyDigest>[0], private readonly premium: () => boolean) {
        super(opts);
    }

    async tick(now: Date = new Date()): Promise<boolean> {
        if (!this.premium()) return false;
        return super.tick(now);
    }
}
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ZERO_STATS: GeoStats = { requestsBlocked: 0, requestsSoftBlocked: 0, uniqueIpsBlocked: 0 };

@Injectable()
export class GeoBlockEngagementService implements OnApplicationBootstrap, OnModuleDestroy {
    readonly prefs: PluginPrefs;
    readonly digest: WeeklyDigest;

    constructor(private connection: TransactionalConnection, private processContext: ProcessContext) {
        this.prefs = new PluginPrefs((sql, params, opts) => this.query(sql, params, opts), SHORT_ID);
        this.digest = new PremiumWeeklyDigest({
            pluginId: SHORT_ID,
            pluginName: PLUGIN_DISPLAY_NAME,
            prefs: this.prefs,
            collect: (from, to) => this.collect(from, to),
            send: (to, mail) => this.send(to, mail),
            defaultRecipient: () => this.defaultRecipient(),
        }, () => GeoBlockPlugin.hasPremiumAccess());
    }

    async onApplicationBootstrap(): Promise<void> {
        await this.prefs.ensureTable();
        // Both processes ping the licence server; both get the same numbers.
        GeoBlockPlugin.setStatsProvider(() => this.evalStats());
        // The weekly clock runs on the worker only (multi-worker safe via CAS).
        if (this.processContext.isWorker) this.digest.start();
    }

    onModuleDestroy(): void {
        this.digest.stop();
    }

    private query(sql: string, params?: any[], opts?: any): Promise<any> {
        return adapterFor(this.connection.rawConnection).query(sql, params, opts);
    }

    // ── Stats ───────────────────────────────────────────────────────────

    /** Last-30-day usage numbers for the evaluation ping and heartbeat. */
    async evalStats(): Promise<Record<string, number>> {
        const now = new Date();
        const s = await this.statsBetween(new Date(now.getTime() - 30 * DAY_MS), now);
        return { ...s };
    }

    /** Block counts for `[from, to)` from the audit table. Zeros on failure. */
    async statsBetween(from: Date, to: Date): Promise<GeoStats> {
        try {
            const rows = await this.query(
                `SELECT SUM(CASE WHEN decision='block' THEN 1 ELSE 0 END) AS blocked,
                        SUM(CASE WHEN decision='soft-block' THEN 1 ELSE 0 END) AS softBlocked,
                        COUNT(DISTINCT ip) AS uniqueIps
                 FROM geo_block_event
                 WHERE \`createdAt\` >= ? AND \`createdAt\` < ?`,
                [from, to],
            );
            return statsFromRow(rows?.[0]);
        } catch (e: any) {
            Logger.warn(`geo-block stats query failed: ${e?.message}`, loggerCtx);
            return { ...ZERO_STATS };
        }
    }

    /** Top three non-zero 30-day figures, formatted for the licence banner. */
    async recentStats(): Promise<Array<{ label: string; value: string }>> {
        const now = new Date();
        return topRecentStats(await this.statsBetween(new Date(now.getTime() - 30 * DAY_MS), now));
    }

    // ── Set-up checklist ────────────────────────────────────────────────

    async setupItems(): Promise<SetupItem[]> {
        let channels: ChannelSetupRow[] = [];
        try {
            const rows = await this.query(
                `SELECT id, code,
                        COALESCE(\`customFieldsGeoblockenabled\`, false) AS geoBlockEnabled,
                        \`customFieldsGeoblockallowedregions\`           AS allowedRegions,
                        \`customFieldsGeoblockallowedcountries\`         AS extraAllowed,
                        \`customFieldsGeoblockblockedcountries\`         AS blockedCountries,
                        \`customFieldsGeoblockipallowlist\`              AS ipAllowlist,
                        \`customFieldsGeoblockblockmessage\`             AS blockMessage,
                        \`customFieldsGeoblockblockredirecturl\`         AS blockRedirectUrl,
                        \`customFieldsGeoblockblocklogourl\`             AS blockLogoUrl
                 FROM channel ORDER BY id`,
            );
            channels = (rows || []).map((r: any) => ({
                enabled: !!Number(r.geoBlockEnabled || 0),
                allowedRegions: listFromColumn(r.allowedRegions),
                extraAllowed: listFromColumn(r.extraAllowed),
                blockedCountries: listFromColumn(r.blockedCountries),
                ipAllowlist: listFromColumn(r.ipAllowlist),
                blockMessage: String(r.blockMessage || ''),
                blockRedirectUrl: String(r.blockRedirectUrl || ''),
                blockLogoUrl: String(r.blockLogoUrl || ''),
            }));
        } catch (e: any) {
            Logger.warn(`geo-block setup check failed: ${e?.message}`, loggerCtx);
        }
        const simulated = (await this.prefs.get('setup.simulated')) === '1';
        return buildSetupItems(channels, simulated);
    }

    /** Remembered when the admin runs the simulator successfully. */
    markSimulated(): Promise<void> {
        return this.prefs.set('setup.simulated', '1');
    }

    /** Trial-lead address the admin opted in with (report fallback recipient). */
    setLeadEmail(email: string): Promise<void> {
        return this.prefs.set('eval.leadEmail', email);
    }

    // ── Tier / lifecycle ────────────────────────────────────────────────

    /** Exactly what `licence/status` reports. */
    tier(): EffectiveTier {
        const licence = GeoBlockPlugin.getLicenceStatus();
        if (licence?.valid) return 'paid';
        return GeoBlockPlugin.getEvalState()?.active ? 'trial' : 'free';
    }

    notice() {
        return licenceLifecycleNotice(describeLicence(GeoBlockPlugin.getLicenceStatus()), GeoBlockPlugin.getEvalState(), SHORT_ID);
    }

    // ── Weekly report ───────────────────────────────────────────────────

    async collect(from: Date, to: Date) {
        const [current, previous, items] = await Promise.all([
            this.statsBetween(from, to),
            this.statsBetween(new Date(from.getTime() - WEEK_MS), from),
            this.setupItems(),
        ]);
        const adminUrl = adminUrlFor(getOptions().publicBaseUrl);
        return {
            stats: digestStats(current, previous),
            tips: tipsFromItems(items, adminUrl),
            tier: this.tier(),
            licence: describeLicence(GeoBlockPlugin.getLicenceStatus()),
            evalState: GeoBlockPlugin.getEvalState(),
            adminUrl,
            premiumFeatures: PREMIUM_FEATURES,
        };
    }

    /** This week's report rendered without sending (admin "Preview"). */
    async preview(): Promise<DigestMail> {
        const end = new Date();
        const start = new Date(end.getTime() - WEEK_MS);
        const partial = await this.collect(start, end);
        return composeDigest({ ...partial, pluginName: PLUGIN_DISPLAY_NAME, shortId: SHORT_ID, periodStart: start, periodEnd: end });
    }

    /** Geo Block has no mailer of its own: the SMTP_* env transport. */
    async send(to: string, mail: DigestMail): Promise<void> {
        const transport = smtpTransportFromEnv();
        if (!transport) {
            throw new Error('SMTP is not configured — set SMTP_SERVER (or SMTP_HOST), SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM on the host and install nodemailer');
        }
        await transport.sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
    }

    /** Merchant address, then the licence customer, then the trial lead. */
    async defaultRecipient(): Promise<string | null> {
        const own = String(effectiveSettings().supportEmail || '').trim();
        if (own) return own;
        const customer = describeLicence(GeoBlockPlugin.getLicenceStatus())?.customer;
        if (customer) return customer;
        return this.prefs.get('eval.leadEmail');
    }

    // ── Dashboard widget ────────────────────────────────────────────────

    async widget() {
        const premium = GeoBlockPlugin.hasPremiumAccess();
        const now = new Date();
        const s = premium ? await this.statsBetween(new Date(now.getTime() - 7 * DAY_MS), now) : null;
        const fmt = (n: number) => formatStat({ key: 'n', label: '', value: n, format: 'count' });
        return {
            tier: this.tier(),
            notice: this.notice(),
            stats: [
                { label: 'Blocked (7d)', value: s ? fmt(s.requestsBlocked) : '—' },
                { label: 'Soft-blocked (7d)', value: s ? fmt(s.requestsSoftBlocked) : '—' },
                { label: 'Unique IPs (7d)', value: s ? fmt(s.uniqueIpsBlocked) : '—' },
            ],
            route: `/extensions/${ADMIN_ROUTE}`,
        };
    }
}
