/**
 * Postgres corpus test — every raw SQL statement in `src/**` is translated
 * by the licence-sdk dialect adapter and executed against a scratch
 * PostgreSQL database. Skipped unless `HULO_PG_URL` is set, e.g.
 *
 *   HULO_PG_URL=postgres://hulo_pg:hulo_pg_local@localhost:5432/hulo_geo_pg npx vitest run
 *
 * The scratch database gets stand-ins for the TypeORM-owned tables the
 * plugin touches (`channel` with the quoted camelCase custom-field columns,
 * `geo_block_event`) plus the SDK's `hulo_licence_store`. Each statement
 * runs inside a rolled-back transaction, so the seed rows survive and the
 * run is idempotent. SELECTs must return rows with their camelCase aliases
 * intact (the adapter restores them from PG's lower-cased identifiers).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createDbAdapter, translateSql } from '@huloglobal/vendure-licence-sdk';

const PG_URL = process.env.HULO_PG_URL;

const DDL = [
    `DROP TABLE IF EXISTS channel`,
    `DROP TABLE IF EXISTS geo_block_event`,
    `DROP TABLE IF EXISTS hulo_licence_store`,
    `CREATE TABLE channel (
        id SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        code VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL,
        "customFieldsShowcompanynumber" BOOLEAN DEFAULT FALSE,
        "customFieldsBusinesscompanynumber" VARCHAR(255),
        "customFieldsGeoblockenabled" BOOLEAN DEFAULT FALSE,
        "customFieldsGeoblockmode" VARCHAR(255) DEFAULT 'block',
        "customFieldsGeoblockallowedregions" TEXT,
        "customFieldsGeoblockallowedcountries" TEXT,
        "customFieldsGeoblockblockedcountries" TEXT,
        "customFieldsGeoblockallowedgbregions" TEXT,
        "customFieldsGeoblockallowedsubdivisions" TEXT,
        "customFieldsGeoblockipallowlist" TEXT,
        "customFieldsGeoblockblockmessage" TEXT,
        "customFieldsGeoblockblockredirecturl" VARCHAR(255),
        "customFieldsGeoblockblocklogourl" VARCHAR(255),
        "customFieldsGeoblockschedule" TEXT
    )`,
    `CREATE TABLE geo_block_event (
        id SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "channelId" INTEGER NOT NULL DEFAULT 1,
        country VARCHAR(8),
        region VARCHAR(8),
        ip VARCHAR(64),
        "userAgent" TEXT,
        url VARCHAR(2048),
        decision VARCHAR(32) NOT NULL,
        reason VARCHAR(64) NOT NULL
    )`,
    `CREATE INDEX "IDX_gbe_channel_created" ON geo_block_event ("channelId", "createdAt")`,
    `CREATE TABLE hulo_licence_store (
        pluginid VARCHAR(128) PRIMARY KEY,
        licencekey TEXT NOT NULL,
        updatedat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
];

const SEED = [
    `INSERT INTO channel (code, token, "customFieldsGeoblockenabled", "customFieldsGeoblockmode", "customFieldsGeoblockallowedregions",
        "customFieldsGeoblockallowedcountries", "customFieldsGeoblockblockedcountries", "customFieldsGeoblockallowedgbregions",
        "customFieldsGeoblockallowedsubdivisions", "customFieldsGeoblockipallowlist", "customFieldsGeoblockblockmessage")
     VALUES ('__default_channel__', '1', TRUE, 'soft', '["EU"]', '["JP"]', '["DE"]', '[]', '{"US":["CA"]}', '["203.0.113.0/24"]', 'Sorry'),
            ('second', '2', FALSE, 'block', '[]', '[]', '[]', '[]', NULL, '[]', NULL)`,
    `INSERT INTO geo_block_event ("channelId", country, region, ip, "userAgent", url, decision, reason) VALUES
        (1, 'US', 'CA', 'abc', 'UA', 'https://x/', 'block', 'country-not-allowed'),
        (1, 'DE', NULL, 'def', 'UA', 'https://x/', 'soft-block', 'denylist'),
        (2, 'FR', NULL, 'ghi', 'UA', 'https://x/', 'block', 'schedule')`,
    `INSERT INTO hulo_licence_store (pluginid, licencekey) VALUES ('vendure-plugin-geo-block:ipsalt', 'salt')`,
];

/** Stand-in for a `${expr}` interpolation inside an SQL template literal. */
function standIn(expr: string): string {
    const e = expr.trim();
    if (/^(where|w|whereClause)$/.test(e)) return '`createdAt` >= DATE_SUB(NOW(), INTERVAL ? DAY) AND `channelId` = ?';
    if (/set\.join/.test(e)) return '`customFieldsGeoblockenabled` = ?, `customFieldsGeoblockmode` = ?';
    if (/channelId/.test(e)) return ' AND `channelId` = ?';
    if (/companyColumns\(\)/.test(e)) return '`customFieldsShowcompanynumber` AS showCompanyNumber, `customFieldsBusinesscompanynumber` AS companyNumber,';
    if (/scope\.map/.test(e)) return '?';
    throw new Error(`pg-corpus: no stand-in for interpolation \${${e}} — add one to standIn()`);
}

