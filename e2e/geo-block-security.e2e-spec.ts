import { startLicenceStub } from './local-licence-env';
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SimpleGraphQLClient, SqljsInitializer, testConfig } from '@vendure/testing';
import { gql } from 'graphql-tag';
import type { Server } from 'http';
import * as path from 'path';
import { initialData } from '../../../e2e-shared/initial-data';
import { GeoBlockPlugin } from '../src/plugin';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const PORT = 3062;
let DEFAULT_TOKEN = '';
const B_TOKEN = 'geo-e2e-channel-b';

describe('geo-block security', () => {
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        plugins: [GeoBlockPlugin.init({ publicBaseUrl: `http://localhost:${PORT}` })],
    });
    const { server, adminClient } = createTestEnvironment(config);
    let stub: Server;
    let superToken = '';
    let bAdminToken = '';
    let bClient: SimpleGraphQLClient;

    const rest = (p: string, o: { token?: string; channel?: string; method?: string; body?: any; headers?: Record<string, string> } = {}) =>
        fetch(`http://localhost:${PORT}${p}`, {
            method: o.method || 'GET',
            headers: {
                'content-type': 'application/json',
                ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
                ...(o.channel ? { 'vendure-token': o.channel } : {}),
                ...(o.headers || {}),
            },
            body: o.body ? JSON.stringify(o.body) : undefined,
        });

    const saveRules = (token: string, channel: string, rules: any) =>
        rest('/geo-block/admin/save', { token, channel, method: 'POST', body: { token: channel, ...rules } });

    beforeAll(async () => {
        stub = await startLicenceStub(true);
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
        // Evaluation active (from the local stub) → premium routes (simulate) are on.
        await (GeoBlockPlugin as any).evalClientInternal?.check();
        expect(GeoBlockPlugin.hasPremiumAccess()).toBe(true);

        await adminClient.asSuperAdmin();
        superToken = adminClient.getAuthToken();
        DEFAULT_TOKEN = (await adminClient.query(gql`query { activeChannel { token } }`)).activeChannel.token;
        const { zones } = await adminClient.query(gql`query { zones { items { id } } }`);
        const zoneId = zones.items[0].id;
        const { createChannel } = await adminClient.query(gql`
            mutation ($input: CreateChannelInput!) { createChannel(input: $input) { ... on Channel { id token } } }`, {
            input: {
                code: 'channel-b', token: B_TOKEN, defaultLanguageCode: 'en', currencyCode: 'GBP',
                pricesIncludeTax: true, defaultTaxZoneId: zoneId, defaultShippingZoneId: zoneId,
            },
        });
        const { createRole } = await adminClient.query(gql`
            mutation ($input: CreateRoleInput!) { createRole(input: $input) { id } }`, {
            input: { code: 'b-catalog', description: 'Channel B catalogue', permissions: ['ReadCatalog', 'UpdateCatalog'], channelIds: [createChannel.id] },
        });
        await adminClient.query(gql`
            mutation ($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`, {
            input: { firstName: 'B', lastName: 'Admin', emailAddress: 'b-admin@example.test', password: 'b-admin-pw', roleIds: [createRole.id] },
        });
        // Separate client: logging in on adminClient would log the super-admin session out.
        bClient = new SimpleGraphQLClient(config as any, `http://localhost:${PORT}/admin-api`);
        await bClient.asUserWithCredentials('b-admin@example.test', 'b-admin-pw');
        bAdminToken = bClient.getAuthToken();
        bClient.setChannelToken(B_TOKEN);

        // Default channel: UK + France only, office IP allow-listed.
        // (The status is asserted in its own test: before 0.14.2 the save
        // route answered 404 on SQLite even though the UPDATE ran.)
        await saveRules(superToken, DEFAULT_TOKEN, { enabled: true, extraAllowed: ['GB', 'FR'], ipAllowlist: ['192.0.2.10'] });
        const list = await (await rest('/geo-block/admin/channels', { token: superToken, channel: DEFAULT_TOKEN })).json();
        expect(list.channels.find((c: any) => c.token === DEFAULT_TOKEN).enabled).toBe(true);
    }, 90_000);

    afterAll(async () => {
        await server.destroy();
        await new Promise(r => stub.close(r));
    });

    describe('channel scoping of the admin routes', () => {
        it('a channel-B admin cannot rewrite the default channel rules over REST', async () => {
            // Authenticated in channel B (vendure-token B), body names the default channel.
            const r = await rest('/geo-block/admin/save', {
                token: bAdminToken, channel: B_TOKEN, method: 'POST',
                body: { token: DEFAULT_TOKEN, enabled: false, ipAllowlist: ['203.0.113.0/24'] },
            });
            expect([403, 404]).toContain(r.status);
            const list = await (await rest('/geo-block/admin/channels', { token: superToken, channel: DEFAULT_TOKEN })).json();
            const def = list.channels.find((c: any) => c.token === DEFAULT_TOKEN);
            expect(def.enabled).toBe(true);
            expect(def.ipAllowlist).toEqual(['192.0.2.10']);
        });

        it('the save route succeeds for a channel the admin may edit (also on SQLite)', async () => {
            const r = await saveRules(superToken, DEFAULT_TOKEN, { enabled: true, extraAllowed: ['GB', 'FR'], ipAllowlist: ['192.0.2.10'] });
            expect(r.ok).toBe(true); // Nest answers POST with 201
            const missing = await saveRules(superToken, DEFAULT_TOKEN, { token: 'no-such-channel', enabled: true });
            expect(missing.status).toBe(404);
        });

        it('a channel-B admin can still manage channel B', async () => {
            const r = await saveRules(bAdminToken, B_TOKEN, { enabled: true, extraAllowed: ['DE'] });
            expect(r.ok).toBe(true);
        });

        it('a channel-B admin does not see other channels (tokens, IP allowlists) over REST', async () => {
            const body = await (await rest('/geo-block/admin/channels', { token: bAdminToken, channel: B_TOKEN })).json();
            expect(body.channels.map((c: any) => c.token)).toEqual([B_TOKEN]);
        });

        it('a channel-B admin cannot simulate against the default channel over REST', async () => {
            const r = await rest('/geo-block/admin/simulate', { token: bAdminToken, channel: B_TOKEN, method: 'POST', body: { token: DEFAULT_TOKEN, country: 'GB' } });
            expect([403, 404]).toContain(r.status);
        });

        it('GraphQL: a channel-B admin can neither list nor save the default channel', async () => {
            const { geoBlockChannels } = await bClient.query(gql`query { geoBlockChannels { channelToken } }`);
            expect(geoBlockChannels.map((c: any) => c.channelToken)).toEqual([B_TOKEN]);
            await expect(bClient.query(gql`
                mutation { geoBlockSaveChannel(input: { channelToken: "${DEFAULT_TOKEN}", enabled: false }) { enabled } }`))
                .rejects.toThrow();
            await expect(bClient.query(gql`
                mutation { geoBlockSimulate(input: { channelToken: "${DEFAULT_TOKEN}", country: "GB" }) { allowed } }`))
                .rejects.toThrow();
            const list = await (await rest('/geo-block/admin/channels', { token: superToken, channel: DEFAULT_TOKEN })).json();
            expect(list.channels.find((c: any) => c.token === DEFAULT_TOKEN).enabled).toBe(true);
        });
    });

    describe('GraphQL admin API reads the stored rules correctly', () => {
        it('geoBlockSimulate agrees with /admin/simulate for the saved allow-list', async () => {
            const q = (country: string) => adminClient.query(gql`
                mutation ($c: String) { geoBlockSimulate(input: { channelToken: "${DEFAULT_TOKEN}", country: $c }) { allowed reason } }`, { c: country });
            expect((await q('FR')).geoBlockSimulate.allowed).toBe(true);
            expect((await q('GB')).geoBlockSimulate.allowed).toBe(true);
            expect((await q('US')).geoBlockSimulate).toEqual({ allowed: false, reason: 'country-not-allowed' });
        });

        it('geoBlockChannels returns the stored lists, not their JSON text', async () => {
            const { geoBlockChannels } = await adminClient.query(gql`query { geoBlockChannels { channelToken allowedCountries ipAllowlist } }`);
            const def = geoBlockChannels.find((c: any) => c.channelToken === DEFAULT_TOKEN);
            expect(def.allowedCountries).toEqual(['GB', 'FR']);
            expect(def.ipAllowlist).toEqual(['192.0.2.10']);
        });
    });

    describe('/geo-block/blocked', () => {
        it('does not render attacker text from ?msg= on the store-branded page', async () => {
            const phish = 'Your order is on hold. Call +44 20 0000 0000 to pay by card';
            const r = await rest(`/geo-block/blocked?t=${DEFAULT_TOKEN}&reason=country-not-allowed&msg=${encodeURIComponent(phish)}`);
            const html = await r.text();
            expect(html).not.toContain('Call +44');
            expect(html).toContain('This service is not available in your country.');
        });
    });

    describe('/geo-block/check', () => {
        it('blocks a visitor outside the allow-list (via a country header from a trusted edge only)', async () => {
            const r = await (await rest('/geo-block/check', { channel: DEFAULT_TOKEN, headers: { 'cf-ipcountry': 'US' } })).json();
            // No trust proxy in the test config: the header came from the client and is ignored.
            expect(r.allowed).toBe(true);
        });

        it('assessment: without signingSecret, ?country= is the visitor\'s own claim', async () => {
            const us = await (await rest('/geo-block/check?country=US', { channel: DEFAULT_TOKEN })).json();
            const gb = await (await rest('/geo-block/check?country=GB', { channel: DEFAULT_TOKEN })).json();
            expect(us.allowed).toBe(false);
            expect(gb.allowed).toBe(true);
        });
    });
});
