# clawd-debug test cases: copy next to your harness and import it.
#
#   from clawd_case import clawd_case
#   clawd_case("empty list", lambda: calc_total([]), 0)
#
# Runs one case, compares its result with what is expected (==), and prints
# one line the debugger reads. With CLAWD_CASE set (a rerun of one case)
# only that case runs, and an error is not caught, so the debugger stops on it.
import json
import os


def clawd_case(name, run, expected):
    only = os.environ.get("CLAWD_CASE", "")
    if only and only != name:
        return
    out = {"name": name, "expected": expected}
    if only:
        out["actual"] = run()
    else:
        try:
            out["actual"] = run()
        except Exception as error:  # noqa: BLE001 - a case reports any error
            out["error"] = f"{type(error).__name__}: {error}"
    out["ok"] = "error" not in out and out["actual"] == expected
    print("@@clawd-case " + json.dumps(out, ensure_ascii=False, default=repr), flush=True)
