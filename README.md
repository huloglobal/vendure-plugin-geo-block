<p align="center"><a href="https://huloglobal.com/vendure-plugins/geo-block/"><img src="https://huloglobal.com/vendure-plugins/logos/geo-block.svg?v=2" width="96" height="96" alt="HULO Geo-block logo"></a></p>

# @huloglobal/vendure-plugin-geo-block

Per-channel storefront geo-restriction for Vendure. Allow / block by
country, by curated region preset (37 of them: EU, EEA, Schengen, GCC,
ANZ, NATO, Commonwealth, …), by ISO-3166-2 subdivision (US states, CA
provinces, AU states, DE Länder, IT regions, FR regions, ES autonomous
communities, IN states, BR units, MX entities, UK constituent
countries). IPv4/IPv6 IP allowlist, business hours, per-channel maintenance
windows, optional server-side purchase enforcement, a local MaxMind-file
country fallback, soft-block mode, audit log and simulator.

**Free vs licensed.** The free tier genuinely enforces: country and preset
rules (5 presets: Worldwide, UK only, EU, North America, Oceania), the IP
allowlist, business hours, maintenance windows, purchase enforcement (hard
block), the crawler allowlist with optional reverse-DNS checks and the
branded block page. A licence (or the 14-day evaluation) adds all 37
presets, subdivisions, soft-block mode, the audit log and stats, the
simulator, and the weekly report and set-up checklist.

**New in 0.15:** server-side purchase enforcement (opt-in per channel) ·
IPv6 CIDR allowlists · business-hours and per-channel maintenance tabs in
the admin · local MaxMind database fallback · reverse-DNS check for
Googlebot/Bingbot · "Add my IP" · Settings tab and country-source
diagnostic · 403 / 503 + Retry-After on the block page.

**New in 0.7:** SEO-safe bot allowlist so Googlebot / Bingbot / social
crawlers bypass by default · per-channel business-hours schedule
(overnight windows + DST handled) · one-line storefront drop-in JS
(`hulo-geo.js`) · branded block page (`/geo-block/blocked`).

Maintained by Wayne Garrison.

## Buy

