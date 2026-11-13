/**
 * 0.15.0 parity wave, end to end on the free tier (evaluation expired):
 * B4 (IPv6 CIDR, server-side preset limit on REST, GraphQL and the Channel
 * custom field), premium weekly report / checklist / simulator, lockout
 * refusal, business hours + maintenance saved from the admin, 403/503 status
 * codes, "Add my IP", the country-source diagnostic, the settings overrides
 * and the opt-in server-side purchase enforcement (off by default, fail open).
 */
import { startLicenceStub } from './local-licence-env';
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SimpleGraphQLClient, SqljsInitializer, testConfig } from '@vendure/testing';
import { gql } from 'graphql-tag';
import type { Server } from 'http';
import * as path from 'path';
import { initialData } from '../../../e2e-shared/initial-data';
import { GeoBlockPlugin } from '../src/plugin';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const PORT = Number(process.env.GEO_PARITY_E2E_PORT || 3463);
let TOKEN = '';

describe('geo-block 0.15.0 parity (free tier)', () => {
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        plugins: [GeoBlockPlugin.init({
            publicBaseUrl: `http://localhost:${PORT}`,
            // The test drives the visitor's IP and country with headers.
            trustedIpHeaders: ['x-real-ip'],
            trustedCountryHeaders: ['cf-ipcountry'],
        })],
    });
    const { server, adminClient, shopClient } = createTestEnvironment(config);
    let stub: Server;
    let superToken = '';
    let variantId = '';
    let shippingMethodId = '';

    const rest = (p: string, o: { method?: string; body?: any; headers?: Record<string, string>; auth?: boolean } = {}) =>
        fetch(`http://localhost:${PORT}${p}`, {
            method: o.method || 'GET',
            headers: {
                'content-type': 'application/json',
                ...(o.auth === false ? {} : { authorization: `Bearer ${superToken}` }),
                'vendure-token': TOKEN,
                ...(o.headers || {}),
            },
            body: o.body ? JSON.stringify(o.body) : undefined,
        });
    const save = (rules: any) => rest('/geo-block/admin/save', { method: 'POST', body: { token: TOKEN, ...rules } });
    const channel = async () => (await (await rest('/geo-block/admin/channels')).json()).channels.find((c: any) => c.token === TOKEN);

    beforeAll(async () => {
        stub = await startLicenceStub(false);
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
        await (GeoBlockPlugin as any).evalClientInternal?.check();
        expect(GeoBlockPlugin.hasPremiumAccess()).toBe(false);
        await adminClient.asSuperAdmin();
        superToken = adminClient.getAuthToken();
        TOKEN = (await adminClient.query(gql`query { activeChannel { token } }`)).activeChannel.token;

        const { createProduct } = await adminClient.query(gql`mutation {
            createProduct(input: { enabled: true, translations: [{ languageCode: en, name: "Geo e2e", slug: "geo-e2e", description: "" }] }) { id }
        }`);
        const { createProductVariants } = await adminClient.query(gql`mutation ($productId: ID!) {
            createProductVariants(input: [{ productId: $productId, sku: "GEO-E2E", price: 1000, trackInventory: FALSE, translations: [{ languageCode: en, name: "Geo e2e" }] }]) { id }
        }`, { productId: createProduct.id });
        variantId = createProductVariants[0].id;
        const { createShippingMethod } = await adminClient.query(gql`mutation {
            createShippingMethod(input: {
                code: "geo-e2e-ship", fulfillmentHandler: "manual-fulfillment",
                checker: { code: "default-shipping-eligibility-checker", arguments: [{ name: "orderMinimum", value: "0" }] },
                calculator: { code: "default-shipping-calculator", arguments: [{ name: "rate", value: "0" }, { name: "includesTax", value: "auto" }, { name: "taxRate", value: "0" }] },
                translations: [{ languageCode: en, name: "E2E delivery" }]
            }) { id }
        }`);
        shippingMethodId = createShippingMethod.id;
    }, 90_000);

    afterAll(async () => {
        await server.destroy();
        await new Promise(r => stub.close(r));
    });

    describe('B4: five presets on the free tier, enforced server-side', () => {
        it('REST save drops a premium preset and reports it', async () => {
            const r = await (await save({ enabled: true, allowedRegions: ['EU', 'GCC'], extraAllowed: ['GB'] })).json();
            expect(r.lockedPresets).toEqual(['GCC']);
            expect((await channel()).allowedRegions).toEqual(['EU']);
        });
        it('GraphQL save refuses a premium preset', async () => {
            await expect(adminClient.query(gql`mutation { geoBlockSaveChannel(input: { channelToken: "${TOKEN}", regionPreset: "NATO" }) { enabled } }`))
                .rejects.toThrow(/licen[cs]e|premium/i);
            const ok = await adminClient.query(gql`mutation { geoBlockSaveChannel(input: { channelToken: "${TOKEN}", regionPreset: "EU" }) { regionPreset } }`);
            expect(ok.geoBlockSaveChannel.regionPreset).toBe('EU');
        });
        it('the Channel custom field refuses a new premium preset too', async () => {
            const { activeChannel } = await adminClient.query(gql`query { activeChannel { id } }`);
            await expect(adminClient.query(gql`mutation ($id: ID!) {
                updateChannel(input: { id: $id, customFields: { geoBlockAllowedRegions: ["SCHENGEN"] } }) { ... on Channel { id } ... on ErrorResult { message } }
            }`, { id: activeChannel.id })).rejects.toThrow(/licence/i);
        });
    });

    describe('premium: weekly report, checklist, simulator', () => {
        it('setup checklist is not shown and the report is not sent on the free tier', async () => {
            expect(await (await rest('/geo-block/setup')).json()).toEqual({ items: [], complete: true, premium: false });
            expect((await rest('/geo-block/digest/send-test', { method: 'POST', body: { to: 'x@example.test' } })).status).toBe(402);
            expect((await rest('/geo-block/digest/preview')).status).toBe(402);
            expect((await (await rest('/geo-block/digest/settings')).json()).premium).toBe(false);
            expect((await rest('/geo-block/admin/simulate', { method: 'POST', body: { token: TOKEN, country: 'US' } })).status).toBe(402);
        });
    });

    describe('lockout refusal', () => {
        it('rules that allow nobody are saved switched off (REST and GraphQL)', async () => {
            const r = await (await save({ enabled: true, allowedRegions: [], extraAllowed: [] })).json();
            expect(r.lockout).toBe(true);
            expect((await channel()).enabled).toBe(false);
            const g = await adminClient.query(gql`mutation { geoBlockSaveChannel(input: { channelToken: "${TOKEN}", enabled: true, regionPreset: "", allowedCountries: [] }) { enabled lockout } }`);
            expect(g.geoBlockSaveChannel).toEqual({ enabled: false, lockout: true });
        });
    });

    describe('enforcement on the free tier: IPv6 allowlist, statuses, maintenance, business hours', () => {
        beforeAll(async () => {
            const r = await save({ enabled: true, allowedRegions: [], extraAllowed: ['GB'], ipAllowlist: ['2001:db8:abcd::/48', '0.0.0.0/0'] });
            const body = await r.json();
            expect(body.rejected).toEqual(['0.0.0.0/0']);
        });
        const check = (country: string, ip: string, q = '') =>
            rest(`/geo-block/check${q}`, { auth: false, headers: { 'cf-ipcountry': country, 'x-real-ip': ip } });

        it('blocks by country and lets an IPv6 CIDR allowlist through (B4)', async () => {
            expect((await (await check('US', '81.2.69.1')).json()).allowed).toBe(false);
            expect(await (await check('US', '2001:db8:abcd:7::1')).json()).toMatchObject({ allowed: true, reason: 'ip-allowlist' });
            expect((await (await check('GB', '81.2.69.1')).json()).allowed).toBe(true);
        });
        it('/check keeps 200 by default and answers 403 with ?status=1', async () => {
            expect((await check('US', '81.2.69.1')).status).toBe(200);
            expect((await check('US', '81.2.69.1', '?status=1')).status).toBe(403);
        });
        it('the HTML block page answers 403, or 503 + Retry-After for maintenance', async () => {
            const geo = await rest(`/geo-block/blocked?t=${TOKEN}&reason=country-not-allowed`, { auth: false });
            expect(geo.status).toBe(403);
            expect(geo.headers.get('x-robots-tag')).toContain('noindex');
            const m = await rest(`/geo-block/blocked?t=${TOKEN}&reason=maintenance`, { auth: false });
            expect(m.status).toBe(503);
            expect(m.headers.get('retry-after')).toBeTruthy();
        });
        it('a per-channel maintenance window is saved, listed and enforced; its own IPs bypass', async () => {
            const startsAt = new Date(Date.now() - 60_000).toISOString();
            const endsAt = new Date(Date.now() + 3_600_000).toISOString();
            const bad = await save({ enabled: true, extraAllowed: ['GB'], maintenance: { startsAt: endsAt, endsAt: startsAt } });
            expect(bad.status).toBe(400);
            const ok = await save({ enabled: true, extraAllowed: ['GB'], ipAllowlist: ['2001:db8:abcd::/48'], maintenance: { startsAt, endsAt, allowedIps: ['198.51.100.7'], message: 'Upgrading' } });
            expect(ok.status).toBeLessThan(300);
            const c = await channel();
            expect(c.maintenance).toMatchObject({ allowedIps: ['198.51.100.7'], message: 'Upgrading' });
            expect(c.maintenanceActive).toBe(true);
            const r = await check('GB', '81.2.69.1', '?status=1');
            expect(r.status).toBe(503);
            expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(3000);
            expect(await r.json()).toMatchObject({ allowed: false, reason: 'maintenance', message: 'Upgrading' });
            expect((await (await check('GB', '198.51.100.7')).json()).allowed).toBe(true);
            const page = await (await rest(`/geo-block/blocked?t=${TOKEN}&reason=maintenance`, { auth: false })).text();
            expect(page).toContain('Upgrading');
            // Clearing it (null) ends maintenance; omitting it leaves it alone.
            await save({ enabled: true, extraAllowed: ['GB'], ipAllowlist: ['2001:db8:abcd::/48'], maintenance: null });
            expect((await channel()).maintenance).toBeNull();
        });
        it('business hours are saved from the admin and enforced', async () => {
            const bad = await save({ enabled: true, extraAllowed: ['GB'], schedule: { from: '25:00', to: '10:00' } });
            expect(bad.status).toBe(400);
            // Open on no day of the week that is today (in UTC) -> closed now.
            const today = ((new Date().getUTCDay() + 6) % 7) + 1;
            const other = today === 1 ? 2 : 1;
            await save({ enabled: true, extraAllowed: ['GB'], ipAllowlist: ['2001:db8:abcd::/48'], schedule: { timezone: 'UTC', days: [other], outsideAction: 'soft', outsideMessage: 'Closed today' } });
            expect((await channel()).schedule).toMatchObject({ timezone: 'UTC', days: [other], outsideAction: 'soft' });
            const r = await (await check('GB', '81.2.69.1')).json();
            // Free tier: a soft action is a full block.
            expect(r).toMatchObject({ allowed: false, reason: 'schedule', mode: 'block', message: 'Closed today' });
            await save({ enabled: true, extraAllowed: ['GB'], ipAllowlist: ['2001:db8:abcd::/48'], schedule: null });
            expect((await (await check('GB', '81.2.69.1')).json()).allowed).toBe(true);
        });
    });

    describe('Add my IP and the country-source diagnostic', () => {
        it('adds the caller\'s own address (as the plugin sees it) once', async () => {
            const a = await (await rest('/geo-block/admin/add-my-ip', { method: 'POST', body: { token: TOKEN }, headers: { 'x-real-ip': '2001:db8:ffff::9' } })).json();
            expect(a).toMatchObject({ ok: true, ip: '2001:db8:ffff::9', added: true });
            const b = await (await rest('/geo-block/admin/add-my-ip', { method: 'POST', body: { token: TOKEN }, headers: { 'x-real-ip': '2001:db8:ffff::9' } })).json();
            expect(b.added).toBe(false);
            expect((await channel()).ipAllowlist).toContain('2001:db8:ffff::9');
            expect((await rest('/geo-block/admin/add-my-ip', { method: 'POST', auth: false, body: { token: TOKEN } })).status).toBe(401);
        });
        it('reports where the country came from and why it is missing', async () => {
            const withCdn = await (await rest('/geo-block/admin/diagnostic', { headers: { 'cf-ipcountry': 'FR', 'x-real-ip': '81.2.69.1' } })).json();
            expect(withCdn).toMatchObject({ ip: '81.2.69.1', country: 'FR', source: 'cdn' });
            const none = await (await rest('/geo-block/admin/diagnostic', { headers: { 'x-real-ip': '81.2.69.1' } })).json();
            expect(none.source).toBe('none');
            expect(none.maxmind).toEqual({ configured: false });
            expect(none.notes.join(' ')).toMatch(/maxmindDbPath/);
        });
    });

    describe('settings: init options are defaults, admin overrides win', () => {
        it('reads, overrides, validates and resets', async () => {
            const s0 = await (await rest('/geo-block/admin/settings')).json();
            expect(s0.effective).toMatchObject({ botMode: 'strict', verifyBots: false, rateLimitPerMinute: 120 });
            expect(s0.readOnly.trustedIpHeaders).toEqual(['x-real-ip']);
            const bad = await rest('/geo-block/admin/settings', { method: 'POST', body: { rateLimitPerMinute: 1 } });
            expect(bad.status).toBe(400);
            const s1 = await (await rest('/geo-block/admin/settings', { method: 'POST', body: { botMode: 'off', supportEmail: 'help@shop.test' } })).json();
            expect(s1.effective).toMatchObject({ botMode: 'off', supportEmail: 'help@shop.test' });
            // With the crawler exemption off, a "Googlebot" from the US is blocked like anyone else.
            const g = await (await rest('/geo-block/check', { auth: false, headers: { 'cf-ipcountry': 'US', 'x-real-ip': '66.249.66.1', 'user-agent': 'Googlebot/2.1' } })).json();
            expect(g.allowed).toBe(false);
            const s2 = await (await rest('/geo-block/admin/settings', { method: 'POST', body: { botMode: null, supportEmail: null } })).json();
            expect(s2.overrides).toEqual({});
            const g2 = await (await rest('/geo-block/check', { auth: false, headers: { 'cf-ipcountry': 'US', 'x-real-ip': '66.249.66.1', 'user-agent': 'Googlebot/2.1' } })).json();
            expect(g2).toMatchObject({ allowed: true, reason: 'bot-allowlist' });
        });
    });

    describe('server-side purchase enforcement', () => {
        const add = async (country: string | null, ip = '81.2.69.1') => {
            shopClient.setHeader('cf-ipcountry', country);
            shopClient.setHeader('x-real-ip', ip);
            return (await shopClient.query(gql`mutation ($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { ... on Order { id code state } ... on OrderInterceptorError { interceptorError } ... on ErrorResult { errorCode message } } }`, { id: variantId })).addItemToOrder;
        };

        it('is off by default: a blocked country can still add to the order (unchanged behaviour)', async () => {
            expect((await channel()).enforcePurchases).toBe(false);
            await shopClient.asAnonymousUser();
            expect((await add('US')).code).toBeTruthy();
        });

        it('when switched on, refuses adding to the order and checkout for a fully blocked visitor', async () => {
            await save({ enabled: true, extraAllowed: ['GB'], ipAllowlist: ['2001:db8:ffff::9'], blockMessage: 'UK only, sorry.', enforcePurchases: true });
            expect((await channel()).enforcePurchases).toBe(true);
            const added = await add('US');
            expect(added).toMatchObject({ errorCode: 'ORDER_INTERCEPTOR_ERROR' });
            expect(added.interceptorError).toContain('UK only');
            // The order started before cannot move to checkout either.
            await shopClient.query(gql`mutation { setCustomerForOrder(input: { emailAddress: "geo@example.test", firstName: "Geo", lastName: "Buyer" }) { ... on Order { id } ... on ErrorResult { errorCode } } }`);
            await shopClient.query(gql`mutation { setOrderShippingAddress(input: { fullName: "Geo Buyer", streetLine1: "1 Main St", city: "Austin", postalCode: "73301", countryCode: "US" }) { ... on Order { id } } }`);
            await shopClient.query(gql`mutation ($id: [ID!]!) { setOrderShippingMethod(shippingMethodId: $id) { ... on Order { id } ... on ErrorResult { errorCode } } }`, { id: [shippingMethodId] });
            const t = await shopClient.query(gql`mutation { transitionOrderToState(state: "ArrangingPayment") { ... on Order { state } ... on OrderStateTransitionError { errorCode transitionError } } }`);
            expect(t.transitionOrderToState.errorCode).toBe('ORDER_STATE_TRANSITION_ERROR');
            expect(t.transitionOrderToState.transitionError).toContain('UK only');
        });

        it('fails open for an unknown country and lets allowed countries and the IP allowlist buy', async () => {
            const unknown = await add(null);
            if (!unknown.code) throw new Error(JSON.stringify(unknown));
            expect((await add('GB')).code).toBeTruthy();
            expect((await add('US', '2001:db8:ffff::9')).code).toBeTruthy();
        });

        it('a soft block (premium) is a banner only: purchases go ahead', async () => {
            const spy = jest.spyOn(GeoBlockPlugin, 'hasPremiumAccess').mockReturnValue(true);
            try {
                await save({ enabled: true, mode: 'soft', extraAllowed: ['GB'], enforcePurchases: true });
                expect((await add('US')).code).toBeTruthy();
            } finally {
                spy.mockRestore();
            }
            // Back on the free tier the same saved soft mode is a full block.
            expect(await add('US')).toMatchObject({ errorCode: 'ORDER_INTERCEPTOR_ERROR' });
        });

        it('the Admin API is never refused', async () => {
            const r = await adminClient.query(gql`mutation { createDraftOrder { id } }`);
            const d = await adminClient.query(gql`mutation ($o: ID!, $v: ID!) { addItemToDraftOrder(orderId: $o, input: { productVariantId: $v, quantity: 1 }) { ... on Order { id } ... on ErrorResult { errorCode } } }`, { o: r.createDraftOrder.id, v: variantId });
            expect(d.addItemToDraftOrder.id).toBeTruthy();
            shopClient.setHeader('cf-ipcountry', null);
            shopClient.setHeader('x-real-ip', null);
        });
    });
});