/** Bind a plausible value for each `?`, judged from the SQL just before it. */
function paramsFor(sql: string): any[] {
    const out: any[] = [];
    let inSingle = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'") inSingle = !inSingle;
        if (ch !== '?' || inSingle) continue;
        const before = sql.slice(Math.max(0, i - 48), i);
        if (/INTERVAL\s*$/i.test(before)) out.push(30);
        else if (/(LIMIT|OFFSET)\s*$/i.test(before)) out.push(10);
        else if (/(At`?|NOW\(\))\s*(=|>=|<=|<|>|,)\s*$/.test(before)) out.push(new Date());
        else if (/enabled`?\s*=\s*$/i.test(before)) out.push(true);
        else out.push('1');
    }
    return out;
}

interface Stmt { file: string; sql: string; }

/** String literals (template, single- and double-quoted) in one TS source,
 *  found with a small scanner so escaped quotes and backticks inside other
 *  strings and comments cannot derail it (a regex does). Template literals
 *  keep their `${expr}` interpolations verbatim. */
function scanLiterals(src: string): string[] {
    const out: string[] = [];
    let i = 0;
    const n = src.length;
    const readQuoted = (q: string): string => {
        // src[i] === q
        let j = i + 1;
        let buf = '';
        while (j < n && src[j] !== q) {
            if (src[j] === '\\') { buf += src[j + 1] === q || src[j + 1] === '`' ? src[j + 1] : src[j] + src[j + 1]; j += 2; continue; }
            if (q !== '`' && src[j] === '\n') break;
            buf += src[j]; j++;
        }
        i = j + 1;
        return buf;
    };
    const readTemplate = (): string => {
        let j = i + 1;
        let buf = '';
        while (j < n && src[j] !== '`') {
            if (src[j] === '\\') { buf += src[j + 1] === '`' || src[j + 1] === '$' ? src[j + 1] : src[j] + src[j + 1]; j += 2; continue; }
            if (src[j] === '$' && src[j + 1] === '{') {
                // Copy the interpolation verbatim, skipping strings inside it.
                let depth = 1; let k = j + 2; let expr = '';
                while (k < n && depth > 0) {
                    const c = src[k];
                    if (c === "'" || c === '"') {
                        const q = c; let m = k + 1; let inner = '';
                        while (m < n && src[m] !== q) { if (src[m] === '\\') { inner += src[m + 1] === '`' ? '`' : src[m] + src[m + 1]; m += 2; continue; } inner += src[m]; m++; }
                        expr += q + inner + q; k = m + 1; continue;
                    }
                    if (c === '{') depth++;
                    if (c === '}') { depth--; if (depth === 0) { k++; break; } }
                    expr += c; k++;
                }
                buf += '${' + expr + '}';
                j = k; continue;
            }
            buf += src[j]; j++;
        }
        i = j + 1;
        return buf;
    };
    while (i < n) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
        if (c === "'" || c === '"') { out.push(readQuoted(c)); continue; }
        if (c === '`') { out.push(readTemplate()); continue; }
        i++;
    }
    return out;
}

