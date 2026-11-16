/**
 * Storefront-side assets served by the plugin: a drop-in helper JS
 * that a store can `<script src>` to get geo-blocking with zero code,
 * and a self-contained HTML block page that plugin can redirect to.
 *
 * Design goals:
 *   - Both assets have zero runtime deps. Vanilla JS + inline CSS.
 *   - Aggressively cacheable (5 min public + SWR) — the block-check
 *     is a separate call, this file is static per publicBaseUrl.
 *   - Small: the helper is < 3 KB minified; the block page is < 4 KB.
 *   - No PII collection — the helper only calls /geo-block/check and
 *     reads the JSON response.
 */

interface HeloOpts {
    /** Public origin the storefront calls for geo checks. */
    publicBaseUrl: string;
}

/**
 * Storefront helper: a one-line drop-in that enforces geo-block on
 * any HTML page. Reads the channel token from the `<script>` tag's
 * `data-channel-token` attribute, calls `/geo-block/check`, then:
 *
 *   - if allowed: no-op (site renders as normal)
 *   - if blocked with mode=block: redirects to `/geo-block/blocked`
 *     (which renders the branded block page)
 *   - if blocked with mode=soft: injects a top-of-page banner
 *     linking to the block page
 *
 * Optional attributes on the script tag:
 *   data-redirect="/somewhere-else"  — override block redirect
 *   data-timeout-ms="2500"            — network timeout (default 3000)
 *   data-preview                       — logs verdict, no side effects
 *
 * The check runs on `DOMContentLoaded` so it doesn't block first paint.
 * A visitor with JS disabled sees the storefront as normal — the
 * server-side integration (route middleware) is the strong path.
 */
export function buildHuloGeoJs(opts: HeloOpts): string {
    const publicBaseUrl = String(opts.publicBaseUrl || '').replace(/\/+$/, '');
    return `/*! HULO geo-block storefront helper — vendored, no deps.
 * Docs: https://huloglobal.com/vendure-plugins/geo-block */
(function () {
  'use strict';
  var s = (function () {
    var s = document.currentScript;
    if (s) return s;
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/hulo-geo\\.js/.test(all[i].src)) return all[i];
    }
    return null;
  })();
  if (!s) return;
  var token = s.getAttribute('data-channel-token') || '';
  var override = s.getAttribute('data-redirect') || '';
  var preview = s.hasAttribute('data-preview');
  var timeoutMs = parseInt(s.getAttribute('data-timeout-ms') || '3000', 10);
  if (!token) { if (preview) console.warn('[hulo-geo] missing data-channel-token'); return; }
  var base = ${JSON.stringify(publicBaseUrl)};
  // Only http(s) targets are followed (the server already filters them).
  function safeUrl(u) { u = String(u || ''); return /^https?:\/\//i.test(u) ? u : null; }
  function log() { if (preview) try { console.info.apply(console, ['[hulo-geo]'].concat([].slice.call(arguments))); } catch (e) {} }
  function go() {
    var url = base + '/geo-block/check';
    var ctl = null;
    if (typeof AbortController !== 'undefined') { ctl = new AbortController(); setTimeout(function () { ctl.abort(); }, timeoutMs); }
    fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: { 'vendure-token': token, 'accept': 'application/json' },
      signal: ctl ? ctl.signal : undefined,
    }).then(function (r) { return r.json(); }).then(function (v) {
      log('verdict', v);
      if (!v || v.allowed) return;
      if (preview) return;
      var mode = v.mode || 'block';
      if (mode === 'block') {
        var target = override || safeUrl(v.redirectUrl)
          || (base + '/geo-block/blocked?reason=' + encodeURIComponent(v.reason || 'geo')
              + (v.message ? '&msg=' + encodeURIComponent(v.message) : '')
              + '&t=' + encodeURIComponent(token));
        window.location.replace(target);
      } else if (mode === 'soft') {
        injectBanner(v.message || 'This site does not currently ship to your region.',
          override || safeUrl(v.redirectUrl));
      }
    }).catch(function (e) { log('fetch error — failing open', e && e.message); });
  }
  function injectBanner(msg, moreHref) {
    if (document.getElementById('hulo-geo-banner')) return;
    var b = document.createElement('div');
    b.id = 'hulo-geo-banner';
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:sticky;top:0;left:0;right:0;z-index:2147483647;'
      + 'background:#0f1419;color:#fff;padding:12px 16px;font:14px system-ui,sans-serif;'
      + 'text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.35);';
    var t = document.createElement('span'); t.textContent = String(msg);
    b.appendChild(t);
    if (moreHref) {
      var a = document.createElement('a');
      a.href = String(moreHref); a.textContent = 'Learn more';
      a.style.cssText = 'color:#f59e0b;margin-left:12px;text-decoration:underline;';
      b.appendChild(a);
    }
    var mount = function () {
      if (!document.body) return setTimeout(mount, 20);
      document.body.insertBefore(b, document.body.firstChild);
    };
    mount();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go);
  } else { go(); }
})();
`;
}

