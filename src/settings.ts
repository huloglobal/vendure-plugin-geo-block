/**
 * Admin-editable settings.
 *
 * `GeoBlockPlugin.init({...})` options stay the defaults. A subset that is
 * safe to change from the admin UI can be overridden there; overrides are
 * stored in the plugin's prefs table (`hulo_plugin_prefs`, key
 * `settings.overrides`) and re-read every minute so every server process
 * agrees. "Reset" removes an override and the init option applies again.
 * With no overrides saved (every existing install) behaviour is unchanged.
 *
 * Security-relevant options — trusted proxy headers, the signing secret,
 * the IP salt, the MaxMind file path — are NOT editable here: a path or a
 * trusted header typed into a web form would be a privilege escalation.
 * The UI shows them read-only.
 */
import type { PluginPrefs } from '@huloglobal/vendure-licence-sdk';
import type { BotAllowlist } from './bot-detect';
import { getOptions } from './plugin';

export const SETTINGS_PREF_KEY = 'settings.overrides';

export interface AdminOverrides {
    /** 'strict' | 'permissive' | 'off' | 'custom' (with `botCustom`). */
    botMode?: 'strict' | 'permissive' | 'off' | 'custom';
    botCustom?: string[];
    /** Reverse-DNS check for visitors claiming to be Googlebot / Bingbot. */
    verifyBots?: boolean;
    supportEmail?: string;
    /** Public endpoint rate limit, requests per minute per IP. */
    rateLimitPerMinute?: number;
    hashAuditIps?: boolean;
    storefrontHelperMaxAgeSec?: number;
}

export interface EffectiveSettings {
    botAllowlist: BotAllowlist;
    botMode: 'strict' | 'permissive' | 'off' | 'custom';
    botCustom: string[];
    verifyBots: boolean;
    supportEmail: string;
    rateLimit: { capacity: number; windowMs: number };
    hashAuditIps: boolean;
    storefrontHelperMaxAgeSec: number;
}

let overrides: AdminOverrides = {};
let loadedAt = 0;
const RELOAD_MS = 60_000;

/** Clean an untrusted patch into overrides. Unknown keys are dropped; `null`
 *  clears one override. Throws with a readable message on a bad value. */
export function sanitiseOverrides(current: AdminOverrides, patch: any): AdminOverrides {
    const out: AdminOverrides = { ...current };
    if (!patch || typeof patch !== 'object') return out;
    const clear = (k: keyof AdminOverrides) => { delete out[k]; };
    if ('botMode' in patch) {
        if (patch.botMode === null) clear('botMode');
        else if (['strict', 'permissive', 'off', 'custom'].includes(patch.botMode)) out.botMode = patch.botMode;
        else throw new Error('botMode must be strict, permissive, off or custom');
    }
    if ('botCustom' in patch) {
        if (patch.botCustom === null) clear('botCustom');
        else if (Array.isArray(patch.botCustom)) {
            out.botCustom = Array.from(new Set(patch.botCustom.filter((x: any) => typeof x === 'string')
                .map((x: string) => x.trim()).filter((x: string) => x.length >= 3 && x.length <= 80))).slice(0, 50) as string[];
        } else throw new Error('botCustom must be a list of User-Agent fragments');
    }
    if ('verifyBots' in patch) {
        if (patch.verifyBots === null) clear('verifyBots');
        else out.verifyBots = !!patch.verifyBots;
    }
    if ('supportEmail' in patch) {
        if (patch.supportEmail === null) clear('supportEmail');
        else {
            const e = String(patch.supportEmail || '').trim().slice(0, 254);
            if (e && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) throw new Error('Enter a valid support e-mail address');
            out.supportEmail = e;
        }
    }
    if ('rateLimitPerMinute' in patch) {
        if (patch.rateLimitPerMinute === null) clear('rateLimitPerMinute');
        else {
            const n = Number(patch.rateLimitPerMinute);
            if (!Number.isInteger(n) || n < 10 || n > 10_000) throw new Error('The rate limit must be 10–10000 requests per minute');
            out.rateLimitPerMinute = n;
        }
    }
    if ('hashAuditIps' in patch) {
        if (patch.hashAuditIps === null) clear('hashAuditIps');
        else out.hashAuditIps = !!patch.hashAuditIps;
    }
    if ('storefrontHelperMaxAgeSec' in patch) {
        if (patch.storefrontHelperMaxAgeSec === null) clear('storefrontHelperMaxAgeSec');
        else {
            const n = Number(patch.storefrontHelperMaxAgeSec);
            if (!Number.isInteger(n) || n < 60 || n > 86_400) throw new Error('The helper cache age must be 60–86400 seconds');
            out.storefrontHelperMaxAgeSec = n;
        }
    }
    return out;
}

function botModeOf(a: BotAllowlist | undefined): { mode: EffectiveSettings['botMode']; custom: string[] } {
    if (a === false) return { mode: 'off', custom: [] };
    if (a === 'permissive') return { mode: 'permissive', custom: [] };
    if (Array.isArray(a)) return { mode: 'custom', custom: a.map(x => (x instanceof RegExp ? `/${x.source}/` : String(x))) };
    return { mode: 'strict', custom: [] };
}

/** Init options with the admin overrides applied. */
export function effectiveSettings(): EffectiveSettings {
    const o = getOptions();
    const init = botModeOf(o.botAllowlist);
    const botMode = overrides.botMode ?? init.mode;
    let botAllowlist: BotAllowlist;
    let botCustom = init.custom;
    if (overrides.botMode === undefined) botAllowlist = o.botAllowlist ?? 'strict';
    else if (botMode === 'off') botAllowlist = false;
    else if (botMode === 'custom') {
        botCustom = overrides.botCustom ?? [];
        botAllowlist = botCustom;
    } else botAllowlist = botMode;
    const perMinute = overrides.rateLimitPerMinute;
    return {
        botAllowlist,
        botMode,
        botCustom,
        verifyBots: overrides.verifyBots ?? !!o.verifyBots,
        supportEmail: overrides.supportEmail ?? (o.supportEmail || ''),
        rateLimit: perMinute ? { capacity: perMinute, windowMs: 60_000 } : (o.rateLimit || { capacity: 120, windowMs: 60_000 }),
        hashAuditIps: overrides.hashAuditIps ?? (o.hashAuditIps !== false),
        storefrontHelperMaxAgeSec: overrides.storefrontHelperMaxAgeSec ?? Math.max(60, o.storefrontHelperMaxAgeSec ?? 300),
    };
}

export function getOverrides(): AdminOverrides { return { ...overrides }; }

/** Test hook / after a save in this process. */
export function setOverrides(next: AdminOverrides): void {
    overrides = { ...next };
    loadedAt = Date.now();
}

/** Re-read the overrides when stale. Never throws; keeps the last copy. */
export async function refreshOverrides(prefs: PluginPrefs, force = false): Promise<void> {
    if (!force && Date.now() - loadedAt < RELOAD_MS) return;
    loadedAt = Date.now();
    try {
        const raw = await prefs.get(SETTINGS_PREF_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        overrides = sanitiseOverrides({}, parsed);
    } catch { /* keep what we have */ }
}

export async function saveOverrides(prefs: PluginPrefs, next: AdminOverrides): Promise<void> {
    await prefs.set(SETTINGS_PREF_KEY, Object.keys(next).length ? JSON.stringify(next) : null);
    setOverrides(next);
}
