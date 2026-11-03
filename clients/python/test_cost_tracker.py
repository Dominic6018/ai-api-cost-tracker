"""Tests for cost_tracker.py. Run: python -m unittest discover -s clients/python"""

import json
import threading
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace as Obj
from unittest import mock

from cost_tracker import (
    CostTracker,
    CostTrackerError,
    OutcomeResult,
    RecordResult,
    Usage,
    usage_from_response,
)

# Response bodies trimmed to the fields that matter, in each API's shape.
OPENAI_CHAT = {
    "id": "chatcmpl-abc123",
    "object": "chat.completion",
    "model": "gpt-4.1-2025-04-14",
    "choices": [],
    "usage": {
        "prompt_tokens": 1200,
        "completion_tokens": 300,
        "total_tokens": 1500,
        "prompt_tokens_details": {"cached_tokens": 1024},
    },
}
OPENAI_RESPONSE = {
    "id": "resp_abc123",
    "object": "response",
    "model": "gpt-5.4-mini",
    "usage": {
        "input_tokens": 2000,
        "input_tokens_details": {"cached_tokens": 512},
        "output_tokens": 700,
        "output_tokens_details": {"reasoning_tokens": 400},
    },
}
ANTHROPIC = {
    "id": "msg_01abc",
    "type": "message",
    "model": "claude-sonnet-5-5",
    "usage": {
        "input_tokens": 50,
        "cache_creation_input_tokens": 2000,
        "cache_read_input_tokens": 8000,
        "output_tokens": 400,
    },
}
GEMINI_REST = {
    "responseId": "gemini-response-1",
    "modelVersion": "gemini-2.5-pro",
    "usageMetadata": {
        "promptTokenCount": 5000,
        "cachedContentTokenCount": 4000,
        "candidatesTokenCount": 300,
        "toolUsePromptTokenCount": 120,
        "thoughtsTokenCount": 900,
    },
}


class UsageFromResponseTest(unittest.TestCase):
    def test_openai_chat(self):
        self.assertEqual(
            usage_from_response(OPENAI_CHAT),
            Usage("openai", "gpt-4.1-2025-04-14", 1200, 300, cached_input_tokens=1024, request_id="chatcmpl-abc123"),
        )

    def test_openai_responses(self):
        self.assertEqual(
            usage_from_response(OPENAI_RESPONSE),
            Usage("openai", "gpt-5.4-mini", 2000, 700, cached_input_tokens=512, request_id="resp_abc123"),
        )

    def test_anthropic_adds_cache_reads_and_writes_to_input(self):
        self.assertEqual(
            usage_from_response(ANTHROPIC),
            Usage(
                "anthropic",
                "claude-sonnet-5-5",
                10_050,
                400,
                cached_input_tokens=8000,
                cache_write_input_tokens=2000,
                request_id="msg_01abc",
            ),
        )

    def test_gemini_rest_bills_thinking_as_output(self):
        self.assertEqual(
            usage_from_response(GEMINI_REST),
            Usage("google", "gemini-2.5-pro", 5120, 1200, cached_input_tokens=4000, request_id="gemini-response-1"),
        )

    def test_sdk_objects_with_attributes(self):
        # How the OpenAI, Anthropic and google-genai SDKs return responses.
        anthropic = Obj(
            id="msg_01abc",
            type="message",
            model="claude-sonnet-5-5",
            usage=Obj(input_tokens=50, cache_creation_input_tokens=None, cache_read_input_tokens=8000, output_tokens=400),
        )
        self.assertEqual(
            usage_from_response(anthropic),
            Usage("anthropic", "claude-sonnet-5-5", 8050, 400, cached_input_tokens=8000, request_id="msg_01abc"),
        )
        chat = Obj(
            id="chatcmpl-1",
            object="chat.completion",
            model="gpt-4.1",
            usage=Obj(prompt_tokens=10, completion_tokens=5, prompt_tokens_details=None),
        )
        self.assertEqual(usage_from_response(chat), Usage("openai", "gpt-4.1", 10, 5, request_id="chatcmpl-1"))
        gemini = Obj(
            response_id="g-1",
            model_version="gemini-2.5-flash",
            usage_metadata=Obj(
                prompt_token_count=100,
                cached_content_token_count=None,
                candidates_token_count=20,
                thoughts_token_count=30,
                tool_use_prompt_token_count=None,
            ),
        )
        self.assertEqual(usage_from_response(gemini), Usage("google", "gemini-2.5-flash", 100, 50, request_id="g-1"))

    def test_responses_without_usage(self):
        for response in [
            None,
            "hello",
            {"object": "chat.completion.chunk", "choices": []},
            {**OPENAI_CHAT, "usage": None},
            {"foo": 1},
        ]:
            with self.subTest(response=response):
                self.assertIsNone(usage_from_response(response))

    def test_payload_uses_the_api_field_names(self):
        usage = usage_from_response(ANTHROPIC)
        usage.occurred_at = datetime(2026, 11, 2, 10, 0, tzinfo=timezone.utc)
        self.assertEqual(
            usage.to_payload(),
            {
                "provider": "anthropic",
                "model": "claude-sonnet-5-5",
                "inputTokens": 10_050,
                "outputTokens": 400,
                "cachedInputTokens": 8000,
                "cacheWriteInputTokens": 2000,
                "requestId": "msg_01abc",
                "occurredAt": "2026-11-02T10:00:00+00:00",
            },
        )
        usage.occurred_at = datetime(2026, 11, 2, 10, 0)
        with self.assertRaises(ValueError):
            usage.to_payload()


