/**
 * Client-side lookup for the hex -> airframe -> carrier database.
 *
 * Two tables, two different reliability levels — keep that distinction
 * visible in the UI, don't quietly merge them:
 *
 *   airframe (from tar1090-db / Mictronics, ~614k rows)
 *     hex -> registration, ICAO type code, type name.
 *     Coverage is excellent: essentially every allocated Mode S address
 *     with a public registration has a row here.
 *
 *   airline (from OpenFlights, ~5.9k rows)
 *     3-letter ICAO carrier code -> airline name, IATA code, radio callsign.
 *     This is NOT keyed by hex. There is no reliable field in public hex
 *     databases that says "which airline operates this airframe" — leasing
 *     and ownership structures obscure it, and most civil registries don't
 *     publish it. (Sample check: of 261 real A380 hex entries, only 14 had
 *     an owner/operator field populated at all.)
 *     The carrier is instead recovered from the FLIGHT's callsign, not the
 *     airframe's hex: the first 3 letters of a callsign (BAW117, UAE7,
 *     QFA1) are the operating airline's ICAO code. That's a property of
 *     the flight, not the plane, which is why a hex lookup alone can never
 *     give you "who's flying this" for a scheduled airliner — you need the
 *     live callsign too.
 *
 * Usage:
 *   const db = new AircraftDB('/aircraft-db');
 *   const frame = await db.lookupHex('4008f3');       // -> {registration, typeCode, typeName, ownerOperator}
 *   const airline = db.lookupAirline('BAW');           // -> {name, iata, callsign, country} (sync, whole table is preloaded)
 *   const airline2 = db.lookupAirlineFromCallsign('BAW117 ');
 */
export class AircraftDB {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, '');
    this.shardCache = new Map();   // shard key -> Map(hex -> row)
    this.manifest = null;
    this.airlines = null;
    this._airlinesPromise = null;
  }

  /* Airline table is ~500KB and used on every render — load it once, eagerly. */
  async _ensureAirlines() {
    if (this.airlines) return this.airlines;
    if (!this._airlinesPromise) {
      this._airlinesPromise = fetch(`${this.base}/airlines.json`)
        .then(r => r.json())
        .then(data => { this.airlines = data; return data; });
    }
    return this._airlinesPromise;
  }

  async _ensureManifest() {
    if (this.manifest) return this.manifest;
    const r = await fetch(`${this.base}/shards/manifest.json`);
    this.manifest = await r.json();
    return this.manifest;
  }

  /* US registrations (hex 'a00000'-'afffff') get 256 shards instead of 1 —
     see build_db.py for why. Every other prefix is a single top-level shard. */
  _shardKeyFor(hex) {
    return hex[0] === 'a' ? hex.slice(0, 2) : hex[0];
  }

  async _loadShard(shardKey) {
    if (this.shardCache.has(shardKey)) return this.shardCache.get(shardKey);
    const res = await fetch(`${this.base}/shards/${shardKey}.json.gz`);
    if (!res.ok) { this.shardCache.set(shardKey, null); return null; }
    // Browsers decompress gzip transparently when Content-Encoding is set;
    // if you're serving these as static files, configure your host to send
    // that header for .json.gz, or decompress here with DecompressionStream.
    let data;
    try {
      data = await res.json();
    } catch {
      const ds = new DecompressionStream('gzip');
      const stream = res.body.pipeThrough(ds);
      const text = await new Response(stream).text();
      data = JSON.parse(text);
    }
    const map = new Map(Object.entries(data));
    this.shardCache.set(shardKey, map);
    return map;
  }

  /** hex: 6-char Mode S address, any case. Returns null if not in the database. */
  async lookupHex(hex) {
    const h = (hex || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(h)) return null;
    const shard = await this._loadShard(this._shardKeyFor(h));
    if (!shard) return null;
    const row = shard.get(h);
    if (!row) return null;
    const [registration, typeCode, typeName, ownerOperator] = row;
    return { hex: h, registration, typeCode, typeName, ownerOperator };
  }

  /** icaoCode: 3-letter airline ICAO code, e.g. "BAW". Sync once airlines are loaded. */
  lookupAirline(icaoCode) {
    if (!this.airlines) return undefined; // call preload() first
    return this.airlines[(icaoCode || '').toUpperCase()] || null;
  }

  /** Convenience: derive the airline straight from a raw callsign string. */
  lookupAirlineFromCallsign(callsign) {
    const code = (callsign || '').trim().slice(0, 3).toUpperCase();
    return this.lookupAirline(code);
  }

  /** Call once at startup so lookupAirline() can be synchronous thereafter. */
  async preload() {
    await this._ensureAirlines();
    await this._ensureManifest();
  }
}
