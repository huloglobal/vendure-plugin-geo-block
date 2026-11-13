/**
 * Region presets for the storefront geo-block.
 *
 * Each preset is a hand-curated ISO-3166-1 alpha-2 country list. Admins
 * tick presets in the UI; the resolver unions them, adds any extra
 * countries, removes anything in the denylist, and emits a flat allow
 * list the storefront enforces.
 *
 * `WORLDWIDE` is the special "no country filter" preset — still subject
 * to the denylist, so an admin can ship "everywhere except a few".
 */

const EU_27 = [
    'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
    'IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
] as const;

const EEA_EXTRA = ['IS','LI','NO'] as const;
const EFTA = ['CH','IS','LI','NO'] as const;
const SCHENGEN_NON_EU = ['CH','IS','LI','NO'] as const;

const BRITISH_ISLES = ['GB','IE','IM','JE','GG','FO'] as const;
const UK_CROWN_DEPENDENCIES = ['GB','IM','JE','GG'] as const;

const NON_EU_EUROPE = [
    'GB','CH','NO','IS','LI',
    'AL','AD','BA','BY','FO','GI','IM','JE','GG',
    'MC','ME','MD','MK','RS','SM','UA','VA','XK','RU',
] as const;
const EUROPE = Array.from(new Set([...EU_27, ...NON_EU_EUROPE]));

const NORTH_AMERICA = ['US','CA','MX'] as const;
const CENTRAL_AMERICA = ['BZ','CR','SV','GT','HN','NI','PA'] as const;
const CARIBBEAN = ['AG','BS','BB','CU','DM','DO','GD','HT','JM','KN','LC','VC','TT'] as const;
const SOUTH_AMERICA = ['AR','BO','BR','CL','CO','EC','GY','PY','PE','SR','UY','VE'] as const;
const LATAM = Array.from(new Set([
    ...CENTRAL_AMERICA, ...SOUTH_AMERICA, ...CARIBBEAN, 'MX',
]));

const OCEANIA = ['AU','NZ','FJ','PG','SB','VU','WS','TO'] as const;
const ANZ = ['AU','NZ'] as const;

const GCC = ['BH','KW','OM','QA','SA','AE'] as const;
const MENA = [
    'DZ','BH','EG','IQ','JO','KW','LB','LY','MA','OM','PS','QA','SA',
    'SY','TN','AE','YE',
] as const;

const NORDIC = ['DK','FI','IS','NO','SE'] as const;
const BALTIC = ['EE','LV','LT'] as const;
const BENELUX = ['BE','NL','LU'] as const;
const DACH = ['DE','AT','CH'] as const;
const IBERIA = ['ES','PT'] as const;
const BALKANS = ['AL','BA','BG','HR','GR','XK','ME','MK','RO','RS','SI'] as const;

const ASEAN = ['BN','KH','ID','LA','MY','MM','PH','SG','TH','VN'] as const;
const APAC = [
    'AU','BN','CN','HK','IN','ID','JP','KR','KH','LA','MY','MM','NZ',
    'PH','SG','TH','TW','VN',
] as const;
const EAST_ASIA = ['CN','HK','JP','KR','MO','MN','TW'] as const;
const SOUTH_ASIA = ['BD','BT','IN','MV','NP','LK','PK'] as const;

const AFRICA = [
    'DZ','AO','BJ','BW','BF','BI','CM','CV','CF','TD','KM','CD','CG',
    'CI','DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','KE',
    'LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG',
    'RW','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG',
    'ZM','ZW',
] as const;

const G7 = ['CA','FR','DE','IT','JP','GB','US'] as const;
const G20 = [
    'AR','AU','BR','CA','CN','FR','DE','IN','ID','IT','JP','KR','MX',
    'RU','SA','ZA','TR','GB','US',
] as const;
const BRICS = ['BR','RU','IN','CN','ZA'] as const;
const OECD = [
    'AU','AT','BE','CA','CL','CO','CR','CZ','DK','EE','FI','FR','DE',
    'GR','HU','IS','IE','IL','IT','JP','KR','LV','LT','LU','MX','NL',
    'NZ','NO','PL','PT','SK','SI','ES','SE','CH','TR','GB','US',
] as const;

const ENGLISH_SPEAKING = [
    'AU','BS','BB','BZ','CA','DM','FJ','GD','GY','IE','JM','KE','LR',
    'MW','MT','NZ','NG','PG','SC','SG','SL','SB','ZA','LK','TZ','TT',
    'UG','GB','US','ZM','ZW',
] as const;