def stored(cost="0.001000", replayed=False, status=201):
    return status, json.dumps({"event": {"costUsd": cost}, "replayed": replayed}).encode()


def failed(status, code):
    return status, json.dumps({"error": {"code": code, "message": f"failed: {code}"}}).encode()


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, body, headers, timeout):
        self.calls.append((url, json.loads(body), headers))
        next_response = self.responses.pop(0)
        if isinstance(next_response, BaseException):
            raise next_response
        return next_response


USAGE = Usage("openai", "gpt-4.1", 1000, 500, request_id="req_1")


def make(*responses):
    transport = FakeTransport(*responses)
    errors = []
    tracker = CostTracker(
        "https://costs.example.com/ignored/path",
        "act_test",
        transport=transport,
        on_error=lambda error, usage: errors.append((error, usage)),
    )
    return tracker, transport, errors


@mock.patch("cost_tracker.time.sleep", lambda seconds: None)
class RecordTest(unittest.TestCase):
    def test_posts_with_the_key_and_returns_the_cost(self):
        tracker, transport, _ = make(stored("0.006000"))
        self.assertEqual(tracker.record(USAGE), RecordResult("0.006000", False))
        url, body, headers = transport.calls[0]
        self.assertEqual(url, "https://costs.example.com/api/usage")
        self.assertEqual(headers["authorization"], "Bearer act_test")
        self.assertEqual(body["requestId"], "req_1")
        self.assertEqual(body["cachedInputTokens"], 0)

    def test_accepts_a_plain_dict(self):
        tracker, transport, _ = make(stored())
        tracker.record({"provider": "openai", "model": "gpt-4.1", "inputTokens": 1, "outputTokens": 1})
        self.assertEqual(transport.calls[0][1]["inputTokens"], 1)

    def test_retries_network_errors_429_and_5xx_with_a_request_id(self):
        tracker, transport, _ = make(
            ConnectionError("refused"),
            failed(429, "rate_limited"),
            stored("0.006000", True, 200),
        )
        self.assertEqual(tracker.record(USAGE), RecordResult("0.006000", True))
        self.assertEqual(len(transport.calls), 3)

    def test_no_retry_without_a_request_id(self):
        tracker, transport, _ = make(failed(503, "unavailable"))
        with self.assertRaises(CostTrackerError) as caught:
            tracker.record(Usage("openai", "gpt-4.1", 1, 1))
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(len(transport.calls), 1)

    def test_no_retry_after_a_rejection(self):
        tracker, transport, _ = make(failed(422, "no_pricing"))
        with self.assertRaises(CostTrackerError) as caught:
            tracker.record(USAGE)
        self.assertEqual((caught.exception.status, caught.exception.code), (422, "no_pricing"))
        self.assertEqual(str(caught.exception), "failed: no_pricing")
        self.assertEqual(len(transport.calls), 1)

    def test_gives_up_after_the_retries(self):
        tracker, transport, _ = make(OSError("down"), OSError("down"), OSError("down"))
        with self.assertRaises(CostTrackerError) as caught:
            tracker.record(USAGE)
        self.assertIsNone(caught.exception.status)
        self.assertEqual(len(transport.calls), 3)


