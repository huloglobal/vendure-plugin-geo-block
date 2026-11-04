<p align="center"><a href="https://huloglobal.com/vendure-plugins/geo-block/"><img src="https://huloglobal.com/vendure-plugins/logos/geo-block.svg" width="96" height="96" alt="HULO Geo-block logo"></a></p>

# @huloglobal/vendure-plugin-geo-block

Per-channel storefront geo-restriction for Vendure. Allow / block by
country, by curated region preset (37 of them: EU, EEA, Schengen, GCC,
ANZ, NATO, Commonwealth, …), by ISO-3166-2 subdivision (US states, CA
provinces, AU states, DE Länder, IT regions, FR regions, ES autonomous
communities, IN states, BR units, MX entities, UK constituent
countries). Soft-block mode, IP allowlist, audit log, simulator and
maintenance windows.

**New in 0.7:** SEO-safe bot allowlist so Googlebot / Bingbot / social
crawlers bypass by default · per-channel business-hours schedule
(overnight windows + DST handled) · one-line storefront drop-in JS
(`hulo-geo.js`) · branded block page (`/geo-block/blocked`).

Maintained by Wayne Garrison.

## Buy

14-day free trial (card required, start it from the admin — nothing charged until day 15), then **£4.95/month**, or **£99 one-off lifetime** at
[elite.charity/licence/buy/vendure-plugin-geo-block](https://elite.charity/licence/buy/vendure-plugin-geo-block).
Start the trial (or buy) from the plugin's admin page — checkout opens in a new tab and the key installs itself.

## Install

```bash
yarn add @huloglobal/vendure-plugin-geo-block
```

```ts
import { GeoBlockPlugin } from '@huloglobal/vendure-plugin-geo-block';

export const config: VendureConfig = {
    plugins: [
        GeoBlockPlugin.init({
            publicBaseUrl: 'https://shop.example.com',
            licenceKey: process.env.HULO_LICENCE_KEY_GEO_BLOCK,

            // Optional one-shot maintenance lockdown
            maintenanceWindow: {
                startsAt: '2026-07-15T02:00:00Z',
                endsAt:   '2026-07-15T04:00:00Z',
                allowedIps: ['203.0.113.0/24'],
            },

            // -- Security (recommended in production) --
            signingSecret: process.env.HULO_GEO_BLOCK_SIGNING_SECRET,
            hashAuditIps: true,
            ipSalt: process.env.HULO_IP_SALT, // unset: a per-install salt is generated once and stored in the DB
            rateLimit: { capacity: 120, windowMs: 60_000 },

            // -- Retention (opt-in) --
            retention: { days: 90 },
        }),
    ],
};
```

Add `GeoBlockPlugin.uiExtensions` to your `compileUiExtensions` config.

### Admin UI

- **Settings → Geo Block** in the admin navigation (shared
  `GeoBlockNavModule`, registered by `uiExtensions`), opening the page at
  `/admin/extensions/geo-block`: channel picker, Rules, Block page, IP
  allowlist, Simulate and Stats tabs, with a live plain-English readout of
  what the current rules do.
- **Dashboard → Add widget → Geo Block**: blocked, soft-blocked and unique
  IPs over the last 7 days, plus the licence lifecycle notice.
- **Set-up checklist** and **Weekly report** cards on the landing page (see
  below), the licence banner with buy-from-admin, and one update banner
  when a new version is on npm.


> **Visitor IP:** the plugin uses Express's `req.ip` (set `trustProxy` on the
> Vendure host). Only list headers your edge sets and strips from clients in
> `trustedIpHeaders`, e.g. `['cf-connecting-ip']` behind Cloudflare.
> **Visitor country:** `CF-IPCountry` / `cf-region-code`, Akamai
> `X-Akamai-Edgescape` and Fastly `X-Country-Code` are believed only when the
> request came through a proxy trusted by `trustProxy`. Behind anything other
> than Cloudflare, set `trustedCountryHeaders` to your edge's one header (e.g.
> `['x-country-code']`) so a visitor cannot send a `CF-IPCountry` of their own.
> A visitor whose country cannot be resolved is allowed (fail-open).
> Audit rows are pruned after 90 days / 500 000 rows by default
> (`retention: false` keeps everything).

> **Unlicensed / after the evaluation:** saved rules are still enforced on
> `/geo-block/site-config` and `/geo-block/check`, but on the free tier —
> `mode` is always `block` (no soft-block banner), subdivision rules are
> ignored, only the 5 free presets can be picked, and no audit log is
> written. The public `site-config` and `check` apply the same gate.

## Feature tour

### 37 region presets

One-click bundles in five groups:

