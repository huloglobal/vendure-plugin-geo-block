/**
 * The decision pipeline, shared by the public `/check` endpoint, the admin
 * simulator and the server-side purchase enforcement, so the three never
 * disagree. A pure function of (rules, visitor, time, purpose). Order:
 *
 *   1. IP allowlist                       → allow
 *   2. SEO / social crawler (page views)  → allow
 *   3. business-hours schedule            → block / soft outside hours
 *   4. maintenance window (init option,
 *      then the channel's own window)     → block; its own IPs bypass
 *   5. country / subdivision rules
 *
 * Step 2 applies to page views only: a User-Agent is not identity, so
 * purchases never get the crawler exemption.
 */
import { BusinessHoursSchedule, checkSchedule } from './schedule';
import { ipMatchesAny, isAllowed } from './geo-regions';

export type Purpose = 'view' | 'purchase';

export interface ChannelMaintenance {
    /** ISO-8601 timestamps. */
    startsAt: string;
    endsAt: string;
    /** IPs / CIDRs that bypass this window (office, on-call). */
    allowedIps?: string[];
    /** Shown instead of the default "temporarily unavailable" text. */
    message?: string;
}

export interface RulesForDecision {
    enabled: boolean;
    mode: 'block' | 'soft';
    allowedCountries: string[] | null;
    blockedCountries: string[];
    allowedGbRegions: string[];
    allowedSubdivisions: Record<string, string[]>;
    blockMessage: string;
    blockRedirectUrl: string | null;
    blockLogoUrl: string | null;
    ipAllowlist: string[];
    schedule: BusinessHoursSchedule | null;
    /** The channel's own maintenance window. */
    maintenance: ChannelMaintenance | null;
}

export interface Visitor {
    ip: string | null;
    country: string | null;
    region: string | null;
    /** The caller already decided the crawler exemption (UA match and, when
     *  `verifyBots` is on, reverse DNS). Ignored for purchases. */
    isCrawler: boolean;
}

export interface Verdict {
    allowed: boolean;
    reason: string;
    mode: 'block' | 'soft';
    message?: string | null;
    redirectUrl?: string | null;
    logoUrl?: string | null;
    /** Seconds until a temporary refusal (maintenance) is expected to end. */
    retryAfterSec?: number;
}

export function inWindow(w: { startsAt: string; endsAt: string } | null | undefined, now: Date = new Date()): boolean {
    if (!w) return false;
    const start = Date.parse(w.startsAt);
    const end = Date.parse(w.endsAt);
    if (!isFinite(start) || !isFinite(end)) return false;
    const t = now.getTime();
    return t >= start && t <= end;
}

export function defaultMessage(reason: string): string {
    switch (reason) {
        case 'denylist':
        case 'country-not-allowed':
            return 'This service is not available in your country.';
        case 'uk-region-not-allowed':
            return 'This service is only available in selected UK regions.';
        case 'subdivision-not-allowed':
            return 'This service is only available in selected regions of your country.';
        case 'maintenance':
            return 'The site is temporarily unavailable. Please try again later.';
        default:
            return 'Access denied.';
    }
}

/**
 * @param premium licence or evaluation active: soft actions stay soft;
 *                on the free tier every refusal is a full block.
 */
export function decide(
    rules: RulesForDecision,
    visitor: Visitor,
    opts: { premium: boolean; purpose: Purpose; globalMaintenance?: { startsAt: string; endsAt: string; allowedIps?: string[] } | null; now?: Date },
): Verdict {
    const now = opts.now ?? new Date();
    const { ip } = visitor;
    if (ipMatchesAny(ip, rules.ipAllowlist)) {
        return { allowed: true, reason: 'ip-allowlist', mode: rules.mode };
    }
    if (opts.purpose === 'view' && visitor.isCrawler) {
        return { allowed: true, reason: 'bot-allowlist', mode: rules.mode };
    }
    const sv = checkSchedule(rules.schedule, now);
    if (!sv.inHours && sv.action) {
        const mode = opts.premium && sv.action === 'soft' ? 'soft' : 'block';
        return {
            allowed: false, reason: 'schedule', mode,
            message: sv.message,
            redirectUrl: rules.blockRedirectUrl,
            logoUrl: rules.blockLogoUrl,
        };
    }
    const gm = opts.globalMaintenance;
    if (gm && inWindow(gm, now) && !ipMatchesAny(ip, gm.allowedIps || [])) {
        return {
            allowed: false, reason: 'maintenance', mode: rules.mode,
            message: rules.blockMessage || defaultMessage('maintenance'),
            redirectUrl: rules.blockRedirectUrl,
            retryAfterSec: retryAfter(gm.endsAt, now),
        };
    }
    const cm = rules.maintenance;
    if (cm && inWindow(cm, now) && !ipMatchesAny(ip, cm.allowedIps || [])) {
        return {
            allowed: false, reason: 'maintenance', mode: 'block',
            message: cm.message || rules.blockMessage || defaultMessage('maintenance'),
            redirectUrl: rules.blockRedirectUrl,
            logoUrl: rules.blockLogoUrl,
            retryAfterSec: retryAfter(cm.endsAt, now),
        };
    }
    const verdict = isAllowed(visitor.country, visitor.region, rules);
    if (!verdict.allowed) {
        return {
            allowed: false, reason: verdict.reason, mode: rules.mode,
            message: rules.blockMessage || defaultMessage(verdict.reason),
            redirectUrl: rules.blockRedirectUrl,
            logoUrl: rules.blockLogoUrl,
        };
    }
    return { allowed: true, reason: verdict.reason, mode: rules.mode };
}

