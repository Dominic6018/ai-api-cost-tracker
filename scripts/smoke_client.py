"""Records usage through the Python client (clients/python) against a running
app with seed prices, and checks the stored cost.

Usage: COST_TRACKER_API_KEY=... python3 scripts/smoke_client.py [base URL]
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "clients" / "python"))

from cost_tracker import CostTracker, CostTrackerError, RecordResult, usage_from_response  # noqa: E402

base_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
api_key = os.environ["COST_TRACKER_API_KEY"]

# An Anthropic Messages response as the REST API returns it, trimmed.
message = {
    "id": f"msg_py_smoke_{time.time_ns()}",
    "type": "message",
    "model": "claude-sonnet-5-5",
    "content": [],
    "usage": {
        "input_tokens": 50,
        "cache_creation_input_tokens": 2000,
        "cache_read_input_tokens": 8000,
        "output_tokens": 400,
    },
}

print("- track() returns the response and reports it in the background")
errors = []
with CostTracker(base_url, api_key, on_error=lambda error, usage: errors.append(error)) as tracker:
    assert tracker.track(message) is message
    tracker.flush()
    assert errors == [], errors

    print("- the stored cost uses cache read and write rates")
    # Claude Sonnet 5.5 seed prices per 1M tokens: $2 input, $0.10 cache
    # reads, $2.50 cache writes, $10 output.
    # 50 * 2 + 8,000 * 0.10 + 2,000 * 2.50 + 400 * 10 = 9,900 -> $0.009900
    replay = tracker.record(usage_from_response(message))
    assert replay == RecordResult("0.009900", True), replay

print("- a rejected key never reaches the caller of track()")
rejected = []
with CostTracker(base_url, "act_" + "x" * 43, retries=0, on_error=lambda error, usage: rejected.append(error)) as bad:
    assert bad.track(message) is message
    bad.flush()
assert len(rejected) == 1 and isinstance(rejected[0], CostTrackerError), rejected
# 401, or 429 if earlier CI steps already used up this address's limit.
assert rejected[0].status in (401, 429), rejected[0].status

print("Python client smoke test passed.")