14-day free evaluation (no card needed — start it from the admin), then **£4.95/month**, or **£99 one-off lifetime** at
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

            // -- Optional country fallback: a MaxMind-format file already on this server --
            maxmindDbPath: '/usr/share/GeoIP/GeoLite2-Country.mmdb',
            // -- Optional: Googlebot / Bingbot must pass a reverse-DNS check --
            verifyBots: true,
        }),
    ],
};
```

Add `GeoBlockPlugin.uiExtensions` to your `compileUiExtensions` config.

### Upgrading to 0.15: database migration

0.15.0 adds two Channel custom fields (`geoBlockMaintenance`,
`geoBlockEnforcePurchases`). With `synchronize: true` nothing is needed.
Otherwise generate a migration as usual (`npx vendure migrate`) or add the
one the package ships:

```ts
import { GeoBlockChannelFields1763020800000 } from '@huloglobal/vendure-plugin-geo-block';
// dbConnectionOptions: { migrations: [GeoBlockChannelFields1763020800000, /* … */] }
```

It only adds missing columns (safe next to a generated migration), works on
MariaDB/MySQL and PostgreSQL, and leaves purchase enforcement **off** on
every existing channel.

### Admin UI

- **Settings → Geo Block** in the admin navigation (shared
  `GeoBlockNavModule`, registered by `uiExtensions`), opening the page at
  `/admin/extensions/geo-block`: channel picker, Rules (including the
  purchase-enforcement switch), Block page, IP allowlist (with **Add my
  IP**), Business hours, Maintenance, Simulate, Stats and Settings tabs,
  with a live plain-English readout of what the current rules do.
- **Dashboard → Add widget → Geo Block**: blocked, soft-blocked and unique
  IPs over the last 7 days, plus the licence lifecycle notice.
- **Set-up checklist** and **Weekly report** cards on the landing page
  (premium, see below), the licence banner with buy-from-admin, and one
  update banner when a new version is on npm.


> **Visitor IP:** the plugin uses Express's `req.ip` (set `trustProxy` on the
> Vendure host). Only list headers your edge sets and strips from clients in
> `trustedIpHeaders`, e.g. `['cf-connecting-ip']` behind Cloudflare.
> **Visitor country:** `CF-IPCountry` / `cf-region-code`, Akamai
> `X-Akamai-Edgescape` and Fastly `X-Country-Code` are believed only when the
> request came through a proxy trusted by `trustProxy`. Behind anything other
> than Cloudflare, set `trustedCountryHeaders` to your edge's one header (e.g.
> `['x-country-code']`) so a visitor cannot send a `CF-IPCountry` of their own.
> Without a trusted header the plugin can read a local MaxMind-format file
> (`maxmindDbPath`). A visitor whose country cannot be resolved is allowed
> (fail-open). Admin → Geo Block → Settings shows where YOUR country came
> from (CDN header, MaxMind file or nothing) and why.
> Audit rows are pruned after 90 days / 500 000 rows by default
> (`retention: false` keeps everything).

> **Unlicensed / after the evaluation:** saved rules are still enforced on
> `/geo-block/site-config`, `/geo-block/check` and (when switched on) the
> server-side purchase enforcement, on the free tier: `mode` is always
> `block` (no soft-block banner), subdivision rules are ignored, only the 5
> free presets can be **added** (on every save path: the admin page, the
> REST and GraphQL saves and the Channel custom field; presets saved while
> licensed are kept), and no audit log is written. The simulator, stats,
> weekly report and set-up checklist pause; settings and data are kept.

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

Per-channel `mode` field (premium). `block` hides the storefront
entirely; `soft` renders it with a "we don't ship to your country"
banner. A soft block is a banner only: it does not hide or refuse the
checkout (use a full block with purchase enforcement for that). The
verdict `mode` field is returned on `/geo-block/check` so the storefront
knows how to render. On the free tier `soft` acts as `block`.

### Server-side purchase enforcement (opt-in)

The storefront helper and `/check` only advise the storefront; a visitor
can skip them and call the Shop API directly. Switch on **Refuse purchases
from blocked visitors** (Rules tab, or the channel custom field
`geoBlockEnforcePurchases`) and Vendure itself refuses, for a visitor the
rules fully block (country rules, business hours, maintenance):

- `addItemToOrder` and quantity increases (an `OrderInterceptorError`
  carrying the channel's block message), and
- the move to `ArrangingPayment` (checkout).

It is **off by default**, including on existing channels after the upgrade,
and it **fails open**: an unknown country, an Admin-API call (draft
orders), any lookup error or exception means "allow". A soft block stays a
banner. The IP allowlist still applies; crawlers get no exemption for
purchases (a User-Agent is not identity). Payments already under way
(webhooks, settlement) are never touched. Refusals are written to the
audit log (premium) with reason `purchase:<reason>`.

### Business hours and maintenance

**Business hours** (Business hours tab, or the `geoBlockSchedule` JSON
field): days, opening and closing time (overnight ranges work), time zone,
and what happens outside them: full block, soft block (premium) or allow.
**Maintenance** (Maintenance tab, per channel; the `maintenanceWindow` init
option still covers every channel): start and end (at most 31 days),
extra IPs that get in, and a message. Both apply even when the country
rules are off. The IP allowlist and allowlisted crawlers bypass both (so
search engines keep the site indexed).

### Status codes

The HTML block page (`/geo-block/blocked`) answers **403** for a geo
refusal and **503 with `Retry-After`** for business hours and maintenance,
with `X-Robots-Tag: noindex`, so crawlers and caches never store it as the
page. `/geo-block/check` keeps answering 200 with JSON (what the
storefront helper expects); add `?status=1` to get the same 403 / 503 for a
full block, for edge middleware that only looks at the status.

### Generic subdivisions

JSON map `{ "US": ["CA","NY"], "DE": ["BY"] }` enforced on visitors via
the channel custom field `geoBlockAllowedSubdivisions`. Catalogue at
`GET /geo-block/subdivisions` covers 11 countries (200+ subdivisions).
Legacy GB-only `allowedGbRegions` is preserved for back-compat.

### IP allowlist (IPv4 and IPv6, with CIDR)

Per-channel list of IPs / ranges (`203.0.113.0/24`, `2001:db8::/48`; /8
or narrower) that bypass every rule. Use for offices, oncall,
payment-processor probes, monitoring. **Add my IP** adds the address the
server sees for you. Before 0.15 IPv6 ranges were compared as text and
never matched. Saving rules that would allow nobody (an empty allow-list)
is refused: they are saved switched off, with a warning.

### Crawlers and reverse DNS

Well-known search and social crawlers bypass the rules for page views by
default (`botAllowlist`, or the Settings tab: strict, permissive, custom
list or off). With **Verify Googlebot and Bingbot** (`verifyBots`) a
visitor claiming to be one of them must pass a reverse + forward DNS check
(the server's own resolver, cached a day, 2 s timeout); a fake "Googlebot"
is then an ordinary visitor.

### Audit log + stats (premium)

Every block decision recorded in `geo_block_event` with country, region,
IP (hashed by default), UA, channel and reason. Admin Stats panel
shows top blocked countries, daily series and reason breakdown.

### "What-if" simulator (premium)

`POST /geo-block/admin/simulate` dry-runs a hypothetical visitor against
current rules without persisting anything — try any country / UK
region / IP and see exactly what would happen, for a page view and for a
purchase.

### Custom block page

Per-channel `blockMessage`, `blockRedirectUrl`, `blockLogoUrl`. Falls
back to sensible defaults per block reason.

The same page serves the block, "closed" (business hours) and maintenance
cases: a centred white card on a light grey background with the channel's
logo (or the `storeName` option) above a 3px bar in the `accentColor`
(default `#155dfc`), a heading, the channel's own message, an optional
**Continue** button to `blockRedirectUrl`, the support e-mail and a short
reference. It uses one `<main>` landmark and one heading, visible focus
rings, and keeps the button text readable on light accents (it switches to
dark text below 4.5:1 contrast). Text from the URL is never shown: unknown
`?reason=` values become `geo` and `?country=` must be a two-letter code.
Only `http(s)` redirect and logo URLs are used, even when the custom fields
were edited in the plain Channel form.

