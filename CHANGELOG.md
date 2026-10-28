# Changelog

All notable changes to `@huloglobal/vendure-plugin-geo-block` are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.1] — 2026-10-28

### Changed
- Every install now gets a 14-day evaluation with all features on and no card (granted by the HULO licence server). The licence banner's buttons read **Subscribe**: during the evaluation the first charge falls on the day it ends, so there is no second free trial.

## [0.14.0] — 2026-10-11

Merchant engagement pass (licence-sdk 0.15.0).

### Added
- **Weekly report.** Every Monday at 08:00 (server time) the worker emails
  what Geo Block did last week — hard blocks, soft blocks and distinct
  addresses blocked, week-on-week — plus the next set-up step and the
  licence lifecycle notice. Sent through the host's `SMTP_*` environment
  (`nodemailer` is an optional peer dependency); off when SMTP is unset.
  Recipient: the configured `supportEmail`, else the licence customer, else
  the trial-reminder address. Settings, "Send me a test" and "Preview" live
  on the admin page (`GET/POST /geo-block/digest/settings`,
  `POST /geo-block/digest/send-test`, `GET /geo-block/digest/preview`).
  Preferences are stored in the shared `hulo_plugin_prefs` table.
- **Set-up checklist** on the admin landing page (`GET /geo-block/setup`):
  rules set on a channel, block page customised, own IP allow-listed,
  simulation run. Real checks against the channel rows; "Hide" is
  remembered in the browser until a done item comes undone.
- **Dashboard widget** "Geo Block" (Dashboard → Add widget): blocked,
  soft-blocked and unique IPs over the last 7 days, the lifecycle notice
  and a link to the page (`GET /geo-block/widget`).
- **Admin navigation**: Settings → Geo Block (`GeoBlockNavModule`, shared).
- **Usage numbers with the heartbeat.** The 30-day `requestsBlocked`,
  `requestsSoftBlocked` and `uniqueIpsBlocked` counts already sent with the
  evaluation ping now also go with the daily heartbeat after purchase, so
  renewal emails can say what the plugin did.
- `POST /geo-block/eval/remind-me` — "Email me before it ends" on the trial
  banner, proxied to the licence server; the address is kept as the report
  fallback recipient.
- `GET /geo-block/licence/status` gains `notice` (trial/key lifecycle
  sentence), `premiumFeatures` and `recentStats` (top 30-day figures).
- Hero tile "Blocked · last 7 days" above the tabs, so the headline figure
  is visible without opening Stats.

### Changed
- One update banner instead of two; "Dismiss" is remembered per version.
- Licensed banner shows "renews automatically — current key valid until
  <date>" for subscriptions and an amber notice in the last two weeks of a
  key or trial. Trial and free banners list the premium features and a
  "So far: …" line from real figures.
- A 402 (premium feature) from Stats shows an unlock chip in the tab; other
  402s and `licence-required` bodies produce one consistent toast.
- `@huloglobal/vendure-licence-sdk` `^0.15.0`.

## [0.13.3] — 2026-09-28

Follow-up to the 0.13.2 hardening pass.

### Added
- **Per-install audit-IP salt.** When `ipSalt` is unset, a random salt is
  generated once at boot and stored in `hulo_licence_store` (key
  `vendure-plugin-geo-block:ipsalt`, first writer wins so server and
  worker agree) instead of hashing every install's audit IPs with the same
  public constant. A boot warning says a generated salt is in use.
- **Live allow-list preview.** `GET /geo-block/presets` now includes each
  preset's `countries`; the admin page resolves the allow-list, the status
  sentence and the lockout warning in the browser from the form state
  (`ui/resolve-allowed.ts`, unit-tested against the server resolver)
  instead of the list the server computed at load time.
- Postgres corpus test (`src/pg-corpus.test.ts`, runs when `HULO_PG_URL`
  is set): every raw SQL statement in `src/` is translated by the dialect
  adapter and executed against PostgreSQL 17 with TypeORM-quoted stand-ins
  for `channel` and `geo_block_event`.
- `presetCountries(key)` is exported.

