import { LanguageCode, PluginCommonModule, Type, VendurePlugin, TransactionalConnection } from '@vendure/core';
import { fingerprintPublicKey, Heartbeat, LicenceStatus, RetentionOptions, RevocationChecker, UpdateChecker, verifyLicence, warnIfIncompatibleVendure, EvaluationClient, EvaluationState, LicenceStore, adapterFor } from '@huloglobal/vendure-licence-sdk';
import { GeoBlockEvent } from './geo-block-event.entity';
import { GeoBlockController } from './geo-block.controller';
import { GeoBlockAdminResolver, geoBlockAdminApiSchema } from './admin-api';
import { REGION_PRESETS } from './geo-regions';
import { GeoBlockEngagementService } from './engagement';
import type { BotAllowlist } from './bot-detect';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = require('../package.json').version;
const PKG_NAME = '@huloglobal/vendure-plugin-geo-block';

export interface MaintenanceWindow {
    /** ISO-8601 timestamp. */
    startsAt: string;
    endsAt: string;
    /** Optional IPs that bypass maintenance (office, oncall, etc.). */
    allowedIps?: string[];
}

export interface GeoBlockPluginOptions {
    /** Public-facing host of the Vendure server. Used in licence domain
     *  matching — must match one of the JWT's `allowedDomains`. */
    publicBaseUrl: string;
    /** JWT licence key. Without one (after the 14-day evaluation) the rules
     *  are still enforced, but on the free tier: `mode` is forced to `block`
     *  (no soft-block banner) and subdivision rules are ignored on the public
     *  `site-config` and `check` endpoints; no audit log is written. */
    licenceKey?: string;
    /** Optional scheduled-maintenance window. When the current time falls
     *  inside this window the `/geo-block/check` endpoint refuses every
     *  request (except IPs on the per-channel allowlist or this option's
     *  own `allowedIps`). */
    maintenanceWindow?: MaintenanceWindow;

    // ── Security ────────────────────────────────────────────────────────
    /** Proxy headers that may override `req.ip` for the visitor address
     *  (allowlist + rate limit). Only list what YOUR edge sets and strips
     *  from clients, e.g. `['cf-connecting-ip']` behind Cloudflare. Default:
     *  none — `req.ip` with Express `trust proxy` is used. */
    trustedIpHeaders?: Array<'cf-connecting-ip' | 'true-client-ip' | 'x-real-ip' | 'x-forwarded-for'>;
    /** Edge headers that carry the visitor's country (and, with
     *  `cf-ipcountry`, Cloudflare's `cf-region-code`). Default (unset): the
     *  Cloudflare, Akamai and Fastly headers, believed ONLY when the request
     *  reached Vendure through a proxy trusted by Express `trust proxy`
     *  (Vendure `apiOptions.trustProxy`) — a client connecting directly can
     *  send any `CF-IPCountry` it likes. Set a list to trust exactly those
     *  headers on every request (only if your edge sets AND strips them), or
     *  `[]` to ignore country headers entirely. */
    trustedCountryHeaders?: Array<'cf-ipcountry' | 'x-akamai-edgescape' | 'x-country-code'>;
    /** Rate limit for public endpoints, keyed by IP. Default 120/60s. */
    rateLimit?: { capacity: number; windowMs: number };
    /** Per-install salt for hashing IPs stored in the audit log. When unset
     *  a random salt is generated once at boot and persisted in
     *  `hulo_licence_store` (key `vendure-plugin-geo-block:ipsalt`) so the
     *  server and the worker hash alike; set it explicitly to keep hashes
     *  comparable across reinstalls or database restores. */
    ipSalt?: string;
    /** Store hashed IPs in `geo_block_event.ip` instead of raw. Default true. */
    hashAuditIps?: boolean;
    /** HMAC secret used by the `?country=` override on `/geo-block/check`.
     *  When set, the override is honoured only if the request carries a
     *  matching `country.sig` query string. Without a secret the override
     *  is honoured unconditionally (legacy behaviour). */
    signingSecret?: string;

