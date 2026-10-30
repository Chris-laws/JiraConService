"""Guard: führt alle Checks aus. Aufruf: npm run guard  (oder python -m dev.guard [check ...])"""

from __future__ import annotations

import json
import sys
import time

from dev.checks import CHECKS
from dev.checks.base import ROOT

sys.path.insert(0, str(ROOT / "src"))

BASELINE = ROOT / "dev" / "guard_baseline.json"


def main(selected: list[str]) -> int:
    baseline = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    failed = []
    for check in CHECKS:
        if selected and check.name not in selected:
            continue
        start = time.perf_counter()
        try:
            result = check.run()
        except Exception as exc:  # noqa: BLE001 - ein kaputter Check darf den Guard nicht stumm machen
            result_ok, details, warnings = False, [f"Check abgestürzt: {exc!r}"], 0
        else:
            result_ok, details, warnings = result.ok, result.details, result.warnings
        allowed = baseline.get(check.name, 0)
        if warnings > allowed:
            result_ok = False
            details.append(f"Warnungen {warnings} > Baseline {allowed} (Ratsche)")
        mark = "PASS" if result_ok else "FAIL"
        elapsed = time.perf_counter() - start
        print(f"[{mark}] {check.name:<12} {check.purpose} · Schwelle: {check.threshold} ({elapsed:.1f} s)")
        for line in details:
            print(f"        {line}")
        if not result_ok:
            failed.append(check.name)
    print()
    print("Guard grün." if not failed else f"Guard rot: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