- **Geographic**: UK_ONLY, BRITISH_ISLES, UK_CROWN_DEPENDENCIES, EUROPE,
  NORDIC, BALTIC, BENELUX, IBERIA, BALKANS, NORTH_AMERICA,
  CENTRAL_AMERICA, CARIBBEAN, SOUTH_AMERICA, LATAM, OCEANIA, ANZ, MENA,
  APAC, EAST_ASIA, SOUTH_ASIA, AFRICA
- **Trade blocs**: EU, EEA, EFTA, GCC, ASEAN
- **Political / economic**: SCHENGEN, G7, G20, BRICS, OECD, NATO, FIVE_EYES
- **Language / cultural**: DACH, ENGLISH_SPEAKING, COMMONWEALTH
- **Everywhere**: WORLDWIDE (with the denylist still applied)

`GET /geo-block/presets` returns the live catalogue with country counts,
descriptions and each preset's `countries` (`null` for WORLDWIDE). The
admin page resolves the allow-list in the browser from that catalogue, so
the "Allow visitors from N countries" preview and the lockout warning
follow every edit before you save.

### Per-channel rules

Each Vendure channel gets its own rules — perfect for multi-storefront
installs (UK-only channel + EU channel + LATAM channel from one Vendure
instance).

### Soft-block mode

Per-channel `mode` field. `block` hides the storefront entirely;
`soft` renders it with a "we don't ship to your country" banner and
hides the checkout button. The verdict `mode` field is returned on
`/geo-block/check` so the storefront knows how to render.

### Generic subdivisions

JSON map `{ "US": ["CA","NY"], "DE": ["BY"] }` enforced on visitors via
the channel custom field `geoBlockAllowedSubdivisions`. Catalogue at
`GET /geo-block/subdivisions` covers 11 countries (200+ subdivisions).
Legacy GB-only `allowedGbRegions` is preserved for back-compat.

### IP allowlist with IPv4 CIDR

Per-channel list of IPs / ranges that bypass every rule. Use for
offices, oncall, payment-processor probes, monitoring.

### Audit log + stats

Every block decision recorded in `geo_block_event` with country, region,
IP (hashed by default), UA, channel and reason. Admin Stats panel
shows top blocked countries, daily series and reason breakdown.

### "What-if" simulator

`POST /geo-block/admin/simulate` dry-runs a hypothetical visitor against
current rules without persisting anything — try any country / UK
region / IP and see exactly what would happen.

### Custom block page

Per-channel `blockMessage`, `blockRedirectUrl`, `blockLogoUrl`. Falls
back to sensible defaults per block reason.

### Proxy-aware

Reads `cf-ipcountry` / Akamai / Fastly region headers from a trusted
proxy (see *Visitor country* above). Saves a MaxMind lookup per request.

### Security

- `signingSecret` HMAC-gates the `?country=` / `?region=` override on
  `/check`. Without it the override is the caller's own claim: anyone can ask
  `/check?country=GB` and get "allowed". That is harmless while the verdict is
  only used by the visitor's own browser (the storefront helper never
  forwards it), but set `signingSecret` before any server-side integration
  passes a visitor's query string to `/check`.
- Admin routes act only on channels where the administrator holds the
  permission (lists show only those channels).
- Audit IPs are SHA-256 hashed by default with `ipSalt`; when it is unset a
  random per-install salt is generated once and kept in `hulo_licence_store`
  (key `vendure-plugin-geo-block:ipsalt`), shared by server and worker. Set
  `ipSalt` to keep hashes comparable across reinstalls or DB restores.
- Rate limiter on every public endpoint.
- Security headers via the licence-sdk helper on every response.

## Weekly report, setup checklist and dashboard widget

**Weekly report.** Every Monday at 08:00 (server-local time) the worker
process emails a short report: how many visits Geo Block hard-blocked and
soft-blocked last week and how many distinct addresses that covered, each
with the change against the week before, the next step from the set-up
checklist, and — on a trial or the free tier — what a licence switches on.
Every figure is a real count from `geo_block_event`; nothing is estimated.

- **Who receives it:** the recipient saved on the admin page; otherwise the
  plugin's `supportEmail` option, then the licence's customer email, then
  the address entered in "Email me before it ends" on the trial banner. No
  address → nothing is sent.
- **How it is sent:** Geo Block has no mailer of its own, so the report uses
  the host's `SMTP_SERVER` (or `SMTP_HOST`), `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD` and `SMTP_FROM` environment variables through
  `nodemailer`, which is an **optional** peer dependency — install it on
  the host (`yarn add nodemailer`) to enable the report. Without SMTP the
  report is simply off and the plugin logs one line saying so.