const COMMONWEALTH = [
    'AG','AU','BS','BD','BB','BZ','BW','BN','CM','CA','CY','DM','SZ',
    'FJ','GM','GH','GD','GY','IN','JM','KE','KI','LS','MW','MY','MV',
    'MT','MU','MZ','NA','NR','NZ','NG','PK','PG','RW','KN','LC','VC',
    'WS','SC','SL','SG','SB','ZA','LK','TZ','TO','TT','TV','UG','GB',
    'VU','ZM',
] as const;

const FIVE_EYES = ['AU','CA','NZ','GB','US'] as const;

const NATO = [
    'AL','BE','BG','CA','HR','CZ','DK','EE','FI','FR','DE','GR','HU',
    'IS','IT','LV','LT','LU','MK','ME','NL','NO','PL','PT','RO','SK',
    'SI','ES','SE','TR','GB','US',
] as const;

export type GeoRegionKey =
    | 'EUROPE' | 'EU' | 'EEA' | 'EFTA' | 'SCHENGEN' | 'NORDIC' | 'BALTIC'
    | 'BENELUX' | 'DACH' | 'IBERIA' | 'BALKANS'
    | 'BRITISH_ISLES' | 'UK_CROWN_DEPENDENCIES' | 'UK_ONLY'
    | 'NORTH_AMERICA' | 'CENTRAL_AMERICA' | 'CARIBBEAN' | 'SOUTH_AMERICA' | 'LATAM'
    | 'OCEANIA' | 'ANZ'
    | 'GCC' | 'MENA'
    | 'ASEAN' | 'APAC' | 'EAST_ASIA' | 'SOUTH_ASIA'
    | 'AFRICA'
    | 'G7' | 'G20' | 'BRICS' | 'OECD' | 'NATO' | 'FIVE_EYES'
    | 'ENGLISH_SPEAKING' | 'COMMONWEALTH'
    | 'WORLDWIDE';

const REGION_TO_COUNTRIES: Record<GeoRegionKey, readonly string[] | null> = {
    EUROPE,
    EU: EU_27,
    EEA: Array.from(new Set([...EU_27, ...EEA_EXTRA])),
    EFTA,
    SCHENGEN: Array.from(new Set([...EU_27, ...SCHENGEN_NON_EU])),
    NORDIC, BALTIC, BENELUX, DACH, IBERIA, BALKANS,
    BRITISH_ISLES,
    UK_CROWN_DEPENDENCIES,
    UK_ONLY: ['GB'],
    NORTH_AMERICA,
    CENTRAL_AMERICA,
    CARIBBEAN,
    SOUTH_AMERICA,
    LATAM,
    OCEANIA,
    ANZ,
    GCC,
    MENA,
    ASEAN,
    APAC,
    EAST_ASIA,
    SOUTH_ASIA,
    AFRICA,
    G7, G20, BRICS, OECD, NATO, FIVE_EYES,
    ENGLISH_SPEAKING,
    COMMONWEALTH,
    WORLDWIDE: null,
};

/** Countries of one preset (`null` for WORLDWIDE, `[]` for an unknown key). */
export function presetCountries(key: string): string[] | null {
    const k = String(key || '').trim().toUpperCase() as GeoRegionKey;
    if (!(k in REGION_TO_COUNTRIES)) return [];
    const list = REGION_TO_COUNTRIES[k];
    return list ? Array.from(list) : null;
}

/**
 * Human-readable metadata for each preset, for the admin UI.
 * `kind` groups presets in the picker UI ("Trade blocs", "Geography", etc).
 */
export interface RegionPresetMeta {
    key: GeoRegionKey;
    label: string;
    kind: 'geography' | 'trade' | 'political' | 'language' | 'all';
    description: string;
    countryCount: number | null;
}

/**
 * Subset of presets available in the FREE / unlicensed tier.
 * Customers can still choose any of these without paying; the full
 * 37-preset catalogue requires a licence. Picked so the free tier
 * is genuinely useful (worldwide, UK, EU, NA, OCE) but the paid
 * tier is clearly more capable (BRICS, GCC, ASEAN, OFAC etc.).
 */
export const FREE_TIER_PRESET_KEYS: ReadonlyArray<GeoRegionKey> = [
    'WORLDWIDE',
    'UK_ONLY',
    'EU',
    'NORTH_AMERICA',
    'OCEANIA',
];

