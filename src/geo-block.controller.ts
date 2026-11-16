import { Body, Controller, Get, OnApplicationBootstrap, OnModuleDestroy, Post, Query, Req, Res } from '@nestjs/common';
import {
    applySecurityHeaders,
    hashIp,
    isLicensed,
    premiumFeatureError,
    RateLimiter,
    startRetentionSweeper,
    verifySignedValue, LicenceStore, performSelfUpdate, selfUpdateEnv, adapterFor, PurchaseClaimClient, evalInstanceId, describeLicence, isAdminApiSession } from '@huloglobal/vendure-licence-sdk';
import { Channel, Ctx, Logger, Permission, ProcessContext, RequestContext, TransactionalConnection } from '@vendure/core';
import { Request, Response } from 'express';
import { GeoBlockEvent } from './geo-block-event.entity';
import { SUBDIVISIONS, hasSubdivisions } from './subdivisions';
import {
    isAllowed,
    ipMatchesAny,
    isFreeTierPreset,
    isIpOrCidr,
    FREE_TIER_PRESET_KEYS,
    REGION_PRESETS,
    presetCountries,
    resolveAllowedCountries,
} from './geo-regions';
import {
    buildConfig, DEFAULT_SITE_CONFIG, GeoBlockChannelRules, parseJsonSafely, parseList, parseMaintenance, parseSubdivisions, rulesFromRow, safeHttpUrl, SiteConfig,
} from './channel-rules';
import { decide, defaultMessage, httpStatusFor, inWindow, sanitiseMaintenance, sanitiseSchedule, Verdict } from './decision';
import { CrawlerVerifier, claimedVerifiableBot } from './bot-verify';
import { diagnose, locate } from './locate';
import { effectiveSettings, getOverrides, refreshOverrides, sanitiseOverrides, saveOverrides } from './settings';
import { setRefusalListener } from './enforcement';
import { ensureStoredSecret } from './stored-secret';
import { channelPermitted, isSuperAdmin, permittedChannelIds } from './channel-access';
import { GeoBlockPlugin, getOptions } from './plugin';
import { getRealIp, getResolvedRegion, normaliseIp } from './proxy-headers';
import { isAllowlistedBot } from './bot-detect';
import { BusinessHoursSchedule, checkSchedule } from './schedule';

const DEFAULTS = DEFAULT_SITE_CONFIG;
import { buildHuloGeoJs, buildBlockedPageHtml, normaliseBlockedReason } from './storefront-assets';
import { GeoBlockEngagementService, PREMIUM_FEATURES } from './engagement';

const PLUGIN_ID_FOR_STORE = 'vendure-plugin-geo-block';
const IP_SALT_STORE_KEY = 'vendure-plugin-geo-block:ipsalt';
const LEGACY_IP_SALT = 'hulo-geo-block-default-salt';

const loggerCtx = 'GeoBlockController';

/** Per-install audit-IP salt resolved at boot when `ipSalt` is not configured (cached per process). */
let generatedIpSalt: string | null = null;