### Fixed
- **Unlicensed `site-config` contract.** The public `site-config` never
  applied the free-tier gate that `/check` applied (`mode=block`, no
  subdivisions), so a storefront caching `site-config` could render the
  soft-block banner while `/check` blocked. The gate now lives in
  `buildConfig`, so `site-config`, `check` and the simulator agree. The
  README and e2e no longer claim the free tier returns `enabled:false`.

## [0.13.2] — 2026-09-28

Reliability and security pass — no new features.

### Fixed
- **Client IP could be forged.** `/check` and the rate limiter trusted
  `X-Forwarded-For`, `CF-Connecting-IP`, `True-Client-IP` and `X-Real-IP`
  from any client, so anyone could send an allow-listed office address
  and walk through the block. The visitor address is now Express's
  `req.ip` (honouring the host's `trust proxy`); vendor headers are only
  read when listed in the new `trustedIpHeaders` option. IPv4-mapped IPv6
  addresses (`::ffff:…`) now match IPv4 allowlist entries; matching is
  case-insensitive.
- **Storefront helper blocked cross-origin.** `hulo-geo.js` carried
  `Cross-Origin-Resource-Policy: same-origin`, so a storefront on a
  different origin than the API could not load it. It is now
  `cross-origin`.
- **Postgres.** Channel custom-field columns and the audit table's
  `createdAt`/`channelId` are quoted in raw SQL; `SUM(boolean)` replaced
  with `SUM(CASE …)`; the enabled flag is bound as a boolean.
- **GraphQL admin API** queried columns that do not exist
  (`customFields_huloGeoBlock…`); `geoBlockChannels`, `geoBlockSaveChannel`
  and `geoBlockSimulate` now use the real columns and the same JSON-array
  storage as the REST routes.
- `?country=`/`?region=` overrides must be plain ISO codes and, when a
  `signingSecret` is set, both must be signed (`regionSig`).
- `maintenanceWindow.allowedIps` is honoured; the simulator applies
  subdivisions and reports schedule, bot and maintenance verdicts like
  enforcement does.
- Schedules typed with day numbers as strings no longer block every day;
  the midnight hour can no longer render as `24:xx` (fail-open).
- Self-update and licence activate/deactivate/purchase/portal require
  SuperAdmin; `admin/stats` authenticates before revealing the tier.
- Save validation: bounded lists, ISO country codes, known preset keys,
  parseable IPs/CIDRs (prefix ≥ 8), http(s)-only redirect and logo URLs;
  rejected values are returned in the response.

### Changed
- Audit rows are written with `insert` after the response (no longer
  awaited); `url` now records the referring page instead of the API URL.
- Retention defaults to 90 days / 500 000 rows (`retention: false` to
  keep everything); a `(channelId, createdAt)` index is declared on
  `geo_block_event` (run your migrations).
- Channel rules are cached for 10 s in the server process; `/check`
  answers `Cache-Control: no-store`; `/presets` and `/subdivisions` are
  cacheable for an hour.
- Bootstrap side effects (retention sweeper, claim poller) run on the
  server only.
- Admin UI: first-run "Worldwide" writes the canonical key (no false
  lockout warning), the update banner is no longer shown twice, the copy
  button copies a real `@`, timers are cleared on destroy.

## [0.13.1] — 2026-09-02

### Changed
- **Branding.** The bundled `hulo-global-logo.svg` is now the HG wordmark on the HULO black rounded square (the same mark as the huloglobal.com header), with explicit `-light` and `-dark` variants alongside the auto-switching default.

## [0.13.0] — 2026-09-02

### Added
- **Licence & billing card in the admin.** Always visible: the current state (free tier, free trial with first-charge date, monthly/annual subscription, lifetime, or master licence) with the actions that apply — start the 14-day free trial or subscribe, buy lifetime, **Manage billing** (Stripe customer portal: update card, cancel, switch plan) and **Upgrade to lifetime** (the old subscription stops billing at the end of its paid period). Requires licence SDK ^0.14.0.

## [0.12.1] — 2026-09-02

### Changed
- **The 14-day free trial is now card-backed.** Unlicensed installs run in the free tier; start the trial from the admin banner (monthly or annual → *Start 14-day free trial*) — Stripe collects a card, nothing is charged until day 15, cancel any time before then, one trial per customer — and the licence installs itself within a minute. The automatic no-card evaluation window is retired (licence SDK ^0.13.0).

## [0.12.0] — 2026-09-02

### Added
- **Buy licence from the admin.** The evaluation / free-tier banner now has a plan picker and a **Buy licence** button: checkout opens in a new tab and, once payment completes, the licence **installs itself** — no email round-trip, no `.env` edit, no restart. Renewed subscription keys are picked up automatically too. New admin endpoints `licence/purchase-link` and `licence/claim-status`.

### Changed
- Requires `@huloglobal/vendure-licence-sdk` ^0.12.0.
- The 7-day card trial at checkout has been retired: every install already gets the 14-day no-card evaluation, and paid plans now bill from day one.

## [0.11.2] — 2026-09-02

### Changed
- **Pricing.** Geo-block is now £4.95/month, £49.50/year or £99 lifetime (was £9.95 / £99.50 / £199). README updated; the 14-day evaluation is unchanged.

## [0.11.1] — 2026-09-02

### Changed
- **Licence SDK ^0.11.0.** Master licences (one key that activates every HULO plugin) and hardware-bound keys are now accepted by the runtime licence check.
- **Branding.** Refreshed HULO Global logo (inline HG monogram) in the admin UI.

## [0.11.0] — 2026-08-25

### Added
- **PostgreSQL support.** All of the plugin's SQL now runs on Postgres as
  well as MySQL/MariaDB — the licence SDK's new dialect adapter translates
  queries transparently at runtime, so no configuration is needed: the
  plugin follows whatever database your Vendure `dbConnectionOptions` use.
  Verified against PostgreSQL 17. MySQL/MariaDB installs are unaffected
  (byte-identical passthrough).

## [0.10.1] — 2026-08-25

### Changed
- The update banner's "What's new" link now opens the plugin's
  changelog page on huloglobal.com, so you can read exactly what a
  release contains before updating.

## [0.10.0] — 2026-08-23

### Added
- **One-click in-app updates.** The update banner now has an "Update
  now" button: the plugin installs the new version via your project's
  own package manager (yarn/npm/pnpm auto-detected), verifies it landed,
  and gracefully restarts under your process supervisor (pm2/systemd).
  Admin-only; the target version is verified against the npm registry;
  a failed install never restarts anything. Disable with
  HULO_SELF_UPDATE=off; force restart without a detected supervisor
  with HULO_SELF_UPDATE=force. Note: a separate worker process picks
  the update up on its next restart, and the admin UI itself refreshes
  after your next admin build.

## [0.9.1] — 2026-08-23

### Added
- **Update notifications in the admin UI.** When a newer version is on
  npm, a dismissible banner shows current → latest with a copy-ready
  install command and a link to what's new. (Update data comes from the
  existing daily registry check — no new network calls.)

