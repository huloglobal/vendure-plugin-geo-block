/**
 * 0.16.0: the visitor-facing block / closed / maintenance page (shared card
 * design, escaping, accessible markup, accent contrast), the URL filter for
 * channel custom fields and the store-name / accent settings.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildBlockedPageHtml,
    buildHuloGeoJs,
    contrastRatio,
    escapeHtml,
    normaliseBlockedReason,
    onAccentText,
} from './storefront-assets';
import { buildConfig, safeHttpUrl } from './channel-rules';
import { DEFAULT_ACCENT_COLOR, effectiveSettings, normaliseHexColor, sanitiseOverrides, setOverrides } from './settings';

afterEach(() => setOverrides({}));

describe('block page', () => {
    const base = { reason: 'country-not-allowed' as const, message: 'This service is not available in your country.' };

    it('is a centred card on #f3f4f6 with a 3px accent bar, one h1, lang and a main landmark', () => {
        const html = buildBlockedPageHtml({ ...base, storeName: 'Acme Ltd', accentColor: '#155dfc' });
        expect(html).toContain('<html lang="en">');
        expect(html).toContain('<main');
        expect(html.match(/<h1>/g)).toHaveLength(1);
        expect(html).toContain('background: #f3f4f6');
        expect(html).toContain('border-bottom: 3px solid var(--accent)');
        expect(html).toContain('--accent: #155dfc');
        expect(html).toContain('<span class="store">Acme Ltd</span>');
        expect(html).toContain('<title>Not available in your region · Acme Ltd</title>');
        expect(html).toContain('font-family: Arial, Helvetica, sans-serif');
        expect(html).toContain(':focus-visible');
        expect(html).not.toContain('alertdialog');
        expect(html).not.toMatch(/HULO/i);
    });

    it('shows the logo with the store name as alt text instead of the name', () => {
        const html = buildBlockedPageHtml({ ...base, storeName: 'Acme', logoUrl: 'https://cdn.example/logo.png' });
        expect(html).toContain('<img class="logo" src="https://cdn.example/logo.png" alt="Acme"');
        expect(html).not.toContain('<span class="store">');
    });

    it('escapes every interpolated value', () => {
        const html = buildBlockedPageHtml({
            reason: 'geo',
            message: '<script>alert(1)</script>',
            storeName: '"><img src=x onerror=alert(1)>',
            logoUrl: 'https://x.example/a.png" onerror="alert(1)',
            redirectUrl: "https://x.example/?a='b'",
            supportEmail: 'a"b@x.example',
        });
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('"><img src=x');
        expect(html).not.toContain('" onerror="');
        expect(html).toContain('&#39;b&#39;');
        expect(html).toContain('a&quot;b@x.example');
    });

    it('per-reason copy for closed and maintenance pages, with the reference in the footer', () => {
        const closed = buildBlockedPageHtml({ reason: 'schedule', message: 'Open 9 to 5' });
        expect(closed).toContain('Sorry, we’re closed');
        expect(closed).toContain('<title>Closed</title>');
        const m = buildBlockedPageHtml({ reason: 'maintenance', message: 'Upgrading' });
        expect(m).toContain('Back soon');
        expect(m).toContain('Reference: <span class="mono">maintenance</span>');
    });

    it('only shows a valid two-letter country, in an info box', () => {
        expect(buildBlockedPageHtml({ ...base, country: 'US' })).toContain('Your location</span><span class="mono">US</span>');
        expect(buildBlockedPageHtml({ ...base, country: 'X<1' })).not.toContain('Your location');
    });

    it('falls back to the default accent for anything that is not #rrggbb', () => {
        expect(buildBlockedPageHtml({ ...base, accentColor: 'red;}body{display:none' })).toContain('--accent: #155dfc');
    });

    it('keeps the button text readable on a light accent', () => {
        expect(onAccentText('#155dfc')).toBe('#ffffff');
        expect(onAccentText('#fde047')).toBe('#111827');
        expect(contrastRatio('#155dfc', '#ffffff')).toBeGreaterThanOrEqual(4.5);
        const html = buildBlockedPageHtml({ ...base, accentColor: '#fde047' });
        expect(html).toContain('--on-accent: #111827');
        expect(html).toContain('--link: #111827');
    });

    it('never echoes an unknown ?reason=', () => {
        expect(normaliseBlockedReason('call +44 20 0000 0000')).toBe('geo');
        expect(normaliseBlockedReason('MAINTENANCE')).toBe('maintenance');
        expect(normaliseBlockedReason(undefined)).toBe('geo');
    });

    it('escapeHtml covers single quotes', () => {
        expect(escapeHtml(`<a href='x'>&"`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;&quot;');
    });
});

describe('channel URL fields (also editable in the plain Channel form)', () => {
    it('only http(s) URLs pass', () => {
        expect(safeHttpUrl('https://shop.example/blocked')).toBe('https://shop.example/blocked');
        expect(safeHttpUrl(' http://x.example ')).toBe('http://x.example');
        expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
        expect(safeHttpUrl('JaVaScRiPt:alert(1)')).toBeNull();
        expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
        expect(safeHttpUrl('//evil.example')).toBeNull();
        expect(safeHttpUrl('https://x.example/" onerror="x')).toBeNull();
        expect(safeHttpUrl('')).toBeNull();
        expect(safeHttpUrl(null)).toBeNull();
    });

    it('a javascript: redirect saved in the Channel form never reaches the storefront config', () => {
        const cfg = buildConfig('tok', { geoBlockEnabled: 1, blockRedirectUrl: 'javascript:alert(document.cookie)', blockLogoUrl: 'data:image/svg+xml,<svg onload=alert(1)>' }, true);
        expect(cfg.geoBlock.blockRedirectUrl).toBeNull();
        expect(cfg.geoBlock.blockLogoUrl).toBeNull();
        const ok = buildConfig('tok', { blockRedirectUrl: 'https://shop.example/sorry' }, true);
        expect(ok.geoBlock.blockRedirectUrl).toBe('https://shop.example/sorry');
    });

    it('the storefront helper only follows http(s) redirect targets', () => {
        const js = buildHuloGeoJs({ publicBaseUrl: 'https://api.example' });
        expect(js).toContain('function safeUrl(u)');
        expect(js).toContain('override || safeUrl(v.redirectUrl)');
        expect(js).not.toMatch(/override \|\| v\.redirectUrl/);
    });
});

describe('store name and accent settings', () => {
    it('default accent is #155dfc and store name empty (existing installs unchanged)', () => {
        const s = effectiveSettings();
        expect(s.accentColor).toBe(DEFAULT_ACCENT_COLOR);
        expect(DEFAULT_ACCENT_COLOR).toBe('#155dfc');
        expect(s.storeName).toBe('');
    });

    it('validates and normalises the accent colour; null or empty resets', () => {
        expect(normaliseHexColor('#ABC')).toBe('#aabbcc');
        expect(normaliseHexColor('0f766e')).toBe('#0f766e');
        expect(normaliseHexColor('red')).toBeNull();
        const o = sanitiseOverrides({}, { accentColor: '#0F766E', storeName: '  Acme\u0000 Ltd  ' });
        expect(o).toEqual({ accentColor: '#0f766e', storeName: 'Acme Ltd' });
        expect(() => sanitiseOverrides({}, { accentColor: 'url(x)' })).toThrow(/hex colour/);
        expect(sanitiseOverrides(o, { accentColor: '' })).not.toHaveProperty('accentColor');
        setOverrides(o);
        expect(effectiveSettings().accentColor).toBe('#0f766e');
        expect(effectiveSettings().storeName).toBe('Acme Ltd');
    });
});