function requireAdmin(ctx: RequestContext, res: Response, write: boolean | 'super' = false): boolean {
    if (!ctx?.activeUserId) {
        res.status(401).json({ error: 'Authentication required' });
        return false;
    }
    // 'super': self-update and licence changes affect the whole install.
    const needed = write === 'super' ? [Permission.SuperAdmin] : write ? [Permission.UpdateCatalog] : [Permission.ReadCatalog];
    if (!isAdminApiSession(ctx) || !ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    return true;
}

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
    private limiterKey = '';
    private crawlerVerifier = new CrawlerVerifier();

    constructor(
        private connection: TransactionalConnection,
        private processContext: ProcessContext,
        private engagement: GeoBlockEngagementService,
        private rules: GeoBlockChannelRules,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const opts = getOptions();
        await refreshOverrides(this.engagement.prefs, true);
        this.ensureLimiter();
        await this.resolveIpSalt();
        // Purchases refused by the server-side enforcement land in the audit log too.
        setRefusalListener((_ctx, v, info) => {
            void this.logEvent({
                channelId: info.channelId, country: info.country, region: info.region, ip: info.ip,
                ua: info.ua, url: 'purchase', decision: 'block', reason: `purchase:${v.reason}`.slice(0, 64),
            });
        });
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

    /** (Re)build the public rate limiter when its effective settings change. */
    private ensureLimiter(): void {
        const rl = effectiveSettings().rateLimit;
        const key = `${rl.capacity}/${rl.windowMs}`;
        if (this.limiter && key === this.limiterKey) return;
        this.limiter = new RateLimiter({ capacity: rl.capacity, windowMs: rl.windowMs });
        this.limiterKey = key;
    }

    private rateLimited(req: Request, res: Response, bucket: string): boolean {
        void refreshOverrides(this.engagement.prefs).then(() => this.ensureLimiter());
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
        // Settings stay readable/editable on the free tier (kept for when a
        // licence returns); `premium: false` tells the UI nothing is sent.
        return res.json({ ...(await this.engagement.digest.settings()), premium: GeoBlockPlugin.hasPremiumAccess() });
    }

    @Post('digest/settings')
    async digestUpdateSettings(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const patch: { enabled?: boolean; recipient?: string | null } = {};
        if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
        if (body?.recipient !== undefined) patch.recipient = body.recipient === null ? null : String(body.recipient);
        try {
            return res.json({ ...(await this.engagement.digest.updateSettings(patch)), premium: GeoBlockPlugin.hasPremiumAccess() });
        } catch (e: any) {
            return res.status(400).json({ message: e?.message || 'Invalid settings' });
        }
    }

    @Post('digest/send-test')
    async digestSendTest(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        // The weekly report is a premium feature (licence or evaluation).
        if (!GeoBlockPlugin.hasPremiumAccess()) return res.status(402).json(premiumFeatureError('vendure-plugin-geo-block'));
        const r = await this.engagement.digest.sendNow(String(body?.to || '').trim() || null);
        return res.json({ sent: r.sent, to: r.to, reason: r.reason, subject: r.preview.subject });
    }

    /** This week's report as HTML, for the admin page's Preview button. */
    @Get('digest/preview')
    async digestPreview(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        if (!GeoBlockPlugin.hasPremiumAccess()) return res.status(402).json(premiumFeatureError('vendure-plugin-geo-block'));
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
        // The set-up checklist is a premium feature: on the free tier it is not shown.
        if (!GeoBlockPlugin.hasPremiumAccess()) return res.json({ items: [], complete: true, premium: false });
        const items = await this.engagement.setupItems();
        return res.json({ items, complete: items.every(i => i.done), premium: true });
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

        const row = await this.rules.load(token);
        if (!row) return { ...DEFAULTS, channelToken: token };
        return buildConfig(token, row, GeoBlockPlugin.hasPremiumAccess());
    }

    /** Crawler exemption for a page view: the User-Agent allowlist and, with
     *  `verifyBots`, reverse DNS for anything claiming Googlebot / Bingbot. */
    private async crawlerExempt(ua: string, ip: string | null): Promise<boolean> {
        const s = effectiveSettings();
        if (!isAllowlistedBot(ua, s.botAllowlist)) return false;
        if (!s.verifyBots) return true;
        const claimed = claimedVerifiableBot(ua);
        if (!claimed) return true;
        return this.crawlerVerifier.verify(claimed, ip);
    }

    /**
     * Per-request decision endpoint. The storefront calls this on entry
     * (or middleware can call it) with optional `?country=` overrides.
     * Logs the decision so the admin stats panel shows top blocked
     * countries.
     *
     * Returns 200 with `{ allowed: boolean, reason, mode }` — the storefront
     * decides whether to redirect or render a banner. With `?status=1` a
     * refusal is answered 403 (or 503 + Retry-After for business hours and
     * maintenance) instead, for edge middleware that only looks at status.
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
        const row = await this.rules.load(token);
        if (!row) return res.json({ allowed: true, reason: 'unknown-channel' });
        const premium = GeoBlockPlugin.hasPremiumAccess();
        // The tier gate (unlicensed: mode=block, no subdivisions) is applied in
        // `rulesFromRow`, so `/check`, `/site-config` and the simulator agree.
        const rules = rulesFromRow(token, row, premium);

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
        const located = overrideCountry ? null : locate(req, ip);
        const country = overrideCountry || located?.country || null;
        const region = overrideRegion || (overrideCountry ? getResolvedRegion(req, opts.trustedCountryHeaders) : located?.region) || null;
        const referer = String(req.headers.referer || '').slice(0, 2048);
        const ua = String(req.headers['user-agent'] || '');
        const channelId = Number(row.id) || 1;

        // The crawler exemption is only worked out (DNS included) when the
        // IP allowlist has not already let the visitor through.
        const isCrawler = ipMatchesAny(ip, rules.ipAllowlist) ? false : await this.crawlerExempt(ua, ip);
        const v = decide(rules, { ip, country, region, isCrawler }, {
            premium, purpose: 'view', globalMaintenance: opts.maintenanceWindow ?? null,
        });
        if (v.allowed) return res.json({ allowed: true, reason: v.reason, mode: v.mode });

        void this.logEvent({
            channelId, country, region, ip, ua, url: referer,
            decision: v.mode === 'soft' ? 'soft-block' : 'block',
            reason: v.reason,
        });
        const body: Record<string, any> = {
            allowed: false,
            reason: v.reason,
            mode: v.mode,
            message: v.message,
            redirectUrl: v.redirectUrl ?? null,
        };
        if (v.reason !== 'maintenance' || v.logoUrl) body.logoUrl = v.logoUrl ?? null;
        if (String(req.query.status || '') === '1' && v.mode === 'block') {
            const status = httpStatusFor(v.reason);
            if (status === 503) res.setHeader('Retry-After', String(v.retryAfterSec ?? 3600));
            res.status(status);
        }
        return res.json(body);
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
                    \`customFieldsGeoblockblocklogourl\`               AS blockLogoUrl,
                    \`customFieldsGeoblockschedule\`                   AS schedule,
                    \`customFieldsGeoblockmaintenance\`                AS maintenance,
                    \`customFieldsGeoblockenforcepurchases\`           AS enforcePurchases
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
            const maintenance = parseMaintenance(r.maintenance);
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
                schedule: parseJsonSafely<BusinessHoursSchedule>(r.schedule),
                maintenance,
                maintenanceActive: inWindow(maintenance),
                enforcePurchases: !!Number(r.enforcePurchases || 0),
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
        const existing = channelPermitted(ctx, { token: body.token }, [Permission.UpdateCatalog])
            ? await this.rules.loadUncached(body.token) : null;
        if (!existing) {
            return res.status(404).json({ error: 'channel not found' });
        }
        // Validate what goes into the TEXT columns: bounded lists of known
        // codes, parseable IPs/CIDRs (no /0 footgun), http(s) URLs only —
        // a `javascript:` redirect would run in the storefront helper.
        const rejected: string[] = [];
        const lockedPresets: string[] = [];
        const premium = GeoBlockPlugin.hasPremiumAccess();
        const savedPresets = new Set(parseList(existing.allowedRegions).map(x => String(x).toUpperCase()));
        const cleanList = (v: any, valid?: (x: string) => boolean): string[] => {
            if (!Array.isArray(v)) return [];
            const clean = v.filter(x => typeof x === 'string').map(x => x.trim().toUpperCase()).filter(Boolean).slice(0, 500);
            const kept = valid ? clean.filter(x => { const ok = valid(x); if (!ok) rejected.push(x); return ok; }) : clean;
            return Array.from(new Set(kept));
        };
        const isCountry = (x: string) => /^[A-Z]{2}$/.test(x);
        // Free tier: 5 of the 37 presets. Enforced here, not only in the UI —
        // presets already saved (while licensed) are kept, new ones refused.
        const isPreset = (x: string) => {
            const known = x === 'WORLDWIDE' || REGION_PRESETS.some(p => String(p.key).toUpperCase() === x);
            if (!known) return false;
            if (!premium && !isFreeTierPreset(x) && !savedPresets.has(x)) { lockedPresets.push(x); return false; }
            return true;
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
            // Bounded: country keys are ISO codes, subdivision codes are short
            // alphanumerics, at most 250 countries x 200 codes (the TEXT column
            // is read on every /check).
            const out: Record<string, string[]> = {};
            for (const [k, v] of Object.entries(raw).slice(0, 250)) {
                const key = String(k).trim().toUpperCase();
                if (!Array.isArray(v) || !/^[A-Z]{2}$/.test(key)) continue;
                const codes = v.filter(x => typeof x === 'string')
                    .map(x => x.trim().toUpperCase()).filter(x => /^[A-Z0-9]{1,6}$/.test(x)).slice(0, 200);
                if (codes.length) out[key] = Array.from(new Set(codes));
            }
            return JSON.stringify(out);
        };
        // Business hours and the channel's maintenance window: only touched when sent.
        let scheduleJson: string | null | undefined;
        let maintenanceJson: string | null | undefined;
        try {
            if (body.schedule !== undefined) {
                const sch = sanitiseSchedule(body.schedule);
                scheduleJson = sch ? JSON.stringify(sch) : null;
            }
            if (body.maintenance !== undefined) {
                const m = sanitiseMaintenance(body.maintenance, isIpOrCidr);
                maintenanceJson = m ? JSON.stringify(m) : null;
            }
        } catch (e: any) {
            return res.status(400).json({ error: e?.message || 'Invalid schedule or maintenance window' });
        }
        const regions = cleanList(body.allowedRegions, isPreset);
        const extra = cleanList(body.extraAllowed, isCountry);
        const blocked = cleanList(body.blockedCountries, isCountry);
        // Lockout refusal: rules that would block EVERY visitor are saved but
        // left switched off, so a slip cannot take the whole store down.
        let enabled = !!body.enabled;
        const resolved = resolveAllowedCountries({ regions, extraAllowed: extra, blocked });
        const lockout = enabled && resolved.allowed !== null && resolved.allowed.length === 0;
        if (lockout) enabled = false;

        const set = [
            '`customFieldsGeoblockenabled` = ?',
            '`customFieldsGeoblockmode` = ?',
            '`customFieldsGeoblockallowedregions` = ?',
            '`customFieldsGeoblockallowedcountries` = ?',
            '`customFieldsGeoblockblockedcountries` = ?',
            '`customFieldsGeoblockallowedgbregions` = ?',
            '`customFieldsGeoblockallowedsubdivisions` = ?',
            '`customFieldsGeoblockipallowlist` = ?',
            '`customFieldsGeoblockblockmessage` = ?',
            '`customFieldsGeoblockblockredirecturl` = ?',
            '`customFieldsGeoblockblocklogourl` = ?',
        ];
        const params: any[] = [
            enabled,
            mode,
            JSON.stringify(regions),
            JSON.stringify(extra),
            JSON.stringify(blocked),
            JSON.stringify(cleanList(body.allowedGbRegions)),
            normSubdivisions(body.allowedSubdivisions),
            normIpList(body.ipAllowlist),
            String(body.blockMessage || '').slice(0, 4000),
            httpUrl(body.blockRedirectUrl),
            httpUrl(body.blockLogoUrl),
        ];
        if (scheduleJson !== undefined) { set.push('`customFieldsGeoblockschedule` = ?'); params.push(scheduleJson); }
        if (maintenanceJson !== undefined) { set.push('`customFieldsGeoblockmaintenance` = ?'); params.push(maintenanceJson); }
        if (typeof body.enforcePurchases === 'boolean') { set.push('`customFieldsGeoblockenforcepurchases` = ?'); params.push(body.enforcePurchases); }
        await adapterFor(this.connection.rawConnection).query(
            `UPDATE channel SET ${set.join(', ')} WHERE token = ?`,
            [...params, body.token],
        );
        this.rules.invalidate(String(body.token));
        return res.json({
            ok: true,
            rejected,
            lockedPresets,
            lockout,
            ...(lockout ? { message: 'Nothing would be allowed, so the rules were saved but left switched off. Pick a region or country first.' } : {}),
        });
    }

    /** "Add my IP": puts the calling administrator's own address on the
     *  channel's IP allowlist (the address the plugin sees, after the
     *  trusted-proxy rules — exactly what `/check` would compare). */
    @Post('admin/add-my-ip')
    async addMyIp(@Ctx() ctx: RequestContext, @Req() req: Request, @Body() body: any, @Res() res: Response) {
        if (!requireAdmin(ctx, res, true)) return;
        const token = typeof body?.token === 'string' ? body.token : '';
        const row = token && channelPermitted(ctx, { token }, [Permission.UpdateCatalog]) ? await this.rules.loadUncached(token) : null;
        if (!row) return res.status(404).json({ error: 'channel not found' });
        const ip = getRealIp(req, getOptions().trustedIpHeaders);
        if (!ip || !isIpOrCidr(ip)) return res.status(400).json({ error: 'Could not work out your IP address' });
        const list = parseList(row.ipAllowlist);
        if (ipMatchesAny(ip, list)) return res.json({ ok: true, ip, added: false, ipAllowlist: list });
        if (list.length >= 500) return res.status(400).json({ error: 'The IP allowlist is full (500 entries)' });
        const next = [...list, ip];
        await adapterFor(this.connection.rawConnection).query(
            `UPDATE channel SET \`customFieldsGeoblockipallowlist\` = ? WHERE token = ?`,
            [JSON.stringify(next), token],
        );
        this.rules.invalidate(token);
        return res.json({ ok: true, ip, added: true, ipAllowlist: next });
    }

    /** Country-source diagnostic: the caller's own IP, the country it
     *  resolves to and where that came from (CDN header, local MaxMind file
     *  or nothing), plus why when nothing works. */
    @Get('admin/diagnostic')
    async diagnostic(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        res.setHeader('Cache-Control', 'no-store');
        const d = diagnose(req);
        const ua = String(req.headers['user-agent'] || '');
        return res.json({ ...d, crawlerExempt: await this.crawlerExempt(ua, d.ip) });
    }

    /** Settings: init options are the defaults; the safe subset can be
     *  overridden here (stored in the plugin prefs). Security options are
     *  returned read-only. */
    @Get('admin/settings')
    async getSettings(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        await refreshOverrides(this.engagement.prefs, true);
        return res.json(this.settingsView());
    }

    @Post('admin/settings')
    async saveSettings(@Ctx() ctx: RequestContext, @Body() body: any, @Res() res: Response) {
        // Install-wide: affects every channel.
        if (!requireAdmin(ctx, res, 'super')) return;
        await refreshOverrides(this.engagement.prefs, true);
        let next;
        try {
            next = sanitiseOverrides(getOverrides(), body || {});
        } catch (e: any) {
            return res.status(400).json({ error: e?.message || 'Invalid settings' });
        }
        await saveOverrides(this.engagement.prefs, next);
        this.ensureLimiter();
        return res.json(this.settingsView());
    }

    private settingsView() {
        const o = getOptions();
        const eff = effectiveSettings();
        return {
            effective: {
                botMode: eff.botMode, botCustom: eff.botCustom, verifyBots: eff.verifyBots,
                supportEmail: eff.supportEmail, rateLimitPerMinute: Math.round(eff.rateLimit.capacity * 60_000 / eff.rateLimit.windowMs),
                hashAuditIps: eff.hashAuditIps, storefrontHelperMaxAgeSec: eff.storefrontHelperMaxAgeSec,
                storeName: eff.storeName, accentColor: eff.accentColor,
            },
            overrides: getOverrides(),
            readOnly: {
                publicBaseUrl: o.publicBaseUrl || '',
                trustedIpHeaders: o.trustedIpHeaders || [],
                trustedCountryHeaders: o.trustedCountryHeaders ?? 'default (CDN headers via a trusted proxy)',
                signingSecret: !!o.signingSecret,
                ipSalt: !!o.ipSalt,
                maxmindDb: o.maxmindDbPath ? (o.maxmindDbPath.split(/[\\/]/).pop() || '') : null,
                retention: o.retention === false ? 'off' : (o.retention || { days: 90, maxRows: 500000 }),
                maintenanceWindow: o.maintenanceWindow ? { startsAt: o.maintenanceWindow.startsAt, endsAt: o.maintenanceWindow.endsAt } : null,
            },
        };
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
        const row = channelPermitted(ctx, { token: body.token }, [Permission.ReadCatalog]) ? await this.rules.load(body.token) : null;
        if (!row) return res.status(404).json({ error: 'channel not found' });
        const cfg = buildConfig(body.token, row, GeoBlockPlugin.hasPremiumAccess());
        const rules = rulesFromRow(body.token, row, GeoBlockPlugin.hasPremiumAccess());
        const country = typeof body.country === 'string' && /^[A-Za-z]{2}$/.test(body.country) ? body.country.toUpperCase() : null;
        const region = typeof body.region === 'string' && /^[A-Za-z0-9]{1,4}$/.test(body.region) ? body.region.toUpperCase() : null;
        const ip = normaliseIp(typeof body.ip === 'string' ? body.ip : null);
        const verdict = isAllowed(country, region, rules);
        const opts = getOptions();
        const s = effectiveSettings();
        const ua = typeof body.userAgent === 'string' ? body.userAgent.slice(0, 500) : '';
        const isBot = ua ? isAllowlistedBot(ua, s.botAllowlist) : null;
        const now = new Date();
        const decision = decide(rules, { ip, country, region, isCrawler: !!isBot }, { premium: true, purpose: 'view', globalMaintenance: opts.maintenanceWindow ?? null, now });
        const purchase = decide(rules, { ip, country, region, isCrawler: false }, { premium: true, purpose: 'purchase', globalMaintenance: opts.maintenanceWindow ?? null, now });
        const sv = checkSchedule(rules.schedule, now);
        void this.engagement.markSimulated();
        return res.json({
            input: { country, region, ip: ip || null },
            verdict,
            // The whole pipeline (allowlist → crawler → hours → maintenance → rules) for a page view…
            decision,
            // …and for a purchase, when server-side enforcement is on (crawlers get no exemption; soft = banner only).
            purchase: { refused: !purchase.allowed && purchase.mode === 'block', reason: purchase.reason, enforced: !!Number(row.enforcePurchases || 0) },
            ipMatchesAllowlist: ipMatchesAny(ip, rules.ipAllowlist),
            bot: isBot,
            botNeedsDnsCheck: !!(isBot && s.verifyBots && claimedVerifiableBot(ua)),
            schedule: { inHours: sv.inHours, action: sv.action, localTime: sv.localTime, localDay: sv.localDay },
            maintenance: !!(opts.maintenanceWindow && inWindow(opts.maintenanceWindow, now)) || inWindow(rules.maintenance, now),
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
        const maxAge = effectiveSettings().storefrontHelperMaxAgeSec;
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

        const token = String((req.query as any).t || '').trim().slice(0, 200);
        // Only reasons the page knows; never text from the URL on a store-branded page.
        const reason = normaliseBlockedReason((req.query as any).reason || 'geo');
        const rawCountry = String((req.query as any).country || '').trim().toUpperCase();
        const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : '';
        const opts = getOptions();

        let logoUrl: string | null = null;
        let redirectUrl: string | null = null;
        let msg = '';
        let retryAfterSec = 3600;
        if (reason === 'maintenance' && opts.maintenanceWindow && inWindow(opts.maintenanceWindow)) {
            retryAfterSec = Math.max(60, Math.min(86_400, Math.ceil((Date.parse(opts.maintenanceWindow.endsAt) - Date.now()) / 1000) || 3600));
        }
        if (token) {
            const row = await this.rules.load(token);
            if (row) {
                logoUrl = safeHttpUrl(row.blockLogoUrl);
                redirectUrl = safeHttpUrl(row.blockRedirectUrl);
                if (reason === 'maintenance') {
                    const m = parseMaintenance(row.maintenance);
                    if (m?.message && inWindow(m)) msg = String(m.message).slice(0, 400);
                    if (m && inWindow(m)) retryAfterSec = Math.max(60, Math.min(86_400, Math.ceil((Date.parse(m.endsAt) - Date.now()) / 1000)));
                }
                if (reason === 'schedule') {
                    const sched = parseJsonSafely<BusinessHoursSchedule>(row.schedule);
                    msg = String(sched?.outsideMessage || checkSchedule(sched).message || '').slice(0, 400);
                }
                if (!msg && row.blockMessage) msg = String(row.blockMessage).slice(0, 400);
            }
        }
        if (!msg) msg = defaultMessage(reason);

        const wantsJson = String(req.headers.accept || '').includes('application/json');
        if (wantsJson) {
            return res.json({ reason, country: country || null, message: msg, logoUrl, redirectUrl });
        }

        const settings = effectiveSettings();
        const html = buildBlockedPageHtml({
            reason,
            message: msg,
            country: country || null,
            logoUrl,
            redirectUrl,
            supportEmail: settings.supportEmail || null,
            storeName: settings.storeName || null,
            accentColor: settings.accentColor,
        });
        // The HTML block page is not content: 403 for a geo refusal, 503 with
        // Retry-After while closed (business hours) or in maintenance, so
        // crawlers and caches never store it as the page.
        const status = httpStatusFor(reason);
        if (status === 503) res.setHeader('Retry-After', String(retryAfterSec));
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.status(status);
        res.type('text/html');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(html);
    }

    // -- private helpers ---------------------------------------------------

    /** Apply IP hashing when the plugin is configured to anonymise audit
     *  rows. Default is to hash, with the configured `ipSalt`, else the
     *  generated per-install salt, else (store unavailable) the legacy constant. */
    private maybeHashIp(ip: string | null): any {
        if (!ip) return null;
        const opts = getOptions();
        if (!effectiveSettings().hashAuditIps) return ip.slice(0, 64);
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
}