/** Every string literal in src/**.ts that is a whole SQL statement. */
function extractCorpus(dir: string): Stmt[] {
    const out: Stmt[] = [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
    for (const f of files) {
        for (const lit of scanLiterals(fs.readFileSync(path.join(dir, f), 'utf8'))) {
            const trimmed = lit.trim();
            // A real statement, not a route path or a keyword quoted in a comment.
            if (!/^(SELECT\s+\S|INSERT\s+(IGNORE\s+)?INTO\s|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s|CREATE\s+TABLE\s|ALTER\s+TABLE\s)/i.test(trimmed)) continue;
            const sql = trimmed.replace(/\$\{([^}]*)\}/g, (_all, expr) => standIn(expr));
            out.push({ file: f, sql });
        }
    }
    return out;
}

describe.skipIf(!PG_URL)('Postgres SQL corpus (HULO_PG_URL)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    const client = new Client({ connectionString: PG_URL });
    const raw = {
        options: { type: 'postgres' },
        query: async (sql: string, params?: any[]) => (await client.query(sql, params)).rows,
    };
    const adapter = createDbAdapter(raw);
    const corpus = extractCorpus(path.join(__dirname));

    beforeAll(async () => {
        await client.connect();
        for (const s of DDL) await client.query(s);
        for (const s of SEED) await client.query(s);
    }, 30_000);

    afterAll(async () => { await client.end(); });

    it('finds the statements', () => {
        expect(corpus.length).toBeGreaterThanOrEqual(15);
    });

    it('leaves no MySQL-ism behind after translation', () => {
        for (const { file, sql } of corpus) {
            const t = translateSql(sql, 'postgres');
            expect(t, `${file}: ${sql}`).not.toMatch(/`|\bDATE_SUB\b|\bDATE_ADD\b|INSERT\s+IGNORE|ON\s+DUPLICATE|\bIF\s*\(|GROUP_CONCAT|AUTO_INCREMENT|\bDATETIME\b/i);
            expect(t.replace(/'(?:[^']|'')*'/g, ''), `${file}: unnumbered placeholder in ${sql}`).not.toContain('?');
        }
    });

    it('executes every statement and keeps camelCase aliases on result rows', async () => {
        const failures: string[] = [];
        for (const { file, sql } of corpus) {
            const params = paramsFor(sql);
            const isRead = /^SELECT/i.test(sql);
            await client.query('BEGIN');
            try {
                const res = await adapter.query(sql, params, isRead ? undefined : { needAffected: true });
                if (isRead) {
                    expect(Array.isArray(res), `${file}: ${sql}`).toBe(true);
                    const aliases = Array.from(sql.matchAll(/\bAS\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/g)).map(m => m[1]).filter(a => /[A-Z]/.test(a) && /[a-z]/.test(a));
                    for (const row of res as any[]) {
                        for (const a of aliases) expect(row, `${file}: alias ${a} lost in ${sql}`).toHaveProperty(a);
                    }
                    if (/\bWHERE\b/i.test(sql) === false || /channel WHERE token|FROM channel/i.test(sql)) {
                        expect((res as any[]).length, `${file}: expected seed rows for ${sql}`).toBeGreaterThan(0);
                    }
                }
            } catch (e: any) {
                failures.push(`${file}: ${e?.message}\n    ${sql.replace(/\s+/g, ' ').slice(0, 220)}`);
            } finally {
                await client.query('ROLLBACK');
            }
        }
        expect(failures, failures.join('\n')).toEqual([]);
    }, 60_000);
});