class TrackTest(unittest.TestCase):
    def test_returns_the_response_and_reports_in_the_background(self):
        tracker, transport, errors = make(stored())
        self.assertIs(tracker.track(ANTHROPIC, metadata={"feature": "chat"}), ANTHROPIC)
        tracker.flush()
        body = transport.calls[0][1]
        self.assertEqual(body["requestId"], "msg_01abc")
        self.assertEqual(body["metadata"], {"feature": "chat"})
        self.assertEqual(errors, [])

    def test_runs_off_the_calling_thread(self):
        seen = []
        tracker = CostTracker(
            "https://costs.example.com",
            "act_test",
            transport=lambda *args: seen.append(threading.current_thread()) or stored(),
        )
        tracker.track(OPENAI_CHAT)
        tracker.flush()
        self.assertIsNot(seen[0], threading.current_thread())

    def test_model_and_provider_overrides(self):
        tracker, transport, _ = make(stored())
        tracker.track(OPENAI_CHAT, model="gpt-4.1", provider="mistral")
        tracker.flush()
        body = transport.calls[0][1]
        self.assertEqual((body["model"], body["provider"]), ("gpt-4.1", "mistral"))

    def test_reporting_failures_go_to_on_error(self):
        tracker, _, errors = make(failed(401, "unauthorized"))
        self.assertIs(tracker.track(GEMINI_REST), GEMINI_REST)
        tracker.flush()
        error, usage = errors[0]
        self.assertEqual(error.status, 401)
        self.assertEqual(usage.request_id, "gemini-response-1")

    def test_a_response_without_usage_is_reported_and_returned(self):
        tracker, transport, errors = make()
        chunk = {"object": "chat.completion.chunk"}
        self.assertIs(tracker.track(chunk), chunk)
        self.assertEqual(transport.calls, [])
        self.assertEqual(str(errors[0][0]), "No usage in response")
        self.assertIsNone(errors[0][1])

    def test_close_waits_for_pending_reports(self):
        with make(stored())[0] as tracker:
            tracker.track(OPENAI_RESPONSE)
        # Exiting the block closed the tracker after the report finished.
        self.assertEqual(tracker._pending, set())