## [0.9.0] — 2026-08-21

### Added
- **In-admin licence activation.** A banner on the admin page shows the
  evaluation countdown (or free-tier state) with a paste-your-key box:
  the key is verified with the exact boot-time checks and activates
  instantly — no .env edit, no redeploy. Persisted in the shared
  hulo_licence_store table and restored on boot; env/init keys always
  take precedence. New licence/status, licence/activate and
  licence/deactivate admin endpoints.

## [0.8.0] — 2026-08-21

### Added
- **14-day full-featured evaluation.** Unlicensed installs now get the
  complete feature set for 14 days instead of the restricted free tier.
  Premium blocking features now also run during the evaluation window. The clock is anchored server-side (a hashed
  instance id — no personal data), so reinstalling does not restart it,
  and it fails open: if the licence server is unreachable the plugin
  keeps running fully. After the window the plugin drops to the free
  tier; all configuration is kept and reactivates instantly with a key.
## [0.7.4] — 2026-07-30

### Fixed
- **Buttons rendered unstyled in the admin.** The page borrowed Clarity
  button classes (`btn btn-secondary` etc.) from the admin shell, but the
  built admin CSS defines `.btn` only contextually and `.btn-secondary`
  not at all — "+ Add" and friends rendered as bare native buttons.
  Every control is now styled by the component itself (`.gbtn` system).