function retryAfter(endsAt: string, now: Date): number {
    const end = Date.parse(endsAt);
    if (!isFinite(end)) return 3600;
    return Math.min(86_400, Math.max(60, Math.ceil((end - now.getTime()) / 1000)));
}

/** A purchase is refused only for a full block; a soft block is a banner. */
export function refusesPurchase(v: Verdict): boolean {
    return !v.allowed && v.mode === 'block';
}

/** HTTP status for a refused page view: 503 for temporary refusals
 *  (schedule, maintenance), 403 for everything else. */
export function httpStatusFor(reason: string): 403 | 503 {
    return reason === 'schedule' || reason === 'maintenance' ? 503 : 403;
}

/** Validate an admin-supplied maintenance window. Returns the cleaned value
 *  (`null` clears it) or throws a readable error. */
export function sanitiseMaintenance(raw: any, isIpOrCidr: (x: string) => boolean): ChannelMaintenance | null {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('maintenance must be an object');
    const startsAt = String(raw.startsAt || '').trim();
    const endsAt = String(raw.endsAt || '').trim();
    if (!startsAt && !endsAt) return null;
    const s = Date.parse(startsAt);
    const e = Date.parse(endsAt);
    if (!isFinite(s) || !isFinite(e)) throw new Error('Maintenance start and end must be valid dates');
    if (e <= s) throw new Error('Maintenance must end after it starts');
    if (e - s > 31 * 86_400_000) throw new Error('A maintenance window can last at most 31 days');
    const ips = Array.isArray(raw.allowedIps) ? raw.allowedIps : [];
    const allowedIps = Array.from(new Set(ips.filter((x: any) => typeof x === 'string').map((x: string) => x.trim().toLowerCase()).filter(Boolean))).slice(0, 100) as string[];
    const bad = allowedIps.filter(x => !isIpOrCidr(x));
    if (bad.length) throw new Error(`Not an IP address or CIDR range: ${bad.slice(0, 3).join(', ')}`);
    const message = String(raw.message || '').trim().slice(0, 1000);
    return { startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), allowedIps, ...(message ? { message } : {}) };
}

/** Validate an admin-supplied business-hours schedule (`null` clears it). */
export function sanitiseSchedule(raw: any): BusinessHoursSchedule | null {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('schedule must be an object');
    const hhmm = (v: any, name: string): string | undefined => {
        const t = String(v ?? '').trim();
        if (!t) return undefined;
        const m = t.match(/^(\d{1,2}):(\d{2})$/);
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${name} must be HH:MM (24-hour)`);
        return `${m[1].padStart(2, '0')}:${m[2]}`;
    };
    const from = hhmm(raw.from, 'Opening time');
    const to = hhmm(raw.to, 'Closing time');
    if (!!from !== !!to) throw new Error('Set both the opening and the closing time, or neither');
    const days = Array.isArray(raw.days)
        ? Array.from(new Set(raw.days.map((d: any) => Number(d)).filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 7))).sort() as any[]
        : [];
    if (!from && !days.length) return null;
    const timezone = String(raw.timezone || '').trim().slice(0, 64);
    if (timezone) {
        try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); } catch { throw new Error(`Unknown time zone: ${timezone}`); }
    }
    const outsideAction = ['block', 'soft', 'allow'].includes(raw.outsideAction) ? raw.outsideAction : 'block';
    const outsideMessage = String(raw.outsideMessage || '').trim().slice(0, 1000);
    return {
        ...(timezone ? { timezone } : {}),
        ...(days.length ? { days } : {}),
        ...(from ? { from, to } : {}),
        outsideAction,
        ...(outsideMessage ? { outsideMessage } : {}),
    };
}
