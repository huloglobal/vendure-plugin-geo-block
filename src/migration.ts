/**
 * Database migration for 0.15.0: two new Channel custom-field columns,
 *   `customFieldsGeoblockmaintenance`      (text, nullable)       — per-channel maintenance window
 *   `customFieldsGeoblockenforcepurchases` (boolean, default false) — purchase enforcement switch
 *
 * Hosts that run `synchronize: true` need nothing. Otherwise either generate
 * your own migration as usual (`npx vendure migrate`), or add this one to
 * `dbConnectionOptions.migrations`:
 *
 *   import { GeoBlockChannelFields1763020800000 } from '@huloglobal/vendure-plugin-geo-block';
 *   dbConnectionOptions: { migrations: [GeoBlockChannelFields1763020800000, ...] }
 *
 * It is idempotent (each column is only added when missing), so it is safe
 * next to a generated migration, and works on MariaDB/MySQL and Postgres.
 * Existing channels get `false`: purchase enforcement stays off until an
 * administrator switches it on.
 */
import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export const GEO_BLOCK_0_15_COLUMNS = [
    { name: 'customFieldsGeoblockmaintenance', type: 'text', isNullable: true },
    { name: 'customFieldsGeoblockenforcepurchases', type: 'boolean', isNullable: true, default: false },
] as const;

export class GeoBlockChannelFields1763020800000 implements MigrationInterface {
    name = 'GeoBlockChannelFields1763020800000';

    async up(queryRunner: QueryRunner): Promise<void> {
        for (const c of GEO_BLOCK_0_15_COLUMNS) {
            if (await queryRunner.hasColumn('channel', c.name)) continue;
            await queryRunner.addColumn('channel', new TableColumn({ ...c } as any));
        }
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        for (const c of GEO_BLOCK_0_15_COLUMNS) {
            if (await queryRunner.hasColumn('channel', c.name)) await queryRunner.dropColumn('channel', c.name);
        }
    }
}
