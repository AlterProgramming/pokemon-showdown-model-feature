#!/usr/bin/env python3
"""
Fetch gen 9 OU teams from coupcritique.fr and convert to PS packed format.

The site embeds a JSON-escaped team object inside a Next.js push() string.
That object contains a top-level team `name` + `description`, and six
`pkm_inst_N` child objects with explicit English names for species, ability,
item, nature, tera, and moves (the French translations sit in a parallel
`nom` field, which we ignore). Parsing the structured JSON is cleaner than
the Showdown paste text, which conflates nicknames with species and leaves
French strings in display positions.

Usage:
    python3 scripts/fetch_coupcritique_ou_teams.py \\
        --team-ids 8142,8131,8114,8105,8085,8068,8067,8033,7874,7801 \\
        --out config/model-league-ou-teams.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

USER_AGENT = "Mozilla/5.0 (Macintosh) Coupcritique-Team-Fetcher/1.0"
STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"]


@dataclass
class TeamFetch:
    team_id: int
    name: str
    packed: str


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _to_id(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _extract_escaped_object(html: str, start_idx: int) -> str:
    """From an index pointing at '{' in JSON-string-escaped text, return the
    substring spanning the matching closing brace."""
    assert html[start_idx] == "{"
    depth = 0
    i = start_idx
    while i < len(html):
        c = html[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return html[start_idx:i + 1]
        elif c == "\\":
            i += 2
            continue
        i += 1
    raise ValueError("unterminated object")


def _json_unescape(escaped: str) -> str:
    """Decode a JSON-escaped fragment to its literal form by wrapping in
    quotes and letting json.loads handle \\uXXXX / \\" / \\n / \\\\."""
    return json.loads('"' + escaped + '"')


def extract_team(html: str) -> tuple[str, list[dict]]:
    """Locate the team JSON object containing pkm_inst_1..6 and return
    (team_name, [pkm_inst_1 dict, ..., pkm_inst_6 dict])."""
    idx = html.find("pkm_inst_1")
    if idx == -1:
        raise RuntimeError("pkm_inst_1 not found")

    name_match = None
    for m in re.finditer(
        r'\\"name\\":\\"([^"\\]{1,150})\\",\\"description\\"',
        html[:idx],
    ):
        name_match = m
    team_name = _json_unescape(name_match.group(1)) if name_match else "Unknown team"

    mons: list[dict] = []
    for n in range(1, 7):
        marker = f'pkm_inst_{n}\\":'
        pos = html.find(marker, idx - 500)
        if pos == -1:
            raise RuntimeError(f"pkm_inst_{n} missing")
        brace = html.find("{", pos)
        escaped = _extract_escaped_object(html, brace)
        inner = _json_unescape(escaped)
        mons.append(json.loads(inner))
    return team_name, mons


def mon_to_packed(mon: dict) -> str:
    species = mon["pokemon"]["name"]
    nick = (mon.get("nickname") or "").strip()
    ability = (mon.get("ability") or {}).get("name") or ""
    item = (mon.get("item") or {}).get("name") or ""
    nature = (mon.get("nature") or {}).get("name") or ""
    tera = (mon.get("tera") or {}).get("name") or ""
    evs = [str(mon.get(f"{k}_ev") or "") for k in STAT_KEYS]
    ivs_raw = [mon.get(f"{k}_iv") for k in STAT_KEYS]
    # PS packed: empty → 31 for IVs; only emit a slot if explicitly != 31.
    ivs = ["" if v is None or v == 31 else str(v) for v in ivs_raw]
    moves = [
        (mon.get(f"move_{k}") or {}).get("name") or ""
        for k in range(1, 5)
    ]
    move_ids = ",".join(_to_id(m) for m in moves if m)

    level = mon.get("level") or 100
    level_str = "" if int(level) == 100 else str(level)
    shiny = "S" if mon.get("shiny") else ""
    sex = mon.get("sex") or ""
    gender = sex if sex in ("M", "F") else ""
    happiness = mon.get("happiness")
    happiness_str = "" if happiness in (None, 255) else str(happiness)

    extras: list[str] = []
    if tera or happiness_str:
        extras = [happiness_str, "", "", "", "", _to_id(tera) if tera else ""]
        # Drop trailing empties.
        while extras and extras[-1] == "":
            extras.pop()

    # Use species as nickname if nickname is empty or in a non-ASCII script
    # (the French nicknames are display-only and don't affect gameplay; we
    # normalize to species to keep logs readable).
    display_nick = species
    return "|".join([
        display_nick if display_nick != species else "",
        _to_id(species),
        _to_id(item) if item else "",
        _to_id(ability) if ability else "",
        move_ids,
        nature,
        ",".join(evs),
        gender,
        ",".join(ivs),
        shiny,
        level_str,
        ",".join(extras) if extras else "",
    ])


def fetch_team(team_id: int) -> TeamFetch:
    url = f"https://www.coupcritique.fr/entity/teams/{team_id}"
    html = http_get(url)
    team_name, mons = extract_team(html)
    packed = "]".join(mon_to_packed(m) for m in mons)
    return TeamFetch(team_id=team_id, name=team_name, packed=packed)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--team-ids", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--id-prefix", default="cc-ou-")
    args = parser.parse_args()

    ids = [int(x) for x in args.team_ids.split(",") if x.strip()]
    results: list[dict] = []
    failures: list[tuple[int, str]] = []
    for team_id in ids:
        try:
            fetched = fetch_team(team_id)
        except Exception as exc:
            failures.append((team_id, str(exc)))
            print(f"[fail] team {team_id}: {exc}", file=sys.stderr)
            continue
        mon_count = fetched.packed.count("]") + 1 if fetched.packed else 0
        print(
            f"[ok]   team {team_id} {fetched.name!r} ({mon_count} mons)",
            file=sys.stderr,
        )
        results.append({
            "id": f"{args.id_prefix}{team_id}",
            "name": fetched.name,
            "source": f"https://www.coupcritique.fr/entity/teams/{team_id}",
            "packedTeam": fetched.packed,
            "active": True,
            "archived": False,
            "sampleWeight": 1,
        })

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\nwrote {len(results)} teams to {out_path}", file=sys.stderr)
    if failures:
        print(f"{len(failures)} failures:", file=sys.stderr)
        for tid, err in failures:
            print(f"  {tid}: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