export type BlockedPageReason = 'country-not-allowed' | 'denylist' | 'uk-region-not-allowed' | 'subdivision-not-allowed' | 'schedule' | 'maintenance' | 'geo';

/** Reasons the block page knows. Anything else in `?reason=` becomes `geo`,
 *  so the page never echoes text from the URL. */
export const BLOCKED_PAGE_REASONS: readonly BlockedPageReason[] = [
    'country-not-allowed', 'denylist', 'uk-region-not-allowed', 'subdivision-not-allowed', 'schedule', 'maintenance', 'geo',
];

export function normaliseBlockedReason(raw: any): BlockedPageReason {
    const r = String(raw ?? '').trim().toLowerCase();
    return (BLOCKED_PAGE_REASONS as readonly string[]).includes(r) ? r as BlockedPageReason : 'geo';
}

/** HTML-escape for text and double- or single-quoted attributes. */
export function escapeHtml(s: any): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function channelLuminance(c: number): number {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: string, b: string): number {
    const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

/** Text colour for a button filled with `accent`: white unless the accent is
 *  too light for white text (WCAG AA 4.5:1), then near-black. */
export function onAccentText(accent: string): string {
    return contrastRatio(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#111827';
}

/** Link colour on the white card: the accent when it is readable on white,
 *  otherwise the body ink (links stay underlined either way). */
export function linkColourOnWhite(accent: string): string {
    return contrastRatio(accent, '#ffffff') >= 4.5 ? accent : '#111827';
}

const PAGE_COPY: Record<BlockedPageReason, { label: string; heading: string; title: string }> = {
    'country-not-allowed': { label: 'Not available', heading: 'Sorry, this store is not available', title: 'Not available in your region' },
    'denylist': { label: 'Not available', heading: 'Sorry, this store is not available', title: 'Not available in your region' },
    'uk-region-not-allowed': { label: 'Not available', heading: 'Sorry, this store is not available', title: 'Not available in your region' },
    'subdivision-not-allowed': { label: 'Not available', heading: 'Sorry, this store is not available', title: 'Not available in your region' },
    'geo': { label: 'Not available', heading: 'Sorry, this store is not available', title: 'Not available in your region' },
    'schedule': { label: 'Closed', heading: 'Sorry, we’re closed', title: 'Closed' },
    'maintenance': { label: 'Maintenance', heading: 'Back soon', title: 'Back soon' },
};

/**
 * The visitor-facing block, closed and maintenance page: a centred white
 * card on a light grey background (the same design as the plugin's e-mails),
 * with the merchant's logo or store name over a 3px accent bar, the channel's
 * own message, an optional "Continue" button and the support address.
 *
 * Takes RAW values and escapes every one of them here. URLs must already be
 * filtered to http(s) (`safeHttpUrl`); the accent must be a `#rrggbb` colour.
 * Accessible: `lang`, one `<main>` landmark with one `<h1>`, the reference in
 * a footer, visible focus rings, AA contrast for text, links and the button.
 */
export function buildBlockedPageHtml(input: {
    reason: BlockedPageReason;
    message: string;
    country?: string | null;
    logoUrl?: string | null;
    redirectUrl?: string | null;
    supportEmail?: string | null;
    storeName?: string | null;
    accentColor?: string | null;
}): string {
    const reason = normaliseBlockedReason(input.reason);
    const copy = PAGE_COPY[reason];
    const accent = /^#[0-9a-f]{6}$/i.test(String(input.accentColor || '')) ? String(input.accentColor).toLowerCase() : '#155dfc';
    const onAccent = onAccentText(accent);
    const link = linkColourOnWhite(accent);
    const store = String(input.storeName || '').trim();
    const country = /^[A-Z]{2}$/.test(String(input.country || '')) ? String(input.country) : '';
    const e = escapeHtml;
    const brand = input.logoUrl
        ? `<img class="logo" src="${e(input.logoUrl)}" alt="${e(store)}" width="160" height="48">`
        : (store ? `<span class="store">${e(store)}</span>` : '');
    const title = store ? `${copy.title} · ${store}` : copy.title;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${e(title)}</title>
  <style>
    :root { --accent: ${accent}; --on-accent: ${onAccent}; --link: ${link}; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #f3f4f6; color: #374151; font-family: Arial, Helvetica, sans-serif; -webkit-font-smoothing: antialiased; }
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
    .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; width: 100%; max-width: 600px; overflow: hidden; }
    .brand { padding: 22px 28px; border-bottom: 3px solid var(--accent); min-height: 24px; }
    .logo { display: block; width: auto; height: auto; max-width: 160px; max-height: 48px; }
    .store { font-size: 18px; font-weight: bold; color: #111827; }
    .body { padding: 28px; }
    .lbl { display: block; font-size: 12px; font-weight: bold; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 8px; }
    h1 { font-size: 22px; line-height: 28px; font-weight: bold; color: #111827; margin: 0 0 10px; }
    p { font-size: 14px; line-height: 22px; margin: 0 0 16px; }
    .info { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; font-size: 14px; color: #111827; }
    .info .lbl { margin-bottom: 4px; }
    .mono { font-family: Consolas, Menlo, monospace; }
    .btn { display: inline-block; background: var(--accent); color: var(--on-accent); font-size: 15px; font-weight: bold; text-decoration: none; padding: 13px 26px; border-radius: 8px; }
    .btn:hover { filter: brightness(.95); }
    a { color: var(--link); }
    a:focus-visible, .btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    .help { font-size: 14px; line-height: 22px; margin: 18px 0 0; }
    .foot { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 14px 28px; font-size: 11px; line-height: 16px; color: #6b7280; }
    @media (max-width: 480px) { .brand, .body { padding-left: 20px; padding-right: 20px; } .foot { padding-left: 20px; padding-right: 20px; } }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="card">
      <header class="brand">${brand}</header>
      <div class="body">
        <span class="lbl">${e(copy.label)}</span>
        <h1>${e(copy.heading)}</h1>
        <p>${e(input.message)}</p>
        ${country ? `<div class="info"><span class="lbl">Your location</span><span class="mono">${e(country)}</span></div>` : ''}
        ${input.redirectUrl ? `<a class="btn" href="${e(input.redirectUrl)}">Continue</a>` : ''}
        ${input.supportEmail ? `<p class="help">Questions? E-mail <a href="mailto:${e(input.supportEmail)}">${e(input.supportEmail)}</a>.</p>` : ''}
      </div>
      <footer class="foot">Reference: <span class="mono">${e(reason)}</span></footer>
    </div>
  </main>
</body>
</html>`;
}
