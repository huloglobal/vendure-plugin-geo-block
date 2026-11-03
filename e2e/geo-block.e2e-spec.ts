import './local-licence-env'; // keep test runs off the live licence server
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import * as path from 'path';
import { initialData } from '../../../e2e-shared/initial-data';
import { GeoBlockPlugin } from '../src/plugin';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const PORT = 3061;

describe('@huloglobal/vendure-plugin-geo-block', () => {
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        plugins: [
            GeoBlockPlugin.init({
                publicBaseUrl: `http://localhost:${PORT}`,
            }),
        ],
    });
    const { server } = createTestEnvironment(config);

    beforeAll(async () => {
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
    }, 60_000);

    afterAll(async () => {
        await server.destroy();
    });

    it('serves /geo-block/site-config with a JSON shape', async () => {
        const res = await fetch(`http://localhost:${PORT}/geo-block/site-config`);
        expect(res.status).toBe(200);
        const body = await res.json();
        // No channel token → the defaults: geo-block off, mode block. (An
        // unlicensed install still enforces saved rules; the free tier only
        // forces mode=block and ignores subdivisions — same gate as /check.)
        expect(body).toHaveProperty('geoBlock');
        expect(body.geoBlock.enabled).toBe(false);
        expect(body.geoBlock.mode).toBe('block');
        expect(body.geoBlock.allowedSubdivisions).toEqual({});
    });

    it('admin endpoints reject anonymous calls', async () => {
        const res = await fetch(`http://localhost:${PORT}/geo-block/admin/channels`);
        expect([401, 403]).toContain(res.status);
    });

    it('gates the preset catalogue to the free tier when unlicensed', async () => {
        // This test instance boots without a licence key, so the /presets
        // endpoint must return ONLY the 5 free-tier presets — this verifies
        // the licence gate, the most important commercial contract.
        const res = await fetch(`http://localhost:${PORT}/geo-block/presets`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.presets)).toBe(true);
        const keys = body.presets.map((p: any) => p.key).sort();
        expect(keys).toEqual(['EU', 'NORTH_AMERICA', 'OCEANIA', 'UK_ONLY', 'WORLDWIDE'].sort());
        // Each preset carries its countries so the admin UI can resolve the allow-list live.
        const eu = body.presets.find((p: any) => p.key === 'EU');
        expect(eu.countries).toHaveLength(27);
        expect(body.presets.find((p: any) => p.key === 'WORLDWIDE').countries).toBeNull();
        // Premium presets must NOT leak to unlicensed callers.
        expect(keys).not.toContain('GCC');
        expect(keys).not.toContain('SCHENGEN');
        expect(keys).not.toContain('NATO');
    });

    it('/check returns allow when geo-block is disabled', async () => {
        // No channel configured = no rules to apply.
        const res = await fetch(`http://localhost:${PORT}/geo-block/check`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.allowed).toBe(true);
    });

    it('soft-block + full-block + mode field round-trip on site-config', async () => {
        const res = await fetch(`http://localhost:${PORT}/geo-block/site-config`);
        expect(res.status).toBe(200);
        const body = await res.json();
        // The new mode field is part of the contract now.
        expect(body.geoBlock.mode).toBe('block');
    });
});
