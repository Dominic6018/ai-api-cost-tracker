"""Records one Anthropic response through the Python client and prints its
stored cost. The response is a fixed one, so no provider key is needed.

Usage (Python 3.10+, from the repository root):
    COST_TRACKER_API_KEY=act_... python3 examples/quickstart/quickstart.py [base URL]
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python"))

from cost_tracker import CostTracker, usage_from_response  # noqa: E402

base_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
api_key = os.environ.get("COST_TRACKER_API_KEY")
if not api_key:
    sys.exit("Set COST_TRACKER_API_KEY to a key from `npm run api-key -- create`.")

# What `anthropic.messages.create(model="claude-sonnet-5-5", ...)` returns,
# trimmed to the fields the tracker reads. In your app, pass the real
# response instead: `tracker.track(anthropic.messages.create(...))`.
message = {
    "id": f"msg_quickstart_{time.time_ns()}",
    "type": "message",
    "model": "claude-sonnet-5-5",
    "usage": {"input_tokens": 500, "cache_read_input_tokens": 2500, "output_tokens": 300},
}

with CostTracker(base_url, api_key) as tracker:
    usage = usage_from_response(message)
    usage.customer_id = "cus_quickstart"
    usage.feature = "quickstart"
    result = tracker.record(usage)

# 500 input tokens at $2, 2,500 cache reads at $0.10 and 300 output at $10 per million.
print(f"Stored {usage.model}: ${result.cost_usd}")
