import { Body, Controller, Get, OnApplicationBootstrap, OnModuleDestroy, Post, Query, Req, Res } from '@nestjs/common';
import {
    applySecurityHeaders,
    hashIp,
    isLicensed,
    premiumFeatureError,
    RateLimiter,
    startRetentionSweeper,
    verifySignedValue, LicenceStore, performSelfUpdate, selfUpdateEnv, adapterFor, PurchaseClaimClient, evalInstanceId, describeLicence } from '@huloglobal/vendure-licence-sdk';
import { Channel, Ctx, Logger, Permission, ProcessContext, RequestContext, TransactionalConnection } from '@vendure/core';
import { Request, Response } from 'express';
import { GeoBlockEvent } from './geo-block-event.entity';
import { SUBDIVISIONS, hasSubdivisions } from './subdivisions';
import {
    isAllowed,
    ipMatchesAny,
    FREE_TIER_PRESET_KEYS,
    REGION_PRESETS,
    presetCountries,
    resolveAllowedCountries,
} from './geo-regions';
import { ensureStoredSecret } from './stored-secret';
import { channelPermitted, isSuperAdmin, permittedChannelIds } from './channel-access';
import { GeoBlockPlugin, getOptions } from './plugin';
import { getRealIp, getResolvedCountry, getResolvedRegion, normaliseIp } from './proxy-headers';
import { isAllowlistedBot, matchedBotEntry } from './bot-detect';
import { BusinessHoursSchedule, checkSchedule } from './schedule';
import { buildHuloGeoJs, buildBlockedPageHtml } from './storefront-assets';
import { GeoBlockEngagementService, PREMIUM_FEATURES } from './engagement';

const PLUGIN_ID_FOR_STORE = 'vendure-plugin-geo-block';
const IP_SALT_STORE_KEY = 'vendure-plugin-geo-block:ipsalt';
const LEGACY_IP_SALT = 'hulo-geo-block-default-salt';

const loggerCtx = 'GeoBlockController';

/** Per-install audit-IP salt resolved at boot when `ipSalt` is not configured (cached per process). */
let generatedIpSalt: string | null = null;

/** JSON.parse a value from a channel row's `text` field, tolerating
 *  null / empty. Returns null on any parse failure. */
function parseJsonSafely<T = any>(raw: any): T | null {
    if (!raw) return null;
    if (typeof raw === 'object') return raw as T;
    try { return JSON.parse(String(raw)) as T; } catch { return null; }
}

/** Minimal HTML-escape for user-supplied text going into the block
 *  page template. */
function escapeHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function requireAdmin(ctx: RequestContext, res: Response, write: boolean | 'super' = false): boolean {
    if (!ctx?.activeUserId) {
        res.status(401).json({ error: 'Authentication required' });
        return false;
    }
    // 'super': self-update and licence changes affect the whole install.
    const needed = write === 'super' ? [Permission.SuperAdmin] : write ? [Permission.UpdateCatalog] : [Permission.ReadCatalog];
    if (!ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    return true;
}

interface SiteConfig {
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

const DEFAULTS: SiteConfig = {
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

function parseSubdivisions(raw: any): Record<string, string[]> {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(raw)) {
            if (Array.isArray(v)) out[k.toUpperCase()] = v.filter(x => typeof x === 'string').map(x => x.toUpperCase());
        }
        return out;
    }
    if (typeof raw === 'string') {
        try {
            return parseSubdivisions(JSON.parse(raw));
        } catch {
            return {};
        }
    }
    return {};
}

const parseList = (raw: any, fallback: string[] = []): string[] => {
    if (Array.isArray(raw)) return raw.filter(v => typeof v === 'string');
    if (typeof raw !== 'string' || !raw.length) return fallback;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string');
    } catch {}
    return raw.split(',').map(s => s.trim()).filter(Boolean);
};

/**
 * Public + admin endpoints for the storefront geo-block.
 *
 *  Public:
 *    GET  /geo-block/site-config       — channel-aware rules the storefront caches
 *    GET  /geo-block/check             — per-request decision (with logging)
 *    GET  /geo-block/presets           — preset catalogue for the storefront banner
 *
 *  Admin:
 *    GET  /geo-block/admin/channels    — all channels + their rules
 *    POST /geo-block/admin/save        — save one channel's rules
 *    GET  /geo-block/admin/stats       — block totals + top blocked countries
 *    POST /geo-block/admin/simulate    — "what would happen if a visitor from X visited?"
 *    POST /geo-block/admin/gc          — prune old GeoBlockEvent rows
 *    GET  /geo-block/setup             — set-up checklist for the landing page
 *    GET  /geo-block/widget            — dashboard widget feed (7-day figures)
 *    GET/POST /geo-block/digest/*      — weekly report settings, test send, preview
 */
@Controller('geo-block')
export class GeoBlockController implements OnApplicationBootstrap, OnModuleDestroy {
    private limiter: RateLimiter | null = null;
    private stopRetention: (() => void) | null = null;
    /** Channel rules change rarely; `/check`, `/site-config` and `/blocked` read them per page view. */
    private rowCache = new Map<string, { row: any; exp: number }>();
    private static readonly ROW_TTL_MS = 10_000;

    constructor(
        private connection: TransactionalConnection,
        private processContext: ProcessContext,
        private engagement: GeoBlockEngagementService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const opts = getOptions();
        const rl = opts.rateLimit || { capacity: 120, windowMs: 60_000 };
        this.limiter = new RateLimiter({ capacity: rl.capacity, windowMs: rl.windowMs });
        await this.resolveIpSalt();
        // Only the server answers HTTP; the worker must not run a second sweeper / claim poller.
        if (this.processContext.isWorker) return;
        void this.purchaseClaimClient().resume();
        if (!opts.signingSecret) Logger.warn('geo-block: no signingSecret — the ?country= override on /check is only honoured when it is a plain ISO code and nothing can verify who sent it', loggerCtx);
        const retention = opts.retention === false ? null : (opts.retention || { days: 90, maxRows: 500_000 });
        if (retention) {
            this.stopRetention = startRetentionSweeper({
                getConnection: () => adapterFor(this.connection.rawConnection),
                table: 'geo_block_event',
                options: retention,
                label: 'geo-block',
            });
        }
    }