export const REGION_PRESETS: RegionPresetMeta[] = [
    { key: 'WORLDWIDE', label: 'Worldwide', kind: 'all', description: 'Allow every country (denylist still applies).', countryCount: null },

    { key: 'UK_ONLY', label: 'United Kingdom only', kind: 'geography', description: 'GB only — pair with UK-region filter for England-and-Wales setups.', countryCount: 1 },
    { key: 'BRITISH_ISLES', label: 'British Isles', kind: 'geography', description: 'GB + IE + the Crown Dependencies + Faroe Islands.', countryCount: 6 },
    { key: 'UK_CROWN_DEPENDENCIES', label: 'UK + Crown Dependencies', kind: 'geography', description: 'GB plus Isle of Man, Jersey and Guernsey.', countryCount: 4 },
    { key: 'EUROPE', label: 'Geographic Europe', kind: 'geography', description: 'All European countries (EU + non-EU + micro-states + Russia).', countryCount: EUROPE.length },
    { key: 'EU', label: 'European Union (27)', kind: 'trade', description: 'All 27 EU member states.', countryCount: 27 },
    { key: 'EEA', label: 'EEA', kind: 'trade', description: 'EU 27 + Iceland, Liechtenstein, Norway.', countryCount: 30 },
    { key: 'EFTA', label: 'EFTA', kind: 'trade', description: 'Switzerland, Iceland, Liechtenstein, Norway.', countryCount: 4 },
    { key: 'SCHENGEN', label: 'Schengen Area', kind: 'political', description: 'EU 27 (excl. opt-outs) + non-EU Schengen members.', countryCount: 31 },
    { key: 'NORDIC', label: 'Nordic countries', kind: 'geography', description: 'Denmark, Finland, Iceland, Norway, Sweden.', countryCount: 5 },
    { key: 'BALTIC', label: 'Baltic states', kind: 'geography', description: 'Estonia, Latvia, Lithuania.', countryCount: 3 },
    { key: 'BENELUX', label: 'Benelux', kind: 'geography', description: 'Belgium, Netherlands, Luxembourg.', countryCount: 3 },
    { key: 'DACH', label: 'DACH', kind: 'language', description: 'German-speaking: Germany, Austria, Switzerland.', countryCount: 3 },
    { key: 'IBERIA', label: 'Iberian Peninsula', kind: 'geography', description: 'Spain and Portugal.', countryCount: 2 },
    { key: 'BALKANS', label: 'Balkans', kind: 'geography', description: 'South-east Europe — Albania to Slovenia.', countryCount: BALKANS.length },

    { key: 'NORTH_AMERICA', label: 'North America', kind: 'geography', description: 'US, Canada, Mexico.', countryCount: 3 },
    { key: 'CENTRAL_AMERICA', label: 'Central America', kind: 'geography', description: 'Belize to Panama.', countryCount: CENTRAL_AMERICA.length },
    { key: 'CARIBBEAN', label: 'Caribbean', kind: 'geography', description: 'Caribbean island nations.', countryCount: CARIBBEAN.length },
    { key: 'SOUTH_AMERICA', label: 'South America', kind: 'geography', description: 'All 12 South American countries.', countryCount: 12 },
    { key: 'LATAM', label: 'Latin America', kind: 'geography', description: 'Central + South America + Caribbean + Mexico.', countryCount: LATAM.length },

    { key: 'OCEANIA', label: 'Oceania', kind: 'geography', description: 'Australia, NZ, and major Pacific nations.', countryCount: OCEANIA.length },
    { key: 'ANZ', label: 'Australia + New Zealand', kind: 'geography', description: 'AU and NZ only.', countryCount: 2 },

    { key: 'GCC', label: 'GCC', kind: 'trade', description: 'Gulf Cooperation Council: BH, KW, OM, QA, SA, AE.', countryCount: 6 },
    { key: 'MENA', label: 'MENA', kind: 'geography', description: 'Middle East and North Africa.', countryCount: MENA.length },

    { key: 'ASEAN', label: 'ASEAN', kind: 'trade', description: 'South-east Asia: 10 ASEAN member states.', countryCount: 10 },
    { key: 'APAC', label: 'APAC', kind: 'geography', description: 'Broad Asia-Pacific region.', countryCount: APAC.length },
    { key: 'EAST_ASIA', label: 'East Asia', kind: 'geography', description: 'China, Hong Kong, Japan, Korea, Taiwan, Macau, Mongolia.', countryCount: EAST_ASIA.length },
    { key: 'SOUTH_ASIA', label: 'South Asia', kind: 'geography', description: 'Indian subcontinent.', countryCount: SOUTH_ASIA.length },

    { key: 'AFRICA', label: 'Africa', kind: 'geography', description: 'All African nations.', countryCount: AFRICA.length },

    { key: 'G7', label: 'G7', kind: 'political', description: 'Group of Seven advanced economies.', countryCount: 7 },
    { key: 'G20', label: 'G20', kind: 'political', description: 'Group of Twenty.', countryCount: 19 },
    { key: 'BRICS', label: 'BRICS', kind: 'political', description: 'Brazil, Russia, India, China, South Africa.', countryCount: 5 },
    { key: 'OECD', label: 'OECD', kind: 'political', description: 'Organisation for Economic Co-operation and Development.', countryCount: OECD.length },
    { key: 'NATO', label: 'NATO', kind: 'political', description: 'NATO member states.', countryCount: NATO.length },
    { key: 'FIVE_EYES', label: 'Five Eyes', kind: 'political', description: 'AU, CA, NZ, GB, US.', countryCount: 5 },

    { key: 'ENGLISH_SPEAKING', label: 'English-speaking countries', kind: 'language', description: 'Countries where English is an official or dominant language.', countryCount: ENGLISH_SPEAKING.length },
    { key: 'COMMONWEALTH', label: 'Commonwealth of Nations', kind: 'language', description: '56 Commonwealth member states.', countryCount: COMMONWEALTH.length },
];

