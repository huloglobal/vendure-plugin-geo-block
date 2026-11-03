import { Permission, RequestContext } from '@vendure/core';

/**
 * Per-channel permission checks for the admin routes. `ctx.userHasPermissions`
 * only looks at the channel the request is made in (the `vendure-token`
 * header), but the geo-block admin routes act on the channel named in the
 * body / query — so an administrator of channel B must not be able to read or
 * rewrite channel A's rules (IP allowlist included) just by naming its token.
 */
function entryFor(ctx: RequestContext, ch: { id?: string | number | null; token?: string | null }) {
    const list: Array<{ id: string | number; token: string; permissions: Permission[] }> =
        (ctx?.session?.user?.channelPermissions as any) || [];
    return list.find(c =>
        (ch.token != null && ch.token !== '' && c.token === ch.token) ||
        (ch.id != null && ch.id !== '' && String(c.id) === String(ch.id)),
    );
}

function satisfies(perms: Permission[] | undefined, needed: Permission[]): boolean {
    if (!perms) return false;
    return perms.includes(Permission.SuperAdmin) || needed.every(p => perms.includes(p));
}

export function channelPermitted(
    ctx: RequestContext,
    ch: { id?: string | number | null; token?: string | null },
    needed: Permission[],
): boolean {
    return satisfies(entryFor(ctx, ch)?.permissions, needed);
}

/** Ids of every channel where the user holds `needed`. */
export function permittedChannelIds(ctx: RequestContext, needed: Permission[]): number[] {
    const list: Array<{ id: string | number; permissions: Permission[] }> =
        (ctx?.session?.user?.channelPermissions as any) || [];
    return list.filter(c => satisfies(c.permissions, needed)).map(c => Number(c.id)).filter(n => Number.isFinite(n));
}

export function isSuperAdmin(ctx: RequestContext): boolean {
    const list: Array<{ permissions: Permission[] }> = (ctx?.session?.user?.channelPermissions as any) || [];
    return list.some(c => c.permissions?.includes(Permission.SuperAdmin));
}