    onModuleDestroy(): void {
        this.stopRetention?.();
        this.stopRetention = null;
    }

    /** Without `ipSalt`, every install used to hash audit IPs with the same
     *  public constant, so a hash could be matched against a candidate address.
     *  Generate a random salt once, persist it next to the licence key, and
     *  reuse it in every process (server and worker read the same row). */
    private async resolveIpSalt(): Promise<void> {
        if (getOptions().ipSalt || generatedIpSalt) return;
        const salt = await ensureStoredSecret(
            this.licenceStore,
            (sql, params, o) => adapterFor(this.connection.rawConnection).query(sql, params, o),
            IP_SALT_STORE_KEY,
        );
        if (salt) {
            generatedIpSalt = salt;
            Logger.warn(`geo-block: no ipSalt configured — audit IPs are hashed with a generated per-install salt stored in hulo_licence_store (${IP_SALT_STORE_KEY}); set ipSalt to keep hashes comparable across reinstalls`, loggerCtx);
        } else {
            Logger.warn('geo-block: no ipSalt configured and the licence store is unavailable — audit IPs are hashed with the built-in default salt', loggerCtx);
        }
    }

    private rateLimited(req: Request, res: Response, bucket: string): boolean {
        const ip = getRealIp(req, getOptions().trustedIpHeaders) || '';
        if (!ip || !this.limiter) return false;
        if (!this.limiter.allow(`${bucket}|${ip}`)) {
            res.setHeader('Retry-After', '60');
            res.status(429).json({ error: 'Too many requests' });
            return true;
        }
        return false;
    }


    private licenceStore = new LicenceStore((sql, params, opts) => adapterFor(this.connection.rawConnection).query(sql, params, opts));

    /** Licence/evaluation state for the admin banner. */
    @Get('licence/status')
    async licenceState(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const licence = GeoBlockPlugin.getLicenceStatus();
        const ev = GeoBlockPlugin.getEvalState();
        const updater = GeoBlockPlugin.getUpdateChecker();
        return res.json({
            licensed: !!licence?.valid,
            licence: describeLicence(licence),
            licenceMessage: licence?.valid ? '' : (licence?.message || 'No licence key configured'),
            tier: licence?.valid ? 'paid' : (ev?.active ? 'trial' : 'free'),
            eval: ev,
            pkg: PLUGIN_ID_FOR_STORE,
            update: updater ? updater.getStatus() : null,
            selfUpdate: selfUpdateEnv(),
            notice: this.engagement.notice(),
            premiumFeatures: PREMIUM_FEATURES,
            recentStats: await this.engagement.recentStats(),
        });
    }