/**
 * Resolve an admin's geo-block selections into a final country
 * allow-list (or `null` meaning "allow any country").
 *
 *   final = (∪ region.expand for r in regions) ∪ extraAllowed − blocked
 *
 * Returns `null` if WORLDWIDE is among the selected regions — the
 * caller then skips the country check and only applies the denylist.
 */
export function resolveAllowedCountries(input: {
    regions: string[];
    extraAllowed: string[];
    blocked: string[];
}): { allowed: string[] | null; blocked: string[] } {
    const norm = (s: string) => s.trim().toUpperCase();
    const regions = (input.regions || []).map(norm) as GeoRegionKey[];
    const extra = (input.extraAllowed || []).map(norm);
    const blocked = (input.blocked || []).map(norm);

    if (regions.includes('WORLDWIDE')) {
        return { allowed: null, blocked };
    }

    const allowed = new Set<string>();
    for (const r of regions) {
        const countries = REGION_TO_COUNTRIES[r];
        if (countries) for (const c of countries) allowed.add(c);
    }
    for (const c of extra) allowed.add(c);
    for (const c of blocked) allowed.delete(c);
    return { allowed: Array.from(allowed).sort(), blocked };
}

/**
 * Decide whether a given (country, region) tuple is allowed by the
 * resolved rules. Shared by the controller and the admin "what-if"
 * preview, so the storefront and the simulator never drift apart.
 *
 * `allowedSubdivisions` maps an ISO country code to the list of
 * ISO-3166-2 subdivisions that are allowed within it. An empty array
 * for a country means "all subdivisions allowed" — the country itself
 * is allowed but no sub-region filter applies.
 *
 * The legacy `allowedGbRegions` is honoured as a fallback for GB.
 */
export function isAllowed(
    country: string | null,
    region: string | null,
    rules: {
        enabled: boolean;
        allowedCountries: string[] | null;
        blockedCountries: string[];
        allowedGbRegions: string[];
        allowedSubdivisions?: Record<string, string[]>;
    },
): { allowed: boolean; reason: 'disabled' | 'denylist' | 'country-not-allowed' | 'uk-region-not-allowed' | 'subdivision-not-allowed' | 'ok' } {
    if (!rules.enabled) return { allowed: true, reason: 'disabled' };
    const cc = (country || '').toUpperCase();
    const rr = (region || '').toUpperCase();
    if (cc && rules.blockedCountries.includes(cc)) {
        return { allowed: false, reason: 'denylist' };
    }
    if (rules.allowedCountries !== null && cc && !rules.allowedCountries.includes(cc)) {
        return { allowed: false, reason: 'country-not-allowed' };
    }
    // Generic subdivision check first — applies to any country with
    // configured allowed subdivisions.
    const subs = rules.allowedSubdivisions?.[cc];
    if (subs && subs.length > 0) {
        if (rr && !subs.map(s => s.toUpperCase()).includes(rr)) {
            return { allowed: false, reason: 'subdivision-not-allowed' };
        }
    }
    // Legacy GB-only filter — kept for backwards compatibility.
    if (cc === 'GB' && rules.allowedGbRegions.length > 0) {
        if (rr && !rules.allowedGbRegions.includes(rr)) {
            return { allowed: false, reason: 'uk-region-not-allowed' };
        }
    }
    return { allowed: true, reason: 'ok' };
}