- **Unreadable muted text.** Secondary text leaned on
  `--color-component-color-200/300`, which the admin never defines, so
  hardcoded slate fallbacks applied in both themes — unreadable on dark
  surfaces. Replaced by per-theme ink tokens.
- **Invisible control boundaries.** The admin border tokens fail
  WCAG 1.4.11 in both themes (light `#bfc3cc` ≈ 1.7:1; dark border-200 is
  *darker than the surface*, 1.01:1). Inputs/buttons/switch now use a
  dedicated `--gb-ui-border` at ≥ 3:1 per theme.

### Added
- **Accessibility, verified not assumed.** `scripts/contrast-check.py`
  simulates the shipped `color-mix()` tokens against the real admin
  theme values and checks every text/surface pair — 40/40 WCAG AA pass
  (≥ 4.5:1 text, ≥ 3:1 UI boundaries) in light and dark.
- **Enforcement toggle switch** (`role="switch"`, keyboard + focus ring)
  replaces the ON/OFF pill + button pair.
- **ARIA tabs** (`role="tablist"`/`tab`, `aria-selected`), labelled chip
  remove buttons, `aria-expanded` on collapsibles, `:focus-visible`
  rings on every control, `prefers-reduced-motion` support.
- **Sticky save bar** — stays in view, shows "Unsaved changes" with an
  amber accent when dirty, and disables Save/Discard when clean.

## [0.7.3] — 2026-07-29

### Fixed
- **Dark mode.** All semantic surfaces (success/warning/danger/info
  tints) are derived from the live theme variables with `color-mix()`
  instead of hardcoded light-mode pastels, which produced light-text-on-
  cream unreadables in the dark theme (worst: selected preset cards).

### Changed
- Active tab restyled to brand amber; IP allowlist tab shows a bypass-IP
  count badge; save bar highlights when there are unsaved changes.

## [0.7.2] — 2026-07-29

### Changed
- **Admin page redesign** on the unified HULO admin design system:
  brand hero with help drawer, plain-English status sentence describing
  exactly what the current rules do (with lockout warning), first-run
  panel, tabbed layout (Rules / Block page / IP allowlist / Simulate /
  Stats), KPI tiles and mini-bar country table on Stats.

## [0.7.0] — 2026-07-07

### Added
- **Bot / crawler allowlist.** New plugin option `botAllowlist`, defaulting
  to `'strict'` — matches every well-known SEO + social crawler
  (Googlebot, Bingbot, DuckDuckBot, Baidu, Yandex, AppleBot, Slurp,
  facebookexternalhit, Twitterbot, LinkedInBot, Slackbot, WhatsApp,
  Discord, Telegram, Pinterest, Reddit + more). Ships crawler-safe
  by default so restrictive geo rules don't silently drop search-engine
  crawls and de-index the site. Also accepts `'permissive'` (any UA
  self-identifying as bot / crawler / spider), `false` (no allowlist —
  use only when a WAF handles bots upstream), or a custom pattern
  array of strings + regexes. New audit decision `bot-allowlist`.
- **Business-hours schedule.** New per-channel custom field
  `geoBlockSchedule` — a JSON object with `timezone`, `days`, `from`,
  `to`, and `outsideAction` (`block` / `soft` / `allow`). Recurring
  weekly window per channel; outside the window the configured action
  fires. Handles overnight windows and DST via `Intl.DateTimeFormat`.
  New audit decision `schedule`. IP + bot allowlists still bypass so
  ops and crawlers never see "closed for orders".
- **Storefront drop-in helper JS** at `GET /geo-block/hulo-geo.js`.
  One `<script src>` with `data-channel-token="…"` and the store gets
  geo-blocking with zero custom code. Vanilla JS, no dependencies,
  fails open on network error, ~2 KB minified. Optional attrs:
  `data-redirect`, `data-timeout-ms`, `data-preview`. Cached
  `public, max-age=300, stale-while-revalidate=1200` (configurable via
  new plugin option `storefrontHelperMaxAgeSec`).
