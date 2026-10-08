# Regenerates src/util/WindowsZoneData.ts from the two CLDR files beside this script. To update: download both
# from https://github.com/unicode-org/cldr at a newer commit (common/supplemental/windowsZones.xml and
# common/bcp47/timezone.xml), set CLDR_COMMIT, and run `python scripts/cldr/generateWindowsZoneData.py`.
import json
import os
import xml.etree.ElementTree as ET

CLDR_COMMIT = "11f1f63d9390d1644c66a6b0704571de3cca4cbf"
HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(HERE, "..", "..", "src", "util", "WindowsZoneData.ts")

wz = ET.parse(os.path.join(HERE, "windowsZones.xml")).getroot()
windows_to_iana = {}
iana_to_windows = {}
for m in wz.iter("mapZone"):
    other = m.get("other")
    territory = m.get("territory")
    ids = m.get("type").split()
    if territory == "001":
        windows_to_iana[other] = ids[0]
    for iana in ids:
        iana_to_windows.setdefault(iana, other)

tz = ET.parse(os.path.join(HERE, "bcp47_timezone.xml")).getroot()

# CLDR's own canonical ids are often older names (`Asia/Calcutta`); bcp47's `iana` attribute is the current IANA name
# (`Asia/Kolkata`), which is what a Windows id should resolve to.
modern = {}
for t in tz.iter("type"):
    names = (t.get("alias") or "").split()
    current = t.get("iana") or (names[0] if names else None)
    for n in names:
        modern[n] = current
windows_to_iana = {w: modern.get(i, i) for w, i in windows_to_iana.items()}

added = 0
for t in tz.iter("type"):
    names = (t.get("alias") or "").split()
    if t.get("iana"):
        names.append(t.get("iana"))
    known = next((iana_to_windows[n] for n in names if n in iana_to_windows), None)
    if not known:
        continue
    for n in names:
        if n not in iana_to_windows:
            iana_to_windows[n] = known
            added += 1

def ts_record(d):
    lines = [f"    {json.dumps(k)}: {json.dumps(v)}," for k, v in sorted(d.items(), key=lambda kv: kv[0].lower())]
    return "\n".join(lines)

out = f"""///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// GENERATED from Unicode CLDR (commit {CLDR_COMMIT}): common/supplemental/windowsZones.xml, plus the IANA aliases
// in common/bcp47/timezone.xml (CLDR's canonical ids are often older names, e.g. `Asia/Calcutta` for
// `Asia/Kolkata`). Regenerate rather than hand-edit.

/** Windows time zone name -> its CLDR territory "001" (representative) IANA zone. */
export const WINDOWS_ZONE_TO_IANA: Readonly<Record<string, string>> = {{
{ts_record(windows_to_iana)}
}};

/** IANA zone (and every CLDR alias of it) -> its Windows time zone name. */
export const IANA_TO_WINDOWS_ZONE: Readonly<Record<string, string>> = {{
{ts_record(iana_to_windows)}
}};

/** Legacy IANA zone name -> its current name (`Asia/Katmandu` -> `Asia/Kathmandu`), for every name that differs. */
export const CURRENT_IANA_ZONE: Readonly<Record<string, string>> = {{
{ts_record({k: v for k, v in modern.items() if v and k != v})}
}};
"""
with open(OUTPUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(out)
print(len(windows_to_iana), "windows zones;", len(iana_to_windows), "iana ids;", added, "from aliases")
