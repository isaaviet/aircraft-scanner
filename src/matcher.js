/**
 * Resolves a live ADS-B record to a visual asset, using liveries/manifest.json
 * as the only source of truth for what's available. This is the sole seam
 * between "database" and "visuals" — nothing else in the codebase should
 * know an airline code or type code maps to a specific file.
 *
 * Match tiers, in order:
 *   1. exact    — typeCode AND airlineIcao both match a manifest entry.
 *                 (the real livery: right plane, right paint)
 *   2. type     — typeCode matches, airlineIcao doesn't (or airline unknown).
 *                 (right airframe shape, wrong/no paint — still informative
 *                 for a generic-by-type render if you build one later)
 *   3. airline  — airlineIcao matches some entry, typeCode doesn't.
 *                 (you have a livery for this airline, just not this plane)
 *   4. none     — nothing on file. Caller should show a generic silhouette
 *                 + whatever identity text the database resolved (see
 *                 db/lookup.js), not fail silently.
 *
 * Deliberately NOT resolved here: airline *name* enrichment, hex->type
 * fallback when the live feed is missing fields, route lookups. Those
 * live in db/lookup.js and the app layer. This module's only job is
 * "given a type+airline, which file (if any)".
 */

export class LiveryMatcher {
  constructor(manifestUrlOrObject) {
    this._ready = typeof manifestUrlOrObject === 'string'
      ? fetch(manifestUrlOrObject).then(r => r.json()).then(m => this._index(m))
      : Promise.resolve(this._index(manifestUrlOrObject));
  }

  _index(manifest) {
    this.byExact = new Map();   // "TYPE:AIRLINE" -> entry
    this.byType = new Map();    // "TYPE" -> entry (first match wins)
    this.byAirline = new Map(); // "AIRLINE" -> entry (first match wins)
    for (const entry of manifest.liveries || []) {
      const t = (entry.match.typeCode || '').toUpperCase();
      const a = (entry.match.airlineIcao || '').toUpperCase();
      if (t && a) this.byExact.set(`${t}:${a}`, entry);
      if (t && !this.byType.has(t)) this.byType.set(t, entry);
      if (a && !this.byAirline.has(a)) this.byAirline.set(a, entry);
    }
    return manifest;
  }

  async ready() { await this._ready; return this; }

  /**
   * ac: { t: typeCode, flight: callsign }  — same shape as the ADS-B feed.
   * Returns { tier, entry } where entry is null for tier "none".
   */
  match(ac) {
    const type = (ac.t || '').toUpperCase();
    const airline = (ac.flight || '').trim().slice(0, 3).toUpperCase();

    const exact = this.byExact.get(`${type}:${airline}`);
    if (exact) return { tier: 'exact', entry: exact };

    const byType = type && this.byType.get(type);
    if (byType) return { tier: 'type', entry: byType };

    const byAirline = airline && this.byAirline.get(airline);
    if (byAirline) return { tier: 'airline', entry: byAirline };

    return { tier: 'none', entry: null };
  }
}

/* ---------------------------------------------------------------
   Node-side variant for build-time validation (see tests/validate.mjs).
   Same class, works without fetch — pass the parsed manifest object.
   --------------------------------------------------------------- */