- **Branded block page** at `GET /geo-block/blocked?t=…&reason=…`.
  Self-contained HTML — inline CSS, no deps, HULO amber-on-navy
  identity. Renders channel `blockLogoUrl`, message, optional
  redirect CTA, and support email (new plugin option `supportEmail`).
  Returns JSON when `Accept: application/json`. Rate-limited.
- **HULO brand logo** shipped as `logo.svg` in the package root
  (globe + amber block-slash on the navy HULO frame).

### Changed
- `/geo-block/check` now runs the bot allowlist and business-hours
  schedule checks alongside the existing IP allowlist + maintenance
  window checks. Precedence: IP allowlist → bot allowlist → schedule
  → maintenance → country / region rules.
- `loadChannelRow` now includes `geoBlockSchedule` and the previously-
  missing `geoBlockAllowedSubdivisions` field, so subdivision rules
  now round-trip correctly through the storefront `/check` path.

### Fixed
- Subdivision map (`geoBlockAllowedSubdivisions`) was defined as a
  channel custom field but never read into the runtime config on
  `/check` — the storefront verdict ignored it. Now honoured
  end-to-end (on licensed installs — unlicensed still forces the
  map to empty per the 0.4 tier gates).

## [0.6.0] — 2026-07-04

### Added
- Boot-time compatibility check via the new SDK helper
  `warnIfIncompatibleVendure()`. Logs a non-fatal warning when the runtime
  `@vendure/core` version is outside the tested range. Silent when inside;
  fail-open on unparseable versions.

### Changed
- Peer dep on `@vendure/core` tightened to `>=3.5.0 <4.0.0` — Vendure 3.5,
  3.6 and 3.7 are all covered. Anything under 3.5 has never been tested;
  anything from 4.0 upwards is deferred until the changelog is reviewed.
- Uses `@huloglobal/vendure-licence-sdk@^0.6.0`.

## [0.5.0] — 2026-06-23

### Added
- Vendure Admin API GraphQL extensions. Operator endpoints are now
  first-class GraphQL queries and mutations alongside the existing REST
  admin endpoints: `geoBlockPresets`, `geoBlockChannels`, `geoBlockStats`
  (paid), `geoBlockSaveChannel`, `geoBlockSimulate` (paid).
- Storefront paths (`/geo-block/check`, `/geo-block/site-config`) stay
  REST — they're anonymous, high-frequency, cacheable at the edge, and
  GraphQL was never the right shape for them.

## [0.4.0] — 2026-06-23

### Added
- Tier-gating on every premium feature via the SDK's `isLicensed()`
  helper. Unlicensed installs get:
  - only the 5 free-tier region presets (Worldwide, UK, EU, North
    America, Oceania) instead of all 37;
  - `mode` forced to `block` — no soft-block;
  - no audit log persistence;
  - no subdivision map honoured;
  - 402 on the stats + simulator endpoints.

  Commenting out a boot check no longer unlocks anything — the gates
  are enforced at each call site.
- Anti-tamper heartbeat via the SDK. Anonymous daily fingerprint of
  the embedded public key + verifier source. No personal data.

### Changed
- Relicensed the GitHub source to AGPL-3.0. Published npm builds remain
  under the commercial licence documented at
  <https://huloglobal.com/legal/terms/>.
- npm builds now include Sigstore provenance attestations.

## [0.3.2] — 2026-06-21

### Changed
- 44px minimum tap targets on every interactive element in the admin UI.

## [0.3.1] — 2026-06-21

### Changed
- Comprehensive README refresh — documents the full v0.3 feature set
  including the 37 region presets, generic subdivisions catalogue,
  security primitives, and opt-in retention.

## [0.3.0] — 2026-06-20

### Added
- Generic country-subdivisions schema. New channel custom field
  `geoBlockAllowedSubdivisions` storing a JSON map
  `{ "US": ["CA","NY"], "DE": ["BY"] }`. Storefront enforcement checks
  both the new map and the legacy GB-only field.