### Proxy-aware, with a local MaxMind fallback

Reads `cf-ipcountry` / Akamai / Fastly region headers from a trusted
proxy (see *Visitor country* above). Without one, `maxmindDbPath` points
at a MaxMind-format database already on the server (GeoLite2-Country or
-City, GeoIP2-Country, DB-IP Lite MMDB). It is read locally, re-read when
the file changes (keep it fresh with MaxMind's `geoipupdate`) and never
downloaded by the plugin; private and reserved addresses are never looked
up. A missing or broken file means "country unknown" (allowed).

### Settings tab

`GeoBlockPlugin.init()` options are the defaults; the Settings tab
(SuperAdmin) overrides the safe ones: crawler mode and custom list,
`verifyBots`, the support e-mail, the block page's store name and accent
colour, the public rate limit, the helper's cache age and audit-IP hashing. Reset returns to the init value. Trusted
headers, the signing secret, the IP salt and the MaxMind path stay in code
and are shown read-only.

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

The weekly report and the set-up checklist are **premium** (licence or
evaluation). On the free tier the report is not sent (Send-a-test and
Preview answer 402) and the checklist is not shown; settings are kept and
both resume when a licence is active.

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
| `GET` | `/geo-block/check` | public | per-request decision + reason (logs to audit); `?status=1` → 403/503 |
| `GET` | `/geo-block/presets` | public | 37-preset catalogue (with `countries`) |
| `GET` | `/geo-block/subdivisions` | public | subdivision catalogue (11 countries) |
| `GET` | `/geo-block/admin/channels` | admin | list channels + rules |
| `POST` | `/geo-block/admin/save` | admin | save a channel's rules |
| `GET` | `/geo-block/admin/stats` | admin | block totals + top countries + series |
| `POST` | `/geo-block/admin/simulate` | admin | dry-run a hypothetical visitor (premium) |
| `POST` | `/geo-block/admin/add-my-ip` | admin (UpdateCatalog) | add the caller's IP to a channel's allowlist `{token}` |
| `GET` | `/geo-block/admin/diagnostic` | admin | country-source diagnostic for the caller |
| `GET` | `/geo-block/admin/settings` | admin | effective settings, overrides, read-only init options |
| `POST` | `/geo-block/admin/settings` | SuperAdmin | override settings (`null` resets one) |
| `POST` | `/geo-block/admin/gc` | admin | prune old audit rows |
| `GET` | `/geo-block/status` | admin | version + update status |
| `GET` | `/geo-block/licence/status` | admin | licence, tier, lifecycle notice, premium features, recent stats |
| `POST` | `/geo-block/eval/remind-me` | admin | "email me before the evaluation ends" opt-in |
| `GET` | `/geo-block/setup` | admin | set-up checklist (`items`, `complete`, `premium`; empty on the free tier) |
| `GET` | `/geo-block/widget` | admin | dashboard widget feed (7-day figures) |
| `GET` | `/geo-block/digest/settings` | admin | weekly report settings |
| `POST` | `/geo-block/digest/settings` | admin | update `{enabled?, recipient?}` |
| `POST` | `/geo-block/digest/send-test` | admin | send this week's report now `{to?}` (premium) |
| `GET` | `/geo-block/digest/preview` | admin | this week's report as HTML (premium) |
| `GET` | `/geo-block/hulo-geo.js` | public | storefront drop-in helper JS |
| `GET` | `/geo-block/blocked` | public | branded block page (HTML 403 / 503 + Retry-After, or JSON) |

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

The source is licensed under the GNU AGPL version 3 (`AGPL-3.0-only`, see
`LICENSE`). A licence key unlocks the premium features listed above; buy
one at
[elite.charity/licence/buy/vendure-plugin-geo-block](https://elite.charity/licence/buy/vendure-plugin-geo-block).
