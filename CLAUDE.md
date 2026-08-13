# Aircraft Scanner — architecture

Two halves that don't know about each other except through one file.

```
aircraft-scanner/
├── db/                       Claude Code owns this. Data, not pixels.
│   ├── build_db.py           Rebuilds everything below from upstream sources.
│   ├── aircraft.sqlite       614k rows: hex → registration, ICAO type code, type name.
│   ├── airlines.json         5.9k rows: ICAO carrier code → name/IATA/callsign.
│   ├── shards/*.json.gz      Same airframe data, browser-sized (8.4MB gzipped, 31 files).
│   └── lookup.js             Client-side reader for the shards, used at runtime.
│
├── liveries/                 The user owns this. Pixels, not data.
│   ├── manifest.schema.json  Contract: what fields a manifest entry needs.
│   ├── manifest.json         One entry per visual: which file depicts which plane.
│   └── *.webp / *.png / ...  The actual artwork. Any format, any naming.
│
├── src/
│   └── matcher.js            THE SEAM. Reads manifest.json, resolves an ADS-B
│                              record to a file path. Nothing else in the app
│                              should contain an airline code or type code.
│
└── tests/
    └── validate.mjs          Run before every commit. Catches broken manifest
                                entries before they become a blank <img> at runtime.
```

## The one rule

**`db/` never mentions specific liveries. `liveries/` never mentions ADS-B, hex codes, or matching logic.** They meet only inside `manifest.json`, which the human maintains, and `matcher.js`, which reads it.

This means: adding a new livery is "drop a file in `liveries/`, add one object to `manifest.json`, run the validator." It is never "go edit some JS that has airline codes hardcoded in it." If you (Claude Code) ever find yourself adding an `if (airline === 'UAE')` anywhere outside `matcher.js`, stop — that logic belongs in the manifest instead.

## Data flow, end to end

```
live ADS-B record  { hex, flight: "UAE7   ", t: "A388", ... }
        │
        ├─► db/lookup.js.lookupHex(hex)         → registration, full type name
        │      (used when the feed's own t/r fields are blank)
        │
        ├─► db/lookup.js.lookupAirlineFromCallsign(flight)
        │      → airline display name, e.g. "Emirates"
        │      (used for identity text — this is NOT how the visual is picked)
        │
        └─► src/matcher.js.match({ t, flight })
               → { tier: "exact", entry: { file: "Emirates_A380_.webp", accent: "#A6192E" } }
               (THIS is how the visual is picked — manifest lookup, nothing else)
```

Two separate resolutions happen against two separate concerns. Identity text (airline name, aircraft type name) comes from the database and is close to 100% coverage. Which *picture* to show comes from the manifest and is only as complete as the folder of art — most flights will resolve to real identity text but tier `"none"` on the visual, and the app needs a generic fallback (silhouette, outline, whatever) for that case. Don't conflate "we know what this is" with "we have art for it."

## Why the airframe DB and the airline table are separate tables, not one join

Checked against real data before building this: of 261 actual A380 tail numbers in the airframe table, only 14 had an owner/operator field populated. Civil aircraft registries record *legal owner* (often a leasing company), not *operating airline* — so there is no reliable static join from hex straight to carrier. The airline comes from the **callsign** of the specific flight (first 3 letters = operator ICAO code), not from any property of the airframe itself. That's why `lookupHex` and `lookupAirline`/`lookupAirlineFromCallsign` are two different functions in `lookup.js` — keep them that way. A future contributor merging them into one "enrich" call will quietly reintroduce a join that doesn't actually hold.

## Match tiers (`src/matcher.js`)

| Tier | Condition | Meaning |
|---|---|---|
| `exact` | typeCode + airlineIcao both match one manifest entry | real livery on file |
| `type` | typeCode matches, airline doesn't | right airframe shape, wrong/no paint |
| `airline` | airlineIcao matches, type doesn't | this airline is covered, just not this plane |
| `none` | nothing matches | fall back to generic + database identity text |

`type` and `airline` tiers only fire if the manifest actually has an entry claiming that type or that airline elsewhere — with only A380s on file today, every non-A380 sighting is `none`. That's expected; it stops being true as the liveries folder grows.

**Decide deliberately what the app does with tier `"airline"`.** It means "right airline, wrong airframe" — e.g. a BA 777 sighting will match BA's A380 art, because that's the only BA livery on file. Verified this actually happens: a real BA 777 record resolves to `tier: "airline", file: "BA_A380_.webp"`. Shown without qualification, that's a wrong picture with a right paint job. Two honest options, pick one in the app layer (not in the matcher — its job is just to report the tier truthfully):
  - Only render art for `tier === "exact"`; treat `"airline"` the same as `"none"` (generic silhouette + real identity text).
  - Render the airline art for `"airline"` tier but visibly label it, e.g. "livery reference — not this aircraft."
Don't render `"airline"`-tier art silently as if it were `"exact"`.

## What Claude Code should do with this

1. **Extend `db/build_db.py`** if new fields or sources are needed — e.g. adding a photo-credit source, or a second registry for better owner/operator coverage. Keep the "coverage honesty" comments in that file current if you change what's sparse vs. complete.
2. **Extend `src/matcher.js`** only for new *tiers* or *matching strategies* (e.g. registration-exact matching for a specific tail photo) — never for specific airline/type conditionals. Those go in the manifest.
3. **Run `tests/validate.mjs`** after any change touching `liveries/manifest.json` or `db/airlines.json`. Wire it into a pre-commit hook or CI step rather than relying on remembering to run it.
4. **Never hand-edit `db/aircraft.sqlite`, `airlines.json`, or `shards/`.** They're build outputs. Edit `build_db.py` and rerun it.
5. When the human adds a new livery, the only files that should change are: the new asset in `liveries/`, one new object in `liveries/manifest.json`. If a diff touches anything else to "make it work," something's wrong with the seam.

## Refreshing the database

```bash
pip install requests --break-system-packages
python3 db/build_db.py --out db
```

Pulls fresh from `wiedehopf/tar1090-db` (airframes) and `jpatokal/openflights` (airlines), rebuilds `aircraft.sqlite` and re-shards the JSON export. Safe to run anytime; it's a full rebuild, not an incremental patch. Takes under a minute — network fetch of ~8.5MB is the bulk of the time.