/** Parse an IPv4 or IPv6 address into its byte array (4 or 16 bytes).
 *  `::ffff:a.b.c.d` (IPv4-mapped) is returned as the 4-byte IPv4 form so it
 *  matches plain IPv4 entries. Returns null for anything unparseable. */
export function parseIp(raw: string | null | undefined): Uint8Array | null {
    let s = String(raw ?? '').trim().toLowerCase();
    if (!s) return null;
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    const pct = s.indexOf('%'); // zone id (fe80::1%eth0)
    if (pct >= 0) s = s.slice(0, pct);
    const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) s = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
        const parts = s.split('.').map(Number);
        if (parts.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return null;
        return Uint8Array.from(parts);
    }
    if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
    // An embedded IPv4 tail (::1.2.3.4, 64:ff9b::1.2.3.4) becomes two hextets.
    let tail: number[] = [];
    const v4tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4tail) {
        const b = parseIp(v4tail[1]);
        if (!b || b.length !== 4) return null;
        tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
        s = s.slice(0, -v4tail[1].length);
        if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const hex = (part: string): number[] | null => {
        if (!part) return [];
        const out: number[] = [];
        for (const h of part.split(':')) {
            if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
            out.push(parseInt(h, 16));
        }
        return out;
    };
    const head = hex(halves[0]);
    const rest = halves.length === 2 ? hex(halves[1]) : [];
    if (!head || !rest) return null;
    const known = head.length + rest.length + tail.length;
    let words: number[];
    if (halves.length === 2) {
        if (known > 7) return null;
        words = [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
    } else {
        if (known !== 8) return null;
        words = [...head, ...tail];
    }
    const bytes = new Uint8Array(16);
    words.forEach((w, i) => { bytes[i * 2] = w >> 8; bytes[i * 2 + 1] = w & 0xff; });
    // An IPv4-mapped address written in hex (::ffff:c000:20a) is IPv4 too.
    if (bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12);
    return bytes;
}

/** True when the first `bits` bits of `a` and `b` agree (same family). */
function prefixMatch(a: Uint8Array, b: Uint8Array, bits: number): boolean {
    if (a.length !== b.length || bits < 0 || bits > a.length * 8) return false;
    const whole = Math.floor(bits / 8);
    for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;
    const rem = bits % 8;
    if (!rem) return true;
    const mask = (0xff << (8 - rem)) & 0xff;
    return (a[whole] & mask) === (b[whole] & mask);
}

/** IP-in-list check for the allowlists: single addresses and CIDR ranges,
 *  IPv4 and IPv6 alike (compared as bytes, so `2001:db8::1` matches
 *  `2001:0db8:0:0::/64`, and `::ffff:203.0.113.5` matches `203.0.113.0/24`). */
export function ipMatchesAny(ipRaw: string | null | undefined, list: string[]): boolean {
    if (!ipRaw || !list?.length) return false;
    const ip = parseIp(ipRaw);
    if (!ip) return false;
    for (const entry of list) {
        if (typeof entry !== 'string') continue;
        const [baseRaw, bitsRaw] = entry.trim().split('/');
        const base = parseIp(baseRaw);
        if (!base || base.length !== ip.length) continue;
        if (bitsRaw === undefined) {
            if (prefixMatch(ip, base, ip.length * 8)) return true;
            continue;
        }
        if (!/^\d{1,3}$/.test(bitsRaw.trim())) continue;
        // A mapped-IPv4 base written in IPv6 form carries IPv6 prefix bits (/120 → /24).
        let bits = parseInt(bitsRaw, 10);
        if (base.length === 4 && baseRaw.includes(':')) bits -= 96;
        if (prefixMatch(ip, base, bits)) return true;
    }
    return false;
}

/** An entry the IP allowlists accept: an IPv4/IPv6 address, or a CIDR of /8
 *  or narrower (so a typo'd `/0` cannot open everything). */
export function isIpOrCidr(entry: string): boolean {
    const [baseRaw, bitsRaw, extra] = String(entry || '').trim().split('/');
    if (extra !== undefined) return false;
    const base = parseIp(baseRaw);
    if (!base) return false;
    if (bitsRaw === undefined) return true;
    if (!/^\d{1,3}$/.test(bitsRaw)) return false;
    const n = Number(bitsRaw);
    const max = baseRaw.includes(':') ? 128 : 32;
    return n >= 8 && n <= max;
}

/** True for a preset an unlicensed install may pick. */
export function isFreeTierPreset(key: string): boolean {
    return FREE_TIER_PRESET_KEYS.includes(String(key).toUpperCase() as GeoRegionKey);
}