class AttributionTest(unittest.TestCase):
    def test_track_sends_attribution(self):
        tracker, transport, _ = make(stored())
        tracker.track(ANTHROPIC, customer_id="cus_42", user_id="u_7", feature="support-chat", run_id="run_9")
        tracker.flush()
        body = transport.calls[0][1]
        self.assertEqual(
            (body["customerId"], body["userId"], body["feature"], body["runId"]),
            ("cus_42", "u_7", "support-chat", "run_9"),
        )

    def test_scoped_tracker_adds_attribution_and_explicit_values_win(self):
        tracker, transport, _ = make(stored(), stored(), stored())
        for_customer = tracker.with_attribution(customer_id="cus_42", feature="chat")
        for_customer.track(OPENAI_CHAT)
        for_customer.track(OPENAI_CHAT, feature="search", run_id="r1")
        for_customer.with_attribution(user_id="u_7").record(USAGE)
        # The parent's flush waits for its scoped trackers' reports too.
        tracker.flush()
        # Reports run on background threads, so compare them in any order.
        bodies = sorted(
            (
                (body["customerId"], body["feature"], body.get("runId"), body.get("userId"))
                for body in (call[1] for call in transport.calls)
            ),
            key=repr,
        )
        self.assertEqual(
            bodies,
            sorted(
                [
                    ("cus_42", "chat", None, None),
                    ("cus_42", "search", "r1", None),
                    ("cus_42", "chat", None, "u_7"),
                ],
                key=repr,
            ),
        )

    def test_record_with_a_dict_keeps_its_own_values(self):
        tracker, transport, _ = make(stored())
        tracker.with_attribution(customer_id="cus_42").record(
            {"provider": "openai", "model": "gpt-4.1", "inputTokens": 1, "outputTokens": 1, "customerId": "mine"}
        )
        self.assertEqual(transport.calls[0][1]["customerId"], "mine")

    def test_scoped_tracker_leaves_the_parent_unchanged(self):
        tracker, transport, _ = make(stored())
        tracker.with_attribution(customer_id="cus_42")
        tracker.record(USAGE)
        self.assertNotIn("customerId", transport.calls[0][1])

    def test_usage_payload_names(self):
        usage = Usage("openai", "gpt-4.1", 1, 1, customer_id="c", user_id="u", feature="f", run_id="r")
        payload = usage.to_payload()
        self.assertEqual(
            {key: payload[key] for key in ("customerId", "userId", "feature", "runId")},
            {"customerId": "c", "userId": "u", "feature": "f", "runId": "r"},
        )


def stored_outcome(replayed=False, status=201):
    return status, json.dumps({"outcome": {"id": "out-1", "name": "ticket_resolved"}, "replayed": replayed}).encode()


@mock.patch("cost_tracker.time.sleep", lambda seconds: None)
class RecordOutcomeTest(unittest.TestCase):
    def test_posts_to_the_outcomes_endpoint(self):
        tracker, transport, _ = make(stored_outcome())
        result = tracker.record_outcome(
            "ticket_resolved",
            outcome_id="ticket-881",
            count=2,
            occurred_at=datetime(2026, 11, 4, 9, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(result, OutcomeResult("out-1", False))
        url, body, _ = transport.calls[0]
        self.assertEqual(url, "https://costs.example.com/api/outcomes")
        self.assertEqual(
            body,
            {"name": "ticket_resolved", "count": 2, "outcomeId": "ticket-881", "occurredAt": "2026-11-04T09:00:00+00:00"},
        )

    def test_scoped_attribution_is_added_and_explicit_values_win(self):
        tracker, transport, _ = make(stored_outcome())
        tracker.with_attribution(customer_id="cus_42", feature="chat").record_outcome("ticket_resolved", feature="email")
        self.assertEqual(
            transport.calls[0][1],
            {"name": "ticket_resolved", "customerId": "cus_42", "feature": "email"},
        )

    def test_retries_with_an_outcome_id(self):
        tracker, transport, _ = make(failed(503, "unavailable"), stored_outcome(True, 200))
        self.assertEqual(tracker.record_outcome("ticket_resolved", outcome_id="t-1"), OutcomeResult("out-1", True))
        self.assertEqual(len(transport.calls), 2)

    def test_no_retry_without_an_outcome_id(self):
        tracker, transport, _ = make(failed(503, "unavailable"))
        with self.assertRaises(CostTrackerError) as caught:
            tracker.record_outcome("ticket_resolved")
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(len(transport.calls), 1)

    def test_raises_the_api_code_for_a_conflict(self):
        tracker, _, _ = make(failed(409, "outcome_id_conflict"))
        with self.assertRaises(CostTrackerError) as caught:
            tracker.record_outcome("ticket_resolved", outcome_id="t-1")
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "outcome_id_conflict"))

    def test_rejects_a_naive_occurred_at(self):
        tracker, transport, _ = make()
        with self.assertRaises(ValueError):
            tracker.record_outcome("ticket_resolved", occurred_at=datetime(2026, 11, 4, 9, 0))
        self.assertEqual(transport.calls, [])

if __name__ == "__main__":
    unittest.main()