- **Changing or stopping it:** Admin → Geo Block → *Weekly report* card —
  toggle it off, set another recipient, **Send me a test** or **Preview**
  this week's report in a new tab. Over HTTP: `GET/POST
  /geo-block/digest/settings` (`{enabled?, recipient?}`),
  `POST /geo-block/digest/send-test` (`{to?}`), `GET /geo-block/digest/preview`.
- Preferences live in the shared `hulo_plugin_prefs` table (created on
  boot); the weekly clock is multi-worker safe.

**Set-up checklist** (`GET /geo-block/setup`) sits at the top of the admin
page until every item is done: rules set on a channel, block page
customised, your own IP allow-listed, a simulation run. "Hide" is remembered
in the browser; the card returns if a done item comes undone. The same
undone items are the "next steps" in the weekly report.

**Dashboard widget.** Dashboard → Add widget → **Geo Block** shows the last
7 days' blocked, soft-blocked and unique-IP counts (`GET /geo-block/widget`)
with a link to the page. Stats stay a premium feature: on the free tier the
widget and the Stats tab show an unlock prompt instead of figures.

**Usage numbers.** The same 30-day counts (`requestsBlocked`,
`requestsSoftBlocked`, `uniqueIpsBlocked`) are sent with the daily
evaluation ping and, after purchase, the licence heartbeat — counts only,
never addresses or URLs. `HULO_HEARTBEAT_DISABLED=true` stops the heartbeat.

## HTTP endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/geo-block/site-config` | public | resolved channel rules (cache client-side) |
| `GET` | `/geo-block/check` | public | per-request decision + reason (logs to audit) |
| `GET` | `/geo-block/presets` | public | 37-preset catalogue (with `countries`) |
| `GET` | `/geo-block/subdivisions` | public | subdivision catalogue (11 countries) |
| `GET` | `/geo-block/admin/channels` | admin | list channels + rules |
| `POST` | `/geo-block/admin/save` | admin | save a channel's rules |
| `GET` | `/geo-block/admin/stats` | admin | block totals + top countries + series |
| `POST` | `/geo-block/admin/simulate` | admin | dry-run a hypothetical visitor |
| `POST` | `/geo-block/admin/gc` | admin | prune old audit rows |
| `GET` | `/geo-block/status` | admin | version + update status |
| `GET` | `/geo-block/licence/status` | admin | licence, tier, lifecycle notice, premium features, recent stats |
| `POST` | `/geo-block/eval/remind-me` | admin | "email me before the evaluation ends" opt-in |
| `GET` | `/geo-block/setup` | admin | set-up checklist (`items`, `complete`) |
| `GET` | `/geo-block/widget` | admin | dashboard widget feed (7-day figures) |
| `GET` | `/geo-block/digest/settings` | admin | weekly report settings |
| `POST` | `/geo-block/digest/settings` | admin | update `{enabled?, recipient?}` |
| `POST` | `/geo-block/digest/send-test` | admin | send this week's report now `{to?}` |
| `GET` | `/geo-block/digest/preview` | admin | this week's report as HTML |
| `GET` | `/geo-block/hulo-geo.js` | public | storefront drop-in helper JS |
| `GET` | `/geo-block/blocked` | public | branded block page (HTML or JSON) |

## Storefront integration

### Drop-in (recommended) — one script tag, zero code

```html
<script src="https://shop.example.com/geo-block/hulo-geo.js"
        data-channel-token="YOUR_CHANNEL_TOKEN" async></script>
```

On `DOMContentLoaded` the helper calls `/geo-block/check`, and:

- if the visitor is allowed → no-op
- if `mode=block` → redirects to `/geo-block/blocked` (or the channel's
  `blockRedirectUrl` if set, or the tag's `data-redirect`)
- if `mode=soft` → injects a sticky top banner with the operator's message

Optional `data-*` attributes: `data-redirect="/somewhere-else"`,
`data-timeout-ms="2500"`, `data-preview` (log verdict, no side effects).

### Server-side integration (full control)

```ts
// On boot: cache the rules
const cfg = await fetch('https://shop.example.com/geo-block/site-config', {
    headers: { 'vendure-token': CHANNEL_TOKEN },
}).then(r => r.json());

// Per request: get a decision (and audit it)
const verdict = await fetch('https://shop.example.com/geo-block/check', {
    headers: {
        'vendure-token': CHANNEL_TOKEN,
        'cf-ipcountry': req.headers['cf-ipcountry'] ?? '',
    },
}).then(r => r.json());
if (!verdict.allowed) {
    if (verdict.redirectUrl) return res.redirect(302, verdict.redirectUrl);
    return res.render('blocked', { message: verdict.message, mode: verdict.mode });
}
```

## Documentation

User manual + screenshots:
[huloglobal.com/vendure-plugins/geo-block/docs/](https://huloglobal.com/vendure-plugins/geo-block/docs/)

## Licence

Commercial. Buy at
[elite.charity/licence/buy/vendure-plugin-geo-block](https://elite.charity/licence/buy/vendure-plugin-geo-block).
