/**
 * Server-side purchase enforcement (opt-in per channel).
 *
 * The storefront helper and `/check` only advise the storefront; a visitor
 * can skip them and call the Shop API directly. With the channel's
 * "Refuse purchases from blocked visitors" switch on, the server itself
 * refuses, for a visitor the rules FULL-block:
 *   - adding to the order and changing line quantities (OrderInterceptor);
 *   - moving the order to ArrangingPayment, i.e. checkout (OrderProcess).
 * A soft block (premium) stays a banner: purchases go ahead.
 *
 * Off by default — every existing channel keeps exactly its old behaviour.
 * It FAILS OPEN: no request, an Admin-API call, an unknown country, a rules
 * lookup error or any exception all mean "allow". Payments that are already
 * under way (webhooks, settlement) are never touched.
 */
import { Injector, Order, OrderInterceptor, OrderProcess, OrderState, RequestContext, Logger } from '@vendure/core';
import type { Request } from 'express';
import { GeoBlockChannelRules, rulesFromRow } from './channel-rules';
import { decide, refusesPurchase, Verdict } from './decision';
import { GeoBlockPlugin, getOptions } from './plugin';
import { getRealIp } from './proxy-headers';
import { locate } from './locate';

const loggerCtx = 'GeoBlockEnforcement';

let rulesService: GeoBlockChannelRules | null = null;
/** Called with every refusal (the controller logs it to the audit table). */
let onRefusal: ((ctx: RequestContext, v: Verdict, info: { ip: string | null; country: string | null; region: string | null; ua: string; channelId: number }) => void) | null = null;

export function setRefusalListener(fn: typeof onRefusal): void { onRefusal = fn; }

/** Test seam: the decision without Vendure plumbing. */
export async function purchaseRefusal(ctx: RequestContext, rules: GeoBlockChannelRules | null = rulesService): Promise<string | undefined> {
    try {
        if (!rules || ctx?.apiType !== 'shop') return undefined;
        const req = ctx.req as Request | undefined;
        if (!req) return undefined;
        const token = ctx.channel?.token;
        if (!token) return undefined;
        const row = await rules.load(token);
        if (!row || !Number(row.enforcePurchases || 0)) return undefined;
        const premium = GeoBlockPlugin.hasPremiumAccess();
        const opts = getOptions();
        const ip = getRealIp(req, opts.trustedIpHeaders);
        const where = locate(req, ip);
        const v = decide(rulesFromRow(token, row, premium), { ip, country: where.country, region: where.region, isCrawler: false }, {
            premium, purpose: 'purchase', globalMaintenance: opts.maintenanceWindow ?? null,
        });
        if (!refusesPurchase(v)) return undefined;
        try {
            onRefusal?.(ctx, v, { ip, country: where.country, region: where.region, ua: String(req.headers?.['user-agent'] || ''), channelId: Number(row.id) || 0 });
        } catch { /* logging never blocks */ }
        return (v.message || 'Sorry, we cannot take orders from your location.').slice(0, 400);
    } catch (e: any) {
        Logger.warn(`geo-block purchase check failed open: ${e?.message}`, loggerCtx);
        return undefined;
    }
}

export class GeoBlockOrderInterceptor implements OrderInterceptor {
    init(injector: Injector) {
        try { rulesService = injector.get(GeoBlockChannelRules); } catch { rulesService = null; }
    }

    willAddItemToOrder(ctx: RequestContext): Promise<string | void> {
        return purchaseRefusal(ctx);
    }

    async willAdjustOrderLine(ctx: RequestContext, _order: Order, input: { orderLine: { quantity: number }; quantity: number }): Promise<string | void> {
        // Lowering a quantity is always allowed (the visitor can empty the basket).
        if (input && input.quantity <= (input.orderLine?.quantity ?? 0)) return undefined;
        return purchaseRefusal(ctx);
    }
}

export const geoBlockOrderProcess: OrderProcess<OrderState> = {
    init(injector: Injector) {
        try { rulesService = rulesService ?? injector.get(GeoBlockChannelRules); } catch { /* fail open */ }
    },
    async onTransitionStart(fromState, toState, data) {
        if (toState !== 'ArrangingPayment' || fromState === 'ArrangingPayment') return;
        const refusal = await purchaseRefusal(data.ctx);
        return refusal ? refusal : undefined;
    },
};
