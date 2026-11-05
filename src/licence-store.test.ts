import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeoBlockController } from './geo-block.controller';
import { GeoBlockPlugin } from './plugin';

/**
 * On PostgreSQL the licence SDK rewrites `ON DUPLICATE KEY UPDATE` as
 * `ON CONFLICT (...) DO UPDATE`, using the conflict columns that
 * `LicenceStore.save` passes as the query function's third argument. A
 * wrapper that dropped that argument made every save throw there, so
 * activating a key in the admin applied it, answered 500 and never stored it.
 */

/** A raw connection that reports Postgres and keeps `hulo_licence_store` in a map. */
function postgres() {
    const rows = new Map<string, string>();
    const upserts: string[] = [];
    const rawConnection = {
        options: { type: 'postgres' },
        async query(sql: string, params: any[] = []) {
            if (sql.startsWith('INSERT INTO hulo_licence_store')) {
                upserts.push(sql);
                rows.set(params[0], params[1]);
            }
            return [];
        },
    };
    return { connection: { rawConnection } as any, rows, upserts };
}

/** Just enough of an Express response to see what a handler answered. */
function fakeRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) { res.statusCode = code; return res; },
        json(body: unknown) { res.body = body; return res; },
    };
    return res;
}

const superAdmin: any = { activeUserId: 1, userHasPermissions: () => true };

afterEach(() => vi.restoreAllMocks());

describe('licence key store on PostgreSQL', () => {
    it('activating a key in the admin stores it with an ON CONFLICT upsert', async () => {
        vi.spyOn(GeoBlockPlugin, 'activateRuntimeLicence').mockReturnValue({ valid: true, message: 'Licensed' } as any);
        const db = postgres();
        const res = fakeRes();
        await new GeoBlockController(db.connection, {} as any, {} as any).licenceActivate(superAdmin, res, { key: 'a.licence.key' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ licensed: true, message: 'Licensed' });
        expect(db.upserts).toEqual([expect.stringContaining('ON CONFLICT (pluginId) DO UPDATE SET')]);
        expect(db.rows.get('vendure-plugin-geo-block')).toBe('a.licence.key');
    });
});