- Curated subdivision catalogue for 11 countries (GB, US, CA, AU, DE,
  IT, FR, ES, IN, BR, MX) — 200+ subdivisions, surfaced at
  `GET /geo-block/subdivisions`.
- Admin UI: subdivisions hidden behind a toggle by default; pick any
  country to apply a subdivision filter.
- Rate limiter (120 requests / 60s default) on `/site-config` + `/check`.
- HMAC-gated `?country=` override on `/check` (`signingSecret`).
- Hashed audit IPs by default (`hashAuditIps`, `ipSalt`).
- Security headers on every response.
- Opt-in retention sweeper via `options.retention`.

## [0.2.3] — 2026-06-20

### Changed
- Mobile-friendly admin UI — channel row + tab bar stack and scroll
  horizontally, preset and mode grids collapse to single column.

## [0.2.2] — 2026-06-20

### Changed
- Republish targeting `@huloglobal/vendure-licence-sdk@^0.2.0`.

## [0.2.1] — 2026-06-20

### Added
- `UpdateChecker` integration — `/geo-block/status` endpoint returns
  version + update info; admin banner appears on new releases.

## [0.2.0] — 2026-06-20

### Added
- **37 region presets** (up from 8) — EU, EEA, EFTA, Schengen, Nordic,
  Baltic, Benelux, DACH, Iberia, Balkans, GCC, MENA, ASEAN, APAC, East
  Asia, South Asia, LATAM, Central America, Caribbean, Africa, G7, G20,
  BRICS, OECD, NATO, Five Eyes, Commonwealth, English-speaking, and more.
- **Soft-block mode** — per-channel `mode` field (`block` or `soft`).
  Soft mode renders the storefront with a "we don't ship here" banner
  instead of hiding it.
- **IP allowlist with IPv4 CIDR** — per-channel list of IPs / ranges
  that bypass every rule. For offices, oncall, payment processors.
- **Audit log** — new `GeoBlockEvent` entity records every block
  decision (country, region, IP, UA, reason).
- **Stats endpoint** — `GET /geo-block/admin/stats` returns block totals,
  top blocked countries, daily series and reason breakdown.
- **Simulator endpoint** — `POST /geo-block/admin/simulate` dry-runs a
  hypothetical visitor against current rules without persisting anything.
- **Custom block page** — per-channel `blockMessage`, `blockRedirectUrl`,
  `blockLogoUrl` fields.
- **Scheduled maintenance window** — plugin option for a one-shot
  date-range lockdown (every visitor blocked except the IP allowlist).
- **Per-request `/geo-block/check` endpoint** — visitors can be checked
  on the fly with logging to the audit table.
- **Presets catalogue endpoint** — `GET /geo-block/presets` lists every
  preset with metadata (kind, description, country count).
- Redesigned admin UI: five tabs (Rules / Block page / IP allowlist /
  Simulate / Stats) with filterable preset picker, soft/hard mode
  toggle and a live simulator.

### Changed
- Admin UI now calls `/geo-block/admin/*` directly (no `/ees/` prefix).
- `isAllowed()` and `ipMatchesAny()` exported for downstream use.

## [0.1.0] — 2026-06-19

### Added
- `GeoBlockPlugin` registering five Channel customFields per channel
  (enable toggle, region presets, allowed countries, blocked countries,
  UK region sub-filter).
- Public `/geo-block/site-config` endpoint serving a flat resolved
  allow-list per channel.
- Admin endpoints `/geo-block/admin/channels` and `/geo-block/admin/save`.
- Dedicated admin UI page with mode picker, region preset cards, chip
  pickers, live preview of the resolved allow-list.
- `resolveAllowedCountries` exported as a pure helper.
- Licence verification via `@huloglobal/vendure-licence-sdk` with
  revocation polling.

[0.6.0]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.6.0
[0.5.0]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.5.0
[0.4.0]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.4.0
[0.3.2]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.3.2
[0.3.1]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.3.1
[0.3.0]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.3.0
[0.2.3]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.2.3
[0.2.2]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.2.2
[0.2.1]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.2.1
[0.2.0]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.2.0
[0.1.0]: https://github.com/exceeded/vendure-plugin-geo-block/releases/tag/v0.1.0