    // ── Retention ───────────────────────────────────────────────────────
    /** Auto-prune `geo_block_event` rows. Default `{ days: 90, maxRows: 500000 }`; set `false` to keep everything. */
    retention?: RetentionOptions | false;

    // ── SEO / bot allowlist ────────────────────────────────────────────
    /** Which `User-Agent`s bypass the geo-block. Default `'strict'` —
     *  well-known SEO + social crawlers (Googlebot, Bingbot, LinkedIn,
     *  Slack, etc.). Set to `false` only if you handle bot filtering
     *  upstream (Cloudflare, WAF). Custom arrays support string
     *  substrings + RegExp entries. See `bot-detect.ts` for detail. */
    botAllowlist?: BotAllowlist;

    // ── Storefront helper ──────────────────────────────────────────────
    /** Optional support email surfaced on the branded block page.
     *  Rendered inline as "Questions? <email>". Empty = no link. */
    supportEmail?: string;
    /** Cache-Control max-age (seconds) for the storefront helper JS.
     *  Default 300. Public + stale-while-revalidate. */
    storefrontHelperMaxAgeSec?: number;
}

const HULO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoLmNM5UljRqe71drM6lR
Ba5vXrLOcV3GAHkYvnVFQSqdE0avrge/jsD7WdA6x8qQFNRugxQcxDJa2l0+C+BH
SbU9TimGwhA1yusHHfuz9LAXks5IQ48+2e6Pulh7iThXPJUnIKqKZUN5HhL79aaK
vrZKIgSfVhwE5PMPXWZ+Ij5IRf74PLIUn1Er75qhBXlDJ4vF8y8/3owURNC1XiUB
DGElwV/LYNoqAQei4oixe4EAxPGvFi11pgHiGuRxuWckA88y6ZHLt6urfAY9sCkj
kF+2dc2yS3j7lD+SYAaV5LQYYjePP1CYvxCZ7HHRKqthHopxY1hsK2tBtni3f7/c
UwIDAQAB
-----END PUBLIC KEY-----`;

const PLUGIN_ID = 'vendure-plugin-geo-block';
const REVOCATION_URL = process.env.HULO_LICENCE_REVOCATION_URL
    || 'https://elite.charity/licence/revoked.json';

let cachedOptions: GeoBlockPluginOptions = { publicBaseUrl: 'http://localhost:3000' };
export function getOptions(): GeoBlockPluginOptions { return cachedOptions; }

/**
 * `@huloglobal/vendure-plugin-geo-block`
 *
 * Per-channel geo-restriction for Vendure storefronts. Owns three
 * public endpoints (`/geo-block/site-config`, `/geo-block/check`,
 * `/geo-block/presets`), six admin endpoints, and a custom-fields-only
 * Channel extension that surfaces all rules in the standard Vendure
 * admin Channel form — so even without the dedicated UI you can manage
 * blocks from the channel settings.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [GeoBlockController],
    providers: [GeoBlockAdminResolver, GeoBlockEngagementService],
    entities: [GeoBlockEvent],
    compatibility: '^3.0.0',
    adminApiExtensions: {
        schema: geoBlockAdminApiSchema,
        resolvers: [GeoBlockAdminResolver],
    },
    configuration: config => {
        // Convert REGION_PRESETS into Vendure customField option entries
        // so the admin gets the same human-readable picker the dedicated
        // UI shows.
        const presetOptions = REGION_PRESETS.map(p => ({
            value: p.key,
            label: [{ languageCode: LanguageCode.en, value: p.label }],
        }));

        config.customFields.Channel = (config.customFields.Channel || []).concat([
            {
                name: 'geoBlockEnabled', type: 'boolean', public: true, defaultValue: false,
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: enabled' }],
                description: [{ languageCode: LanguageCode.en, value: 'When on, visitors outside the resolved allow-list see a block page (or banner, in soft mode).' }],
            },
            {
                name: 'geoBlockMode', type: 'string', public: true, defaultValue: 'block',
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: mode' }],
                description: [{ languageCode: LanguageCode.en, value: 'block = full page block; soft = render storefront with a "we don\'t ship here" banner so the visitor can still browse / contact you.' }],
                options: [
                    { value: 'block', label: [{ languageCode: LanguageCode.en, value: 'Full block (hide storefront)' }] },
                    { value: 'soft', label: [{ languageCode: LanguageCode.en, value: 'Soft block (banner + browse-only)' }] },
                ],
            },
            {
                name: 'geoBlockAllowedRegions', type: 'string', list: true, public: true,
                defaultValue: [],
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: allowed regions (presets)' }],
                description: [{ languageCode: LanguageCode.en, value: 'One-click region presets. Combine with extra/blocked countries below.' }],
                options: presetOptions,
            },
            {
                name: 'geoBlockAllowedCountries', type: 'string', list: true, public: true,
                defaultValue: [],
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: extra allowed countries' }],
                description: [{ languageCode: LanguageCode.en, value: 'ISO 3166-1 alpha-2 codes (GB, IE, FR, US…). Added on top of the regions above.' }],
            },
            {
                name: 'geoBlockBlockedCountries', type: 'string', list: true, public: true,
                defaultValue: [],
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: always-blocked countries' }],
                description: [{ languageCode: LanguageCode.en, value: 'Subtracted from the resolved allow-list. Useful to ship "EU except X".' }],
            },
            {
                name: 'geoBlockAllowedGbRegions', type: 'string', list: true, public: true,
                defaultValue: [],
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: allowed UK regions (legacy)' }],
                description: [{ languageCode: LanguageCode.en, value: 'Legacy GB-only sub-region filter. Prefer the generic "allowed subdivisions" field below.' }],
            },
            {
                name: 'geoBlockAllowedSubdivisions', type: 'text', public: true, nullable: true,
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: allowed subdivisions per country' }],
                description: [{ languageCode: LanguageCode.en, value: 'JSON object mapping ISO country codes to allowed ISO-3166-2 subdivision codes. Example: {"US":["CA","NY"],"DE":["BY","BW"]}. Empty array for a country = all subdivisions allowed.' }],
            },
            {
                name: 'geoBlockIpAllowlist', type: 'string', list: true, public: false,
                defaultValue: [],
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: IP allowlist (overrides all rules)' }],
                description: [{ languageCode: LanguageCode.en, value: 'IPs or IPv4 CIDR ranges (e.g. 203.0.113.0/24) that bypass every country / region rule. Add your office, oncall, payment-processor probes.' }],
            },
            {
                name: 'geoBlockBlockMessage', type: 'text', public: true, nullable: true,
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: block-page message' }],
                description: [{ languageCode: LanguageCode.en, value: 'Custom message shown on the block / soft-block page. Empty = sensible default per reason.' }],
            },
            {
                name: 'geoBlockBlockRedirectUrl', type: 'string', public: true, nullable: true,
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: redirect URL' }],
                description: [{ languageCode: LanguageCode.en, value: 'Optional. When set, the storefront redirects blocked visitors here instead of showing the block page.' }],
            },
            {
                name: 'geoBlockBlockLogoUrl', type: 'string', public: true, nullable: true,
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: logo URL' }],
                description: [{ languageCode: LanguageCode.en, value: 'Optional logo shown above the block message.' }],
            },
            {
                name: 'geoBlockSchedule', type: 'text', public: true, nullable: true,
                label: [{ languageCode: LanguageCode.en, value: 'Geo-block: business-hours schedule' }],
                description: [{ languageCode: LanguageCode.en, value: 'Optional JSON. Recurring weekly window when the store is open. Outside the window, the outsideAction (block / soft / allow) is applied. Example: {"timezone":"Europe/London","days":[1,2,3,4,5],"from":"09:00","to":"17:30","outsideAction":"soft","outsideMessage":"We\'re closed for orders overnight."}. Empty = no schedule.' }],
            },
        ]);
        return config;
    },
})
export class GeoBlockPlugin {
    private static evalClientInternal: EvaluationClient | null = null;
    static getEvalState(): EvaluationState | null { return GeoBlockPlugin.evalClientInternal?.getState() ?? null; }
    static getEvalInstanceId(): string | null { return GeoBlockPlugin.evalClientInternal?.getInstanceId() ?? null; }
    /** Licensed installs AND installs inside the 14-day server-anchored
     *  evaluation window get the full feature set. After the window the
     *  plugin drops to the free tier. */
    static hasPremiumAccess(): boolean {
        if (GeoBlockPlugin.licenceStatus?.valid) return true;
        return !!GeoBlockPlugin.evalClientInternal?.getState()?.active;
    }
    static startEvaluation(): void {
        if (!GeoBlockPlugin.evalClientInternal) {
            GeoBlockPlugin.evalClientInternal = new EvaluationClient({ packageName: PKG_NAME, packageVersion: PKG_VERSION });
            if (GeoBlockPlugin.statsProvider) GeoBlockPlugin.evalClientInternal.setStatsProvider(GeoBlockPlugin.statsProvider);
            GeoBlockPlugin.evalClientInternal.start();
        }
    }

    /** Anonymous 30-day usage numbers (counts only) sent with the daily
     *  evaluation ping and, after purchase, the heartbeat — so the licence
     *  server's reminder and renewal emails can say what the plugin did.
     *  Installed by `GeoBlockEngagementService` once the DB is reachable. */
    private static statsProvider: (() => Promise<Record<string, number>>) | null = null;
    static setStatsProvider(fn: () => Promise<Record<string, number>>): void {
        GeoBlockPlugin.statsProvider = fn;
        GeoBlockPlugin.evalClientInternal?.setStatsProvider(fn);
        GeoBlockPlugin.heartbeat?.setStatsProvider(fn);
    }

    private static licenceHost = '';

    /** Verify + apply a licence key at runtime (admin-UI activation).
     *  Identical checks to boot-time verification. */
    static activateRuntimeLicence(key: string): LicenceStatus {
        const status = verifyLicence({
            licenceKey: key, pluginId: PLUGIN_ID, host: GeoBlockPlugin.licenceHost,
            publicKey: HULO_PUBLIC_KEY, revokedIds: GeoBlockPlugin.revocation?.getRevokedIds(),
        });
        if (status.valid) {
            GeoBlockPlugin.licenceStatus = status;
            GeoBlockPlugin.activeLicenceKey = key;
            GeoBlockPlugin.evalClientInternal?.stop();
        }
        return status;
    }

    /** The licence key currently in force (env/init key, admin-activated
     *  key or purchase-claim-installed key) — read live by the heartbeat so
     *  its `jti` and usage stats follow activations made after boot. */
    private static activeLicenceKey: string | null | undefined = undefined;
    static getActiveLicenceKey(): string | null | undefined { return GeoBlockPlugin.activeLicenceKey; }

    /** Drop an admin-activated key: back to unlicensed + evaluation. */
    static deactivateRuntimeLicence(): void {
        GeoBlockPlugin.activeLicenceKey = null;
        GeoBlockPlugin.licenceStatus = {
            valid: false,
            message: 'No licence key configured. The plugin will run in unlicensed (degraded) mode.',
        } as LicenceStatus;
        GeoBlockPlugin.startEvaluation();
        GeoBlockPlugin.evalClientInternal?.start();
    }

    constructor(private connection: TransactionalConnection) {}

    /** Apply an admin-activated licence key persisted in the DB. An
     *  explicitly configured env/init key always wins. */
    async onApplicationBootstrap() {
        if (GeoBlockPlugin.licenceStatus?.valid) return;
        try {
            const store = new LicenceStore((sql, params, opts) => adapterFor(this.connection.rawConnection).query(sql, params, opts));
            await store.ensureTable();
            const stored = await store.load(PLUGIN_ID);
            if (stored) {
                const st = GeoBlockPlugin.activateRuntimeLicence(stored);
                // eslint-disable-next-line no-console
                if (st.valid) console.log(`[${PKG_NAME}] licence restored from admin activation — ${st.message}`);
            }
        } catch { /* store failures never affect boot */ }
    }

    private static revocation: RevocationChecker | null = null;
    private static updateChecker: UpdateChecker | null = null;
    private static heartbeat: Heartbeat | null = null;
    private static licenceStatus: LicenceStatus | null = null;

    static getUpdateChecker(): UpdateChecker | null { return GeoBlockPlugin.updateChecker; }
    static getPackageVersion(): string { return PKG_VERSION; }
    static getPackageName(): string { return PKG_NAME; }
    /** Read by the controller to gate premium features. */
    static getLicenceStatus(): LicenceStatus | null { return GeoBlockPlugin.licenceStatus; }

    static init(options: GeoBlockPluginOptions): Type<GeoBlockPlugin> {
        cachedOptions = options;

        // Warn if @vendure/core at runtime is outside the tested
        // range. Non-fatal — the plugin boots and works.
        warnIfIncompatibleVendure({
            pluginPackageName: PKG_NAME,
            pluginPackageVersion: PKG_VERSION,
            supportedRange: { min: '3.5.0', max: '4.0.0' },
        });

        if (!GeoBlockPlugin.revocation) {
            GeoBlockPlugin.revocation = new RevocationChecker(REVOCATION_URL);
            GeoBlockPlugin.revocation.start();
        }
        if (!GeoBlockPlugin.updateChecker) {
            GeoBlockPlugin.updateChecker = new UpdateChecker(PKG_NAME, PKG_VERSION);
            GeoBlockPlugin.updateChecker.start();
        }

        const host = (options.publicBaseUrl || '')
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        GeoBlockPlugin.licenceHost = host;
        const status = verifyLicence({
            licenceKey: options.licenceKey,
            pluginId: PLUGIN_ID,
            host,
            publicKey: HULO_PUBLIC_KEY,
            revokedIds: GeoBlockPlugin.revocation.getRevokedIds(),
        });
        GeoBlockPlugin.licenceStatus = status;
        GeoBlockPlugin.activeLicenceKey = status.valid ? options.licenceKey : undefined;

        if (!status.valid) {
            // Unlicensed: register the install (no premium is granted by this; the 14-day
            // evaluation; premium paths stay on until it expires.
            GeoBlockPlugin.startEvaluation();
            // eslint-disable-next-line no-console
            console.warn(
                `[@huloglobal/vendure-plugin-geo-block] ${status.message}` +
                ` — Running in FREE tier: 5 of 37 region presets, no subdivisions, no soft-block, no audit log. Buy a licence at https://elite.charity/licence/buy/${PLUGIN_ID}`,
            );
        }

        if (!GeoBlockPlugin.heartbeat) {
            GeoBlockPlugin.heartbeat = new Heartbeat({
                packageName: PKG_NAME,
                packageVersion: PKG_VERSION,
                licenceKey: options.licenceKey,
                licenceKeyProvider: () => GeoBlockPlugin.getActiveLicenceKey(),
                publicKeyFingerprint: fingerprintPublicKey(HULO_PUBLIC_KEY),
                statsProvider: GeoBlockPlugin.statsProvider ?? undefined,
            });
            GeoBlockPlugin.heartbeat.start();
        }

        return GeoBlockPlugin;
    }

    static uiExtensions = {
        extensionPath: __dirname + '/../ui',
        ngModules: [
            {
                type: 'lazy' as const,
                route: 'geo-block',
                ngModuleFileName: 'geo-block.module.ts',
                ngModuleName: 'GeoBlockModule',
            },
            {
                type: 'shared' as const,
                ngModuleFileName: 'geo-block-nav.module.ts',
                ngModuleName: 'GeoBlockNavModule',
            },
        ],
    };
}
