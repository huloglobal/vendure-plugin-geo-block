/**
 * `@huloglobal/vendure-plugin-geo-block` — public exports.
 *
 * `GeoBlockPlugin` registers the per-channel custom fields, controllers,
 * GeoBlockEvent audit entity and admin UI. The presets + helpers below
 * are exported so downstream plugins / scripts can compute the resolved
 * country allow-list and run "what-if" checks outside the HTTP path.
 */

export { GeoBlockPlugin, GeoBlockPluginOptions, MaintenanceWindow } from './plugin';
export {
    REGION_PRESETS,
    RegionPresetMeta,
    GeoRegionKey,
    presetCountries,
    resolveAllowedCountries,
    isAllowed,
    ipMatchesAny,
    isIpOrCidr,
    parseIp,
} from './geo-regions';
export { decide, Verdict, Visitor, Purpose, ChannelMaintenance } from './decision';
export { MmdbReader, LocalCountryDb } from './mmdb';
export { GeoBlockChannelFields1763020800000 } from './migration';
export { GeoBlockEvent } from './geo-block-event.entity';