    /** Admin opt-in: "email me before my evaluation ends". Proxied
     *  server-to-server to the HULO licence server, which sends a welcome
     *  email and runs the reminder drip. Explicit consent only — nothing is
     *  sent anywhere unless the admin submits an address. */
    @Post('eval/remind-me')
    async evalRemindMe(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const email = String(body?.email || '').trim().slice(0, 320);
        const instanceId = GeoBlockPlugin.getEvalInstanceId();
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || !instanceId) return res.status(400).json({ error: 'bad-request' });
        try {
            const base = (process.env.HULO_LICENCE_EVAL_URL || 'https://elite.charity/licence/eval/register').replace(/\/register$/, '');
            const resp = await fetch(`${base}/lead`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: GeoBlockPlugin.getPackageName(), instanceId, email }),
                signal: AbortSignal.timeout(8_000),
            });
            if (!resp.ok) return res.status(502).json({ error: 'upstream', status: resp.status });
            await this.engagement.setLeadEmail(email.toLowerCase());
            return res.json({ ok: true });
        } catch {
            return res.status(502).json({ error: 'unreachable' });
        }
    }

    // ── Weekly report ──────────────────────────────────────────────────
    @Get('digest/settings')
    async digestSettings(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        return res.json(await this.engagement.digest.settings());
    }

    @Post('digest/settings')
    async digestUpdateSettings(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const patch: { enabled?: boolean; recipient?: string | null } = {};
        if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
        if (body?.recipient !== undefined) patch.recipient = body.recipient === null ? null : String(body.recipient);
        try {
            return res.json(await this.engagement.digest.updateSettings(patch));
        } catch (e: any) {
            return res.status(400).json({ message: e?.message || 'Invalid settings' });
        }
    }

    @Post('digest/send-test')
    async digestSendTest(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const r = await this.engagement.digest.sendNow(String(body?.to || '').trim() || null);
        return res.json({ sent: r.sent, to: r.to, reason: r.reason, subject: r.preview.subject });
    }

    /** This week's report as HTML, for the admin page's Preview button. */
    @Get('digest/preview')
    async digestPreview(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const mail = await this.engagement.preview();
        applySecurityHeaders(res);
        res.type('text/html');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(mail.html);
    }

    /** Set-up checklist for the landing page (real checks, read-only). */
    @Get('setup')
    async setup(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const items = await this.engagement.setupItems();
        return res.json({ items, complete: items.every(i => i.done) });
    }

    /** Dashboard widget feed: tier, lifecycle notice and three 7-day figures. */
    @Get('widget')
    async widget(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        return res.json(await this.engagement.widget());
    }

    /** One-click in-app update (owner-approved feature): installs a
     *  registry-verified version of THIS plugin via the host's package
     *  manager and restarts under the process supervisor. Admin-only;
     *  package name is hard-coded; HULO_SELF_UPDATE=off disables. */
    @Post('update/run')
    async updateRun(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const updater = GeoBlockPlugin.getUpdateChecker();
        const target = String(body?.version || updater?.getStatus()?.latest || '').trim();
        if (!target) return res.status(400).json({ ok: false, message: 'No target version known yet — the registry check runs daily; try again shortly.' });
        const result = await performSelfUpdate({ packageName: '@huloglobal/vendure-plugin-geo-block', targetVersion: target });
        return res.status(result.ok ? 200 : 400).json(result);
    }

    /** Admin-UI licence activation: paste-a-key, verified with the exact
     *  boot-time checks, applied immediately and persisted. */
    @Post('licence/activate')
    async licenceActivate(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const key = String(body?.key || '').trim();
        if (!key) return res.status(400).json({ licensed: false, message: 'Paste your licence key first.' });
        const status = GeoBlockPlugin.activateRuntimeLicence(key);
        if (!status.valid) return res.status(400).json({ licensed: false, message: status.message || 'Invalid licence key.' });
        await this.licenceStore.ensureTable();
        await this.licenceStore.save(PLUGIN_ID_FOR_STORE, key);
        return res.json({ licensed: true, message: status.message });
    }

    /** Remove an admin-activated key (env-configured keys unaffected). */
    @Post('licence/deactivate')
    async licenceDeactivate(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, true)) return;
        await this.licenceStore.clear(PLUGIN_ID_FOR_STORE);
        GeoBlockPlugin.deactivateRuntimeLicence();
        return res.json({ licensed: false });
    }
    /** Buy-from-admin: mint a claim token and return the HULO buy-page
     *  URL. Once checkout completes the licence server binds the claim to
     *  the minted key and `licence/claim-status` installs it — no email
     *  round-trip, no .env edit, no restart. */
    @Post('licence/purchase-link')
    async licencePurchaseLink(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const plan = (['monthly', 'annual', 'lifetime'].includes(String(body?.plan)) ? String(body.plan) : 'annual') as 'monthly' | 'annual' | 'lifetime';
        try {
            const r = await this.purchaseClaimClient().createPurchaseLink(plan, String(body?.email || '').trim() || undefined);
            return res.json({ url: r.url, state: 'pending' });
        } catch (e: any) {
            return res.status(500).json({ message: e?.message || 'Could not start the purchase — try again shortly.' });
        }
    }

    /** Poll target for the admin page while a purchase is pending; with
     *  `?check=1` it asks the licence server right now and installs the
     *  key if it is ready. Installed claims are re-checked daily so a
     *  renewed subscription key lands automatically too. */
    @Get('licence/claim-status')
    async licenceClaimStatus(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('check') check?: string) {
        if (!requireAdmin(ctx, res, false)) return;
        const client = this.purchaseClaimClient();
        const st = check ? await client.checkNow() : await client.status();
        return res.json({ ...st, licensed: !!GeoBlockPlugin.getLicenceStatus()?.valid });
    }

    /** Stripe billing portal (update card, cancel, switch plan) for the
     *  subscription behind this install's licence. Ownership is proven by
     *  the buy-from-admin claim or by the stored licence key itself. */
    @Post('licence/portal-link')
    async licencePortalLink(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, true)) return;
        let storedKey: string | null = null;
        try { storedKey = await this.licenceStore.load(PLUGIN_ID_FOR_STORE); } catch { storedKey = null; }
        const url = await this.purchaseClaimClient().billingPortalUrl(storedKey);
        if (!url) return res.status(404).json({ message: 'No billing portal is available for this licence (lifetime and master licences have nothing to manage; for a key set via the environment, reply to your receipt email for a portal link).' });
        return res.json({ url });
    }

    /** Buy-from-admin auto-install client. */
    private purchaseClaim: PurchaseClaimClient | null = null;
    private purchaseClaimClient(): PurchaseClaimClient {
        if (!this.purchaseClaim) {
            this.purchaseClaim = new PurchaseClaimClient({
                packageName: GeoBlockPlugin.getPackageName(),
                instanceId: () => evalInstanceId(),
                query: (sql, params, opts) => adapterFor(this.connection.rawConnection).query(sql, params, opts),
                onLicence: async (key: string) => {
                    const status = GeoBlockPlugin.activateRuntimeLicence(key);
                    if (!status.valid) return false;
                    await this.licenceStore.ensureTable(); await this.licenceStore.save(PLUGIN_ID_FOR_STORE, key);
                    return true;
                },
            });
        }
        return this.purchaseClaim;
    }

    @Get('site-config')
    async getConfig(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SiteConfig | void> {
        applySecurityHeaders(res);
        if (this.rateLimited(req, res, 'site-config')) return;

        const headerToken = (req.headers['vendure-token'] as string)
            || (req.headers['x-vendure-token'] as string)
            || (req.query.token as string)
            || '';
        const token = headerToken.trim();
        if (!token) return { ...DEFAULTS };

        const row = await this.loadChannelRow(token);
        if (!row) return { ...DEFAULTS, channelToken: token };
        return this.buildConfig(token, row);
    }

    /**
     * Per-request decision endpoint. The storefront calls this on entry
     * (or middleware can call it) with optional `?country=` overrides.
     * Logs the decision so the admin stats panel shows top blocked
     * countries.
     *
     * Returns 200 with `{ allowed: boolean, reason, mode }` regardless —
     * the storefront decides whether to redirect or render a banner.
     */
    @Get('check')
    async check(@Req() req: Request, @Res() res: Response) {
        applySecurityHeaders(res);
        if (this.rateLimited(req, res, 'check')) return;

        const headerToken = (req.headers['vendure-token'] as string)
            || (req.headers['x-vendure-token'] as string)
            || (req.query.token as string)
            || '';
        const token = headerToken.trim();
        if (!token) return res.json({ allowed: true, reason: 'no-channel' });
        const row = await this.loadChannelRow(token);
        if (!row) return res.json({ allowed: true, reason: 'unknown-channel' });
        // `buildConfig` applies the tier gate (unlicensed: mode=block, no
        // subdivisions) so `/check` and the public `/site-config` agree.
        const cfg = this.buildConfig(token, row);
        const licensed = GeoBlockPlugin.hasPremiumAccess();

        const opts = getOptions();
        const ip = getRealIp(req, opts.trustedIpHeaders);
        res.setHeader('Cache-Control', 'no-store');

        // Country / region override: with a `signingSecret` both must carry
        // a matching signature; without one they are honoured only when they
        // look like plain ISO codes (legacy behaviour, warned about at boot).
        const queryCountry = String(req.query.country || '').trim().toUpperCase();
        const queryRegion = String(req.query.region || '').trim().toUpperCase();
        let overrideCountry: string | null = null;
        let overrideRegion: string | null = null;
        if (queryCountry && /^[A-Z]{2}$/.test(queryCountry)) {
            if (opts.signingSecret) {
                const sig = String(req.query.countrySig || '');
                const verified = verifySignedValue(`${queryCountry}.${sig}`, opts.signingSecret);
                if (verified === queryCountry) overrideCountry = queryCountry;
            } else {
                overrideCountry = queryCountry;
            }
        }
        if (queryRegion && /^[A-Z0-9]{1,4}$/.test(queryRegion)) {
            if (opts.signingSecret) {
                const sig = String(req.query.regionSig || '');
                const verified = verifySignedValue(`${queryRegion}.${sig}`, opts.signingSecret);
                if (verified === queryRegion) overrideRegion = queryRegion;
            } else {
                overrideRegion = queryRegion;
            }
        }
        const country = overrideCountry || getResolvedCountry(req, opts.trustedCountryHeaders) || null;
        const region = overrideRegion || getResolvedRegion(req, opts.trustedCountryHeaders) || null;
        const referer = String(req.headers.referer || '').slice(0, 2048);

        const allowlist = parseList(row.ipAllowlist || '');
        const channelId = Number(row.id) || 1;
        const ua = String(req.headers['user-agent'] || '');

        // 1. IP allowlist trumps everything else.
        if (ipMatchesAny(ip, allowlist)) {
            return res.json({ allowed: true, reason: 'ip-allowlist', mode: cfg.geoBlock.mode });
        }
        // 1b. SEO / social crawler allowlist. Runs before geo rules
        //     so Googlebot etc. don't get blocked and de-index the
        //     site silently. Configurable via `botAllowlist` plugin
        //     option — default `'strict'` (well-known SEO + social
        //     bots only).
        if (isAllowlistedBot(ua, opts.botAllowlist ?? 'strict')) {
            return res.json({ allowed: true, reason: 'bot-allowlist', mode: cfg.geoBlock.mode });
        }
        // 1c. Business-hours schedule (per-channel). Kicks in
        //     regardless of country when configured. IP allowlist
        //     + bot allowlist still bypass this — office IPs and
        //     search crawlers should never see "closed for orders".
        const schedule = parseJsonSafely<BusinessHoursSchedule>(row.schedule);
        const sv = checkSchedule(schedule);
        if (!sv.inHours && sv.action) {
            const effectiveMode = licensed
                ? (sv.action === 'soft' ? 'soft' : 'block')
                : 'block';
            void this.logEvent({
                channelId, country, region, ip,
                ua, url: referer,
                decision: effectiveMode === 'soft' ? 'soft-block' : 'block',
                reason: 'schedule',
            });
            return res.json({
                allowed: false,
                reason: 'schedule',
                mode: effectiveMode,
                message: sv.message,
                redirectUrl: cfg.geoBlock.blockRedirectUrl,
                logoUrl: cfg.geoBlock.blockLogoUrl,
            });
        }
        // 2. Scheduled maintenance window.
        if (opts.maintenanceWindow && inWindow(opts.maintenanceWindow) && !ipMatchesAny(ip, opts.maintenanceWindow.allowedIps || [])) {
            void this.logEvent({
                channelId, country, region, ip,
                ua: req.headers['user-agent'] as string,
                url: referer,
                decision: cfg.geoBlock.mode === 'soft' ? 'soft-block' : 'block',
                reason: 'maintenance',
            });
            return res.json({
                allowed: false,
                reason: 'maintenance',
                mode: cfg.geoBlock.mode,
                message: cfg.geoBlock.blockMessage || 'The site is temporarily unavailable. Please try again later.',
                redirectUrl: cfg.geoBlock.blockRedirectUrl,
            });
        }
        // 3. Channel rules.
        const verdict = isAllowed(country, region, {
            enabled: cfg.geoBlock.enabled,
            allowedCountries: cfg.geoBlock.allowedCountries,
            blockedCountries: cfg.geoBlock.blockedCountries,
            allowedGbRegions: cfg.geoBlock.allowedGbRegions,
            allowedSubdivisions: cfg.geoBlock.allowedSubdivisions,
        });
        if (!verdict.allowed) {
            void this.logEvent({
                channelId, country, region, ip,
                ua: req.headers['user-agent'] as string,
                url: referer,
                decision: cfg.geoBlock.mode === 'soft' ? 'soft-block' : 'block',
                reason: verdict.reason,
            });
            return res.json({
                allowed: false,
                reason: verdict.reason,
                mode: cfg.geoBlock.mode,
                message: cfg.geoBlock.blockMessage || this.defaultMessage(verdict.reason),
                redirectUrl: cfg.geoBlock.blockRedirectUrl,
                logoUrl: cfg.geoBlock.blockLogoUrl,
            });
        }
        return res.json({ allowed: true, reason: verdict.reason, mode: cfg.geoBlock.mode });
    }

    /** Catalogue of available region presets — fed to the admin picker
     * and any storefront that wants to show "we serve <X>". */
    @Get('presets')
    presets(@Res() res: Response) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const licensed = GeoBlockPlugin.hasPremiumAccess();
        // Unlicensed callers get only the 5 free-tier presets. Each
        // preset is also annotated with `requiresLicence` so the admin
        // UI can show a small lock icon next to gated rows.
        // `countries` lets the admin UI resolve the allow-list live while editing.
        const presets = REGION_PRESETS.map(p => ({
            ...p,
            countries: presetCountries(p.key),
            requiresLicence: !FREE_TIER_PRESET_KEYS.includes(p.key),
        }));
        return res.json({
            presets: licensed
                ? presets
                : presets.filter(p => FREE_TIER_PRESET_KEYS.includes(p.key)),
            tier: licensed ? 'paid' : 'free',
        });
    }

    /** Catalogue of country subdivisions. Lets the admin UI show a
     *  picker for any allowed country that has known subdivisions
     *  (US states, CA provinces, AU states, DE Länder, etc.). */
    @Get('subdivisions')
    subdivisions(@Res() res: Response) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (!GeoBlockPlugin.hasPremiumAccess()) {
            // Subdivision-level blocking is paid-only. Returning an
            // empty map keeps the admin UI's picker silent rather
            // than showing options that won't actually be honoured.
            return res.json({ subdivisions: {} });
        }
        return res.json({ subdivisions: SUBDIVISIONS });
    }

    /** Admin: plugin health + update availability. Read by the admin UI
     * banner so the operator sees when a new version is on npm. */
    @Get('status')
    async status(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const updater = GeoBlockPlugin.getUpdateChecker();
        const update = updater ? updater.getStatus() : null;
        return res.json({
            packageName: GeoBlockPlugin.getPackageName(),
            version: GeoBlockPlugin.getPackageVersion(),
            update,
            uptimeSec: Math.round(process.uptime()),
        });
    }

    @Get('admin/channels')
    async listChannels(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT id, code, token,
                    COALESCE(\`customFieldsGeoblockenabled\`, false) AS geoBlockEnabled,
                    \`customFieldsGeoblockmode\`                       AS geoBlockMode,
                    \`customFieldsGeoblockallowedregions\`             AS allowedRegions,
                    \`customFieldsGeoblockallowedcountries\`           AS extraAllowed,
                    \`customFieldsGeoblockblockedcountries\`           AS blockedCountries,
                    \`customFieldsGeoblockallowedgbregions\`           AS allowedGbRegions,
                    \`customFieldsGeoblockallowedsubdivisions\`        AS allowedSubdivisionsJson,
                    \`customFieldsGeoblockipallowlist\`                AS ipAllowlist,
                    \`customFieldsGeoblockblockmessage\`               AS blockMessage,
                    \`customFieldsGeoblockblockredirecturl\`           AS blockRedirectUrl,
                    \`customFieldsGeoblockblocklogourl\`               AS blockLogoUrl
             FROM channel
             ORDER BY id`,
        );
        // Only the channels this administrator may read (tokens + IP allowlists are sensitive).
        const visible = rows.filter((r: any) => channelPermitted(ctx, { id: r.id }, [Permission.ReadCatalog]));
        const result = visible.map((r: any) => {
            const allowedRegions = parseList(r.allowedRegions);
            const extraAllowed = parseList(r.extraAllowed);
            const blockedCountries = parseList(r.blockedCountries);
            const resolved = resolveAllowedCountries({
                regions: allowedRegions,
                extraAllowed,
                blocked: blockedCountries,
            });
            return {
                id: r.id,
                code: r.code,
                token: r.token,
                enabled: !!Number(r.geoBlockEnabled || 0),
                mode: (r.geoBlockMode || 'block') as 'block' | 'soft',
                allowedRegions,
                extraAllowed,
                blockedCountries,
                allowedGbRegions: parseList(r.allowedGbRegions),
                allowedSubdivisions: parseSubdivisions(r.allowedSubdivisionsJson),
                ipAllowlist: parseList(r.ipAllowlist),
                blockMessage: r.blockMessage || '',
                blockRedirectUrl: r.blockRedirectUrl || '',
                blockLogoUrl: r.blockLogoUrl || '',
                resolved: { allowedCountries: resolved.allowed, blockedCountries: resolved.blocked },
            };
        });
        return res.json({ channels: result });
    }

    @Post('admin/save')
    async saveChannel(@Ctx() ctx: RequestContext, @Body() body: any, @Res() res: Response) {
        if (!requireAdmin(ctx, res, true)) return;
        if (!body?.token || typeof body.token !== 'string') {
            return res.status(400).json({ error: 'channel token required' });
        }
        // The body names the channel: the caller must hold UpdateCatalog in THAT channel,
        // not just in the one its vendure-token header selects.
        if (!channelPermitted(ctx, { token: body.token }, [Permission.UpdateCatalog])
            || !(await this.loadChannelRowUncached(body.token))) {
            return res.status(404).json({ error: 'channel not found' });
        }
        // Validate what goes into the TEXT columns: bounded lists of known
        // codes, parseable IPs/CIDRs (no /0 footgun), http(s) URLs only —
        // a `javascript:` redirect would run in the storefront helper.
        const rejected: string[] = [];
        const normList = (v: any, valid?: (x: string) => boolean): string => {
            if (!Array.isArray(v)) return '[]';
            const clean = v.filter(x => typeof x === 'string').map(x => x.trim().toUpperCase()).filter(Boolean).slice(0, 500);
            const kept = valid ? clean.filter(x => { const ok = valid(x); if (!ok) rejected.push(x); return ok; }) : clean;
            return JSON.stringify(Array.from(new Set(kept)));
        };
        const isCountry = (x: string) => /^[A-Z]{2}$/.test(x);
        const isPreset = (x: string) => x === 'WORLDWIDE' || REGION_PRESETS.some(p => String(p.key).toUpperCase() === x);
        const isIpOrCidr = (x: string) => {
            const [base, bits] = x.split('/');
            const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(base) && base.split('.').every(o => Number(o) <= 255);
            const v6 = /^[0-9a-f:]+$/i.test(base) && base.includes(':');
            if (!v4 && !v6) return false;
            if (bits === undefined) return true;
            const n = Number(bits);
            return Number.isInteger(n) && n >= 8 && n <= (v4 ? 32 : 128);
        };
        const normIpList = (v: any): string => {
            if (!Array.isArray(v)) return '[]';
            const clean = v.filter(x => typeof x === 'string').map(x => x.trim().toLowerCase()).filter(Boolean).slice(0, 500);
            const kept = clean.filter(x => { const ok = isIpOrCidr(x); if (!ok) rejected.push(x); return ok; });
            return JSON.stringify(Array.from(new Set(kept)));
        };
        const httpUrl = (v: any): string => {
            const u = String(v || '').trim().slice(0, 2048);
            if (!u) return '';
            if (!/^https?:\/\/[^\s]+$/i.test(u)) { rejected.push(u); return ''; }
            return u;
        };
        const mode = body.mode === 'soft' ? 'soft' : 'block';
        // Subdivisions arrive as { "US": ["CA", "NY"], ... }. Normalise
        // and re-serialise to JSON for storage.
        const normSubdivisions = (raw: any): string => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}';
            const out: Record<string, string[]> = {};
            for (const [k, v] of Object.entries(raw)) {
                if (!Array.isArray(v)) continue;
                const codes = v.filter(x => typeof x === 'string')
                    .map(x => x.trim().toUpperCase()).filter(Boolean);
                if (codes.length) out[String(k).toUpperCase()] = Array.from(new Set(codes));
            }
            return JSON.stringify(out);
        };
        await adapterFor(this.connection.rawConnection).query(
            `UPDATE channel
             SET \`customFieldsGeoblockenabled\` = ?,
                 \`customFieldsGeoblockmode\` = ?,
                 \`customFieldsGeoblockallowedregions\` = ?,
                 \`customFieldsGeoblockallowedcountries\` = ?,
                 \`customFieldsGeoblockblockedcountries\` = ?,
                 \`customFieldsGeoblockallowedgbregions\` = ?,
                 \`customFieldsGeoblockallowedsubdivisions\` = ?,
                 \`customFieldsGeoblockipallowlist\` = ?,
                 \`customFieldsGeoblockblockmessage\` = ?,
                 \`customFieldsGeoblockblockredirecturl\` = ?,
                 \`customFieldsGeoblockblocklogourl\` = ?
             WHERE token = ?`,
            [
                !!body.enabled,
                mode,
                normList(body.allowedRegions, isPreset),
                normList(body.extraAllowed, isCountry),
                normList(body.blockedCountries, isCountry),
                normList(body.allowedGbRegions),
                normSubdivisions(body.allowedSubdivisions),
                normIpList(body.ipAllowlist),
                String(body.blockMessage || '').slice(0, 4000),
                httpUrl(body.blockRedirectUrl),
                httpUrl(body.blockLogoUrl),
                body.token,
            ],
        );
        this.rowCache.delete(String(body.token));
        return res.json({ ok: true, rejected });
    }

    /**
     * Admin: top blocked countries + daily series + totals over the last
     * N days (default 30). Fed straight into the admin Stats panel.
     */
    @Get('admin/stats')
    async stats(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        if (!GeoBlockPlugin.hasPremiumAccess()) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-geo-block'));
        }
        const days = Math.min(Math.max(parseInt((req.query as any).days || '30', 10) || 30, 1), 365);
        const channelId = (req.query as any).channelId
            ? parseInt(String((req.query as any).channelId), 10) : null;
        if (channelId && !channelPermitted(ctx, { id: channelId }, [Permission.ReadCatalog])) {
            return res.status(404).json({ error: 'channel not found' });
        }
        // Without a channelId: every channel this administrator may read.
        const scope = channelId ? [channelId] : permittedChannelIds(ctx, [Permission.ReadCatalog]);
        if (!scope.length) return res.json({ days, channelId, totals: {}, topCountries: [], series: [], reasons: [] });
        // geo_block_event is a TypeORM entity table: its camelCase columns are quoted on Postgres.
        const where = `\`createdAt\` >= DATE_SUB(NOW(), INTERVAL ? DAY) AND \`channelId\` IN (${scope.map(() => '?').join(', ')})`;
        const params = [days, ...scope];

        const top = await adapterFor(this.connection.rawConnection).query(
            `SELECT country, COUNT(*) AS n
             FROM geo_block_event WHERE ${where}
             GROUP BY country ORDER BY n DESC LIMIT 20`,
            params,
        );
        const series = await adapterFor(this.connection.rawConnection).query(
            `SELECT DATE(\`createdAt\`) AS day,
                    SUM(CASE WHEN decision='block' THEN 1 ELSE 0 END) AS blocked,
                    SUM(CASE WHEN decision='soft-block' THEN 1 ELSE 0 END) AS softBlocked
             FROM geo_block_event WHERE ${where}
             GROUP BY DATE(\`createdAt\`) ORDER BY day`,
            params,
        );
        const totals = await adapterFor(this.connection.rawConnection).query(
            `SELECT
                SUM(CASE WHEN decision='block' THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN decision='soft-block' THEN 1 ELSE 0 END) AS softBlocked,
                COUNT(*) AS total,
                COUNT(DISTINCT ip) AS uniqueIps
             FROM geo_block_event WHERE ${where}`,
            params,
        );
        const reasons = await adapterFor(this.connection.rawConnection).query(
            `SELECT reason, COUNT(*) AS n
             FROM geo_block_event WHERE ${where}
             GROUP BY reason ORDER BY n DESC`,
            params,
        );
        return res.json({
            days, channelId,
            totals: totals[0] || {},
            topCountries: top,
            series, reasons,
        });
    }

    /**
     * Admin: dry-run check — "what would happen if a visitor from US
     * with no UK region came in?". Lets the admin sanity-check their
     * rules without standing up a proxy.
     */
    @Post('admin/simulate')
    async simulate(@Ctx() ctx: RequestContext, @Body() body: any, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        if (!GeoBlockPlugin.hasPremiumAccess()) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-geo-block'));
        }
        if (!body?.token || typeof body.token !== 'string') return res.status(400).json({ error: 'channel token required' });
        const row = channelPermitted(ctx, { token: body.token }, [Permission.ReadCatalog]) ? await this.loadChannelRow(body.token) : null;
        if (!row) return res.status(404).json({ error: 'channel not found' });
        const cfg = this.buildConfig(body.token, row);
        const verdict = isAllowed(body.country || null, body.region || null, {
            enabled: cfg.geoBlock.enabled,
            allowedCountries: cfg.geoBlock.allowedCountries,
            blockedCountries: cfg.geoBlock.blockedCountries,
            allowedGbRegions: cfg.geoBlock.allowedGbRegions,
            allowedSubdivisions: cfg.geoBlock.allowedSubdivisions,
        });
        const opts = getOptions();
        const sv = checkSchedule(parseJsonSafely<BusinessHoursSchedule>(row.schedule));
        void this.engagement.markSimulated();
        return res.json({
            input: {
                country: body.country || null,
                region: body.region || null,
                ip: body.ip || null,
            },
            verdict,
            ipMatchesAllowlist: ipMatchesAny(normaliseIp(body.ip), parseList(row.ipAllowlist || '')),
            bot: body.userAgent ? isAllowlistedBot(String(body.userAgent), opts.botAllowlist ?? 'strict') : null,
            schedule: { inHours: sv.inHours, action: sv.action },
            maintenance: !!(opts.maintenanceWindow && inWindow(opts.maintenanceWindow)),
            effectiveRules: cfg.geoBlock,
        });
    }

    @Post('admin/gc')
    async gc(@Ctx() ctx: RequestContext, @Body() body: any, @Res() res: Response) {
        if (!requireAdmin(ctx, res, true)) return;
        const olderThanDays = Math.max(1, parseInt(body?.olderThanDays || '90', 10) || 90);
        // A channel administrator prunes only its own channels' audit rows.
        const scope = isSuperAdmin(ctx) ? null : permittedChannelIds(ctx, [Permission.UpdateCatalog]);
        if (scope && !scope.length) return res.json({ deleted: 0, olderThanDays });
        const result = await adapterFor(this.connection.rawConnection).query(
            `DELETE FROM geo_block_event WHERE \`createdAt\` < DATE_SUB(NOW(), INTERVAL ? DAY)`
                + (scope ? ` AND \`channelId\` IN (${scope.map(() => '?').join(', ')})` : ''),
            scope ? [olderThanDays, ...scope] : [olderThanDays],
            { needAffected: true },
        );
        return res.json({ deleted: result?.affectedRows ?? 0, olderThanDays });
    }

    /**
     * Storefront helper JS — the one-line drop-in.
     *
     * Storefronts add
     *   <script src="https://<host>/geo-block/hulo-geo.js"
     *           data-channel-token="…" async></script>
     * and get geo-blocking with zero custom code. See
     * `storefront-assets.ts` for the full contract of `data-*` attrs.
     *
     * Aggressively cached — this file is static per `publicBaseUrl`.
     */
    @Get('hulo-geo.js')
    huloGeoJs(@Res() res: Response) {
        const opts = getOptions();
        const body = buildHuloGeoJs({ publicBaseUrl: opts.publicBaseUrl || '' });
        const maxAge = Math.max(60, opts.storefrontHelperMaxAgeSec ?? 300);
        res.type('application/javascript');
        res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 4}`);
        applySecurityHeaders(res);
        // A <script src> is a no-cors load: the helper must be embeddable from the storefront's origin.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        return res.send(body);
    }

    /**
     * Branded block page — served in HTML for direct visitor navigation
     * (the storefront helper redirects here for hard blocks). Also
     * available as JSON via `Accept: application/json`, for storefronts
     * that want to render their own UI but still lift the copy.
     *
     * Accepts `t` (channel token), `reason` and `country`. The message is
     * the channel's own (block message / schedule message / default for the
     * reason) — never text from the URL, which anyone could craft into a
     * store-branded phishing page. Every value is HTML-escaped.
     */
    @Get('blocked')
    async blocked(@Req() req: Request, @Res() res: Response) {
        applySecurityHeaders(res);
        if (this.rateLimited(req, res, 'blocked')) return;

        const token = String((req.query as any).t || '').trim();
        const reason = String((req.query as any).reason || 'geo').slice(0, 40);
        const country = String((req.query as any).country || '').slice(0, 4).toUpperCase();
        const opts = getOptions();

        let logoUrl: string | null = null;
        let redirectUrl: string | null = null;
        let msg = '';
        if (token) {
            const row = await this.loadChannelRow(token);
            if (row) {
                logoUrl = row.blockLogoUrl || null;
                redirectUrl = row.blockRedirectUrl || null;
                if (reason === 'schedule') {
                    const sched = parseJsonSafely<BusinessHoursSchedule>(row.schedule);
                    msg = String(sched?.outsideMessage || checkSchedule(sched).message || '').slice(0, 400);
                }
                if (!msg && row.blockMessage) msg = String(row.blockMessage).slice(0, 400);
            }
        }
        if (!msg) msg = this.defaultMessage(reason as any);

        const wantsJson = String(req.headers.accept || '').includes('application/json');
        if (wantsJson) {
            return res.json({ reason, country: country || null, message: msg, logoUrl, redirectUrl });
        }

        const html = buildBlockedPageHtml({
            title: 'Not available in your region',
            heading: reason === 'schedule' ? 'Sorry, we’re closed' : 'Sorry, this store is not available',
            message: escapeHtml(msg),
            reason: escapeHtml(reason),
            country: country ? escapeHtml(country) : null,
            logoUrl: logoUrl ? escapeHtml(logoUrl) : null,
            redirectUrl: redirectUrl ? escapeHtml(redirectUrl) : null,
            supportEmail: opts.supportEmail ? escapeHtml(opts.supportEmail) : null,
        });
        res.type('text/html');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(html);
    }

    // -- private helpers ---------------------------------------------------

    private async loadChannelRow(token: string): Promise<any | null> {
        const hit = this.rowCache.get(token);
        if (hit && hit.exp > Date.now()) return hit.row;
        const row = await this.loadChannelRowUncached(token);
        if (this.rowCache.size > 200) this.rowCache.clear();
        this.rowCache.set(token, { row, exp: Date.now() + GeoBlockController.ROW_TTL_MS });
        return row;
    }

    /** `companyData` comes from Channel custom fields the HOST may define
     *  (`showCompanyNumber`, `businessCompanyNumber`); this plugin does not
     *  register them, so they are only selected when they exist — selecting
     *  them unconditionally made every per-channel call fail elsewhere. */
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

    private async loadChannelRowUncached(token: string): Promise<any | null> {
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
                    \`customFieldsGeoblockschedule\`            AS schedule
             FROM channel WHERE token = ? LIMIT 1`,
            [token],
        );
        return rows[0] || null;
    }

    /** Rules for one channel as the storefront and `/check` see them.
     *  Tier gate: unlicensed installs (evaluation expired) force
     *  `mode=block` (no soft-block banner) and ignore the saved
     *  subdivision map. The block decision itself still runs so the free
     *  tier is genuinely useful — just narrower. Applied here so the
     *  public `/site-config`, `/check` and the simulator never disagree. */
    private buildConfig(token: string, r: any): SiteConfig {
        const allowedRegions = parseList(r.allowedRegions);
        const extraAllowed = parseList(r.extraAllowed, ['GB']);
        const blockedCountries = parseList(r.blockedCountries);
        const resolved = resolveAllowedCountries({
            regions: allowedRegions,
            extraAllowed,
            blocked: blockedCountries,
        });
        const licensed = GeoBlockPlugin.hasPremiumAccess();
        return {
            channelToken: token,
            geoBlock: {
                enabled: !!Number(r.geoBlockEnabled || 0),
                mode: (licensed && r.geoBlockMode === 'soft' ? 'soft' : 'block'),
                allowedCountries: resolved.allowed,
                blockedCountries: resolved.blocked,
                // No default UK regions — hidden unless explicitly configured.
                allowedGbRegions: parseList(r.allowedGbRegions, []),
                allowedSubdivisions: licensed ? parseSubdivisions(r.allowedSubdivisionsJson) : {},
                allowedRegions,
                blockMessage: String(r.blockMessage || ''),
                blockRedirectUrl: r.blockRedirectUrl || null,
                blockLogoUrl: r.blockLogoUrl || null,
            },
            companyData: {
                showCompanyNumber: !!Number(r.showCompanyNumber || 0),
                companyNumber: String(r.companyNumber || ''),
            },
        };
    }

    /** Apply IP hashing when the plugin is configured to anonymise audit
     *  rows. Default is to hash, with the configured `ipSalt`, else the
     *  generated per-install salt, else (store unavailable) the legacy constant. */
    private maybeHashIp(ip: string | null): any {
        if (!ip) return null;
        const opts = getOptions();
        if (opts.hashAuditIps === false) return ip.slice(0, 64);
        return hashIp(ip, opts.ipSalt || generatedIpSalt || LEGACY_IP_SALT);
    }

    private async logEvent(input: {
        channelId: number;
        country: string | null;
        region: string | null;
        ip: string | null;
        ua: string | undefined;
        url: string;
        decision: 'block' | 'soft-block' | 'allow';
        reason: string;
    }): Promise<void> {
        // Audit log persistence is a paid feature — unlicensed mode
        // returns immediately. The block decision itself is unaffected;
        // the operator just doesn't get the historical view.
        if (!GeoBlockPlugin.hasPremiumAccess()) return;
        try {
            const repo = this.connection.rawConnection.getRepository(GeoBlockEvent);
            const row = repo.create({
                channelId: input.channelId,
                country: input.country ? input.country.toUpperCase().slice(0, 8) : null as any,
                region: input.region ? input.region.toUpperCase().slice(0, 8) : null as any,
                ip: this.maybeHashIp(input.ip),
                userAgent: input.ua ? String(input.ua).slice(0, 500) : null as any,
                url: (input.url || '').slice(0, 2048),
                decision: input.decision,
                reason: input.reason.slice(0, 64),
            });
            await repo.insert(row);
        } catch (e: any) {
            Logger.warn(`geo-block event log failed: ${e?.message}`, loggerCtx);
        }
    }

    private defaultMessage(reason: string): string {
        switch (reason) {
            case 'denylist':
                return 'This service is not available in your country.';
            case 'country-not-allowed':
                return 'This service is not available in your country.';
            case 'uk-region-not-allowed':
                return 'This service is only available in selected UK regions.';
            case 'maintenance':
                return 'The site is temporarily unavailable. Please try again later.';
            default:
                return 'Access denied.';
        }
    }
}

function inWindow(w: { startsAt: string; endsAt: string; allowedIps?: string[] }): boolean {
    const now = Date.now();
    const start = Date.parse(w.startsAt);
    const end = Date.parse(w.endsAt);
    if (!isFinite(start) || !isFinite(end)) return false;
    return now >= start && now <= end;
}
