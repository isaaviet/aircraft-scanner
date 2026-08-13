#!/usr/bin/env python3
"""
Rebuilds aircraft.sqlite + the sharded JSON export from two open sources.

Sources (both free, no key, no auth):

  1. tar1090-db (maintained by wiedehopf, data sourced from Mictronics'
     readsb project + FAA). hex -> registration, ICAO type code, type name.
     https://github.com/wiedehopf/tar1090-db
     Updated roughly whenever the maintainer runs it — check `version` file
     in the repo for the last build date before relying on freshness.

  2. OpenFlights airlines.dat. ICAO carrier code -> name, IATA, callsign.
     https://github.com/jpatokal/openflights
     Static-ish; airlines don't renumber ICAO codes often, but new carriers
     and defunct ones won't be reflected if this hasn't been updated in a
     while. Check the repo's last commit date.

Coverage honesty, worth re-reading before you trust this data in a product:

  - Registration + type: essentially complete for any hex with a public
    registration. This is the part that's genuinely "all of them."
  - Owner/operator on the airframe record: sparse (~5% for the aircraft
    types checked during construction of this db). Civil registries mostly
    don't publish operating airline, only legal owner/lessor. Don't build
    a carrier badge off this field alone.
  - Carrier identity for a SPECIFIC FLIGHT comes from the callsign, not
    the hex — see lookup.js docstring. This pipeline gives you both halves
    (airframe by hex, airline by ICAO code) but you still join them via a
    live callsign, because that join doesn't exist in static data.
  - Military, private, and many general-aviation aircraft will resolve to
    type/registration but have no owner_operator and obviously no airline.

Usage:
    pip install requests --break-system-packages
    python3 build_db.py --out ./db_out
"""
import argparse
import csv
import gzip
import json
import os
import shutil
import sqlite3
import sys
import urllib.request

TAR1090_CSV_URL = "https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz"
OPENFLIGHTS_AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"


def fetch(url, dest):
    print(f"  fetching {url}")
    urllib.request.urlretrieve(url, dest)
    print(f"    -> {os.path.getsize(dest)/1024:.0f} KB")


def build(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "_tmp")
    os.makedirs(tmp, exist_ok=True)

    print("Downloading sources...")
    csv_gz = os.path.join(tmp, "aircraft.csv.gz")
    airlines_raw = os.path.join(tmp, "airlines.dat")
    fetch(TAR1090_CSV_URL, csv_gz)
    fetch(OPENFLIGHTS_AIRLINES_URL, airlines_raw)

    aircraft_csv = os.path.join(tmp, "aircraft.csv")
    with gzip.open(csv_gz, "rb") as f_in, open(aircraft_csv, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)

    db_path = os.path.join(out_dir, "aircraft.sqlite")
    if os.path.exists(db_path):
        os.remove(db_path)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE airframe (
          hex TEXT PRIMARY KEY, registration TEXT, type_code TEXT,
          type_name TEXT, flags TEXT, year TEXT, owner_operator TEXT
        );
        CREATE INDEX idx_airframe_type ON airframe(type_code);
        CREATE INDEX idx_airframe_reg  ON airframe(registration);
        CREATE TABLE airline (
          icao TEXT PRIMARY KEY, iata TEXT, name TEXT,
          callsign TEXT, country TEXT, active TEXT
        );
        CREATE INDEX idx_airline_iata ON airline(iata);
        CREATE TABLE source_meta (
          table_name TEXT PRIMARY KEY, source_url TEXT,
          row_count INTEGER, fetched_utc TEXT
        );
    """)

    print("Parsing airframe table...")
    n = 0
    rows = []
    with open(aircraft_csv, encoding="utf-8", errors="replace") as f:
        for row in csv.reader(f, delimiter=";"):
            row = row + [""] * (8 - len(row))
            hexid, reg, typ, flags, typename, year, ownop, _ = row[:8]
            if not hexid:
                continue
            rows.append((hexid.strip().lower(), reg or None, typ or None,
                         typename or None, flags or None, year or None, ownop or None))
            n += 1
    cur.executemany(
        "INSERT OR REPLACE INTO airframe VALUES (?,?,?,?,?,?,?)", rows
    )
    print(f"  {n:,} airframe rows")

    print("Parsing airline table...")
    m = 0
    rows = []
    with open(airlines_raw, encoding="utf-8", errors="replace") as f:
        for row in csv.reader(f):
            if len(row) < 8:
                continue
            _, name, alias, iata, icao, callsign, country, active = row[:8]
            icao = icao.strip()
            if not icao or icao == "\\N" or len(icao) != 3:
                continue
            clean = lambda s: None if s in ("", "\\N") else s
            rows.append((icao.upper(), clean(iata), clean(name),
                         clean(callsign), clean(country), clean(active)))
            m += 1
    cur.executemany(
        "INSERT OR REPLACE INTO airline VALUES (?,?,?,?,?,?)", rows
    )
    print(f"  {m:,} airline rows")

    cur.executemany(
        "INSERT INTO source_meta VALUES (?,?,?,datetime('now'))",
        [("airframe", TAR1090_CSV_URL, n), ("airline", OPENFLIGHTS_AIRLINES_URL, m)],
    )
    con.commit()

    print("Exporting browser JSON (airlines.json + sharded gzipped airframes)...")
    cur.execute("SELECT icao, iata, name, callsign, country FROM airline")
    airlines = {r[0]: {"iata": r[1], "name": r[2], "callsign": r[3], "country": r[4]}
                for r in cur.fetchall()}
    with open(os.path.join(out_dir, "airlines.json"), "w") as f:
        json.dump(airlines, f, separators=(",", ":"))

    shard_dir = os.path.join(out_dir, "shards")
    shutil.rmtree(shard_dir, ignore_errors=True)
    os.makedirs(shard_dir)

    shards = {}
    cur.execute("SELECT hex, registration, type_code, type_name, owner_operator FROM airframe")
    for hexid, reg, typ, typename, ownop in cur.fetchall():
        # US block (a00000-afffff) is one whole ICAO top-level prefix, so it
        # needs a second hex digit of sharding to stay proportionate to the rest.
        key = hexid[:2] if hexid[0] == "a" else hexid[0]
        shards.setdefault(key, {})[hexid] = [reg, typ, typename, ownop]

    manifest = {}
    total = 0
    for shard, data in sorted(shards.items()):
        path = os.path.join(shard_dir, f"{shard}.json.gz")
        blob = json.dumps(data, separators=(",", ":")).encode()
        with gzip.open(path, "wb", compresslevel=9) as f:
            f.write(blob)
        sz = os.path.getsize(path)
        manifest[shard] = {"rows": len(data), "bytes": sz}
        total += sz
    with open(os.path.join(shard_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=0)

    shutil.rmtree(tmp)
    print(f"\nDone. {len(shards)} shards, {total/1024/1024:.1f} MB gzipped.")
    print(f"SQLite: {db_path} ({os.path.getsize(db_path)/1024/1024:.1f} MB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./db_out")
    args = ap.parse_args()
    build(args.out)
