"""Tests for cost_tracker.py. Run: python -m unittest discover -s clients/python"""

import asyncio
import json
import threading
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace as Obj
from unittest import mock

from cost_tracker import (
    BudgetCheck,
    BudgetReservation,
    CostTracker,
    CostTrackerError,
    DeliveryStats,
    MonthBudget,
    OutcomeResult,
    RecordResult,
    Reservation,
    RunBudget,
    StreamUsage,
    Usage,
    usage_from_response,
)

from cost_tracker import _retry_delay  # noqa: E402

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

    def test_openai_cache_writes_by_lifetime(self):
        details = {
            "cached_tokens": 4000,
            "cache_write_tokens": 7000,
            "cache_write_tokens_details": {"ttl_30m_tokens": 3000, "ttl_12h_tokens": 4000},
        }
        usage = usage_from_response(
            {**OPENAI_RESPONSE, "usage": {"input_tokens": 12000, "input_tokens_details": details, "output_tokens": 0}}
        )
        self.assertEqual((usage.cache_write_input_tokens, usage.cache_write_1h_input_tokens), (7000, 4000))
        payload = usage.to_payload()
        self.assertEqual(payload["cacheWriteInputTokens"], 7000)
        self.assertEqual(payload["cacheWrite1hInputTokens"], 4000)

    def test_openai_chat_audio_tokens(self):
        details = {"cached_tokens": 1000, "audio_tokens": 1000}
        spoken = {**OPENAI_CHAT, "usage": {**OPENAI_CHAT["usage"], "prompt_tokens_details": details,
                                           "completion_tokens_details": {"audio_tokens": 250}}}
        usage = usage_from_response(spoken)
        # 1,000 audio but only 200 uncached input, so at least 800 was cached.
        self.assertEqual(
            (usage.audio_input_tokens, usage.cached_audio_input_tokens, usage.audio_output_tokens), (1000, 800, 250)
        )
        payload = usage.to_payload()
        self.assertEqual(payload["audioInputTokens"], 1000)
        self.assertEqual(payload["audioOutputTokens"], 250)
        # Without audio the fields are left out.
        self.assertNotIn("audioInputTokens", usage_from_response(OPENAI_CHAT).to_payload())

    def test_openai_images_response(self):
        generated = {
            "created": 1794000000,
            "data": [{"b64_json": "..."}],
            "usage": {
                "input_tokens": 1000,
                "input_tokens_details": {"text_tokens": 200, "image_tokens": 800},
                "output_tokens": 4000,
            },
        }
        usage = usage_from_response(generated)
        self.assertEqual(
            usage, Usage("openai", "", 1000, 4000, image_input_tokens=800, image_output_tokens=4000)
        )
        self.assertEqual(usage.to_payload()["imageOutputTokens"], 4000)
        self.assertNotIn("cachedImageInputTokens", usage.to_payload())
        split = {**generated, "usage": {**generated["usage"], "output_tokens_details": {"image_tokens": 3900}}}
        self.assertEqual(usage_from_response(split).image_output_tokens, 3900)

    def test_openai_realtime_response(self):
        realtime = {
            "object": "realtime.response",
            "id": "resp_rt1",
            "usage": {
                "input_tokens": 2500,
                "output_tokens": 500,
                "input_token_details": {
                    "cached_tokens": 1200,
                    "audio_tokens": 2000,
                    "cached_tokens_details": {"text_tokens": 200, "audio_tokens": 1000},
                },
                "output_token_details": {"audio_tokens": 400},
            },
        }
        self.assertEqual(
            usage_from_response(realtime),
            Usage("openai", "", 2500, 500, cached_input_tokens=1200, request_id="resp_rt1",
                  audio_input_tokens=2000, cached_audio_input_tokens=1000, audio_output_tokens=400),
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

    def test_anthropic_1h_cache_writes_from_cache_creation(self):
        split = {"ephemeral_5m_input_tokens": 500, "ephemeral_1h_input_tokens": 1500}
        as_dict = {**ANTHROPIC, "usage": {**ANTHROPIC["usage"], "cache_creation": split}}
        as_sdk = Obj(
            id="msg_01abc",
            type="message",
            model="claude-sonnet-5-5",
            usage=Obj(
                input_tokens=50,
                cache_creation_input_tokens=2000,
                cache_read_input_tokens=8000,
                output_tokens=400,
                cache_creation=Obj(ephemeral_5m_input_tokens=500, ephemeral_1h_input_tokens=1500),
            ),
        )
        for response in (as_dict, as_sdk):
            usage = usage_from_response(response)
            self.assertEqual((usage.cache_write_input_tokens, usage.cache_write_1h_input_tokens), (2000, 1500))
            self.assertEqual(usage.to_payload()["cacheWrite1hInputTokens"], 1500)
        # Without the breakdown, every write is a 5-minute write.
        self.assertEqual(usage_from_response(ANTHROPIC).cache_write_1h_input_tokens, 0)

    def test_anthropic_web_searches_from_server_tool_use(self):
        as_dict = {**ANTHROPIC, "usage": {**ANTHROPIC["usage"], "server_tool_use": {"web_search_requests": 3}}}
        usage = usage_from_response(as_dict)
        self.assertEqual(usage.web_search_requests, 3)
        self.assertEqual(usage.to_payload()["webSearchRequests"], 3)
        # Without searches the field is left out of the payload.
        plain = usage_from_response(ANTHROPIC)
        self.assertEqual(plain.web_search_requests, 0)
        self.assertNotIn("webSearchRequests", plain.to_payload())

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
                "cacheWrite1hInputTokens": 0,
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


@mock.patch("cost_tracker.time.sleep", lambda seconds: None)
class ServiceTierTest(unittest.TestCase):
    def test_record_and_track_send_batch(self):
        tracker, transport, _ = make(stored(), stored(), stored())
        tracker.record(Usage("anthropic", "claude-sonnet-5-5", 1, 1, service_tier="batch"))
        tracker.track(ANTHROPIC, service_tier="batch")
        tracker.track(ANTHROPIC)
        tracker.flush()
        bodies = [call[1] for call in transport.calls]
        self.assertEqual(bodies[0]["serviceTier"], "batch")
        # Background reports may finish in any order.
        self.assertEqual(sorted(str(body.get("serviceTier")) for body in bodies[1:]), ["None", "batch"])


@mock.patch("cost_tracker.time.sleep", lambda seconds: None)
class TagsTest(unittest.TestCase):
    def test_record_and_track_send_tags(self):
        tracker, transport, _ = make(stored(), stored())
        tracker.record(Usage("openai", "gpt-4.1", 1, 1, tags={"env": "prod"}))
        tracker.track(ANTHROPIC, tags={"team": "search"})
        tracker.flush()
        self.assertEqual(transport.calls[0][1]["tags"], {"env": "prod"})
        self.assertEqual(transport.calls[1][1]["tags"], {"team": "search"})

    def test_scoped_tags_merge_key_by_key_and_the_calls_own_win(self):
        tracker, transport, _ = make(stored(), stored(), stored())
        prod = tracker.with_attribution(tags={"env": "prod", "team": "core"})
        search = prod.with_attribution(customer_id="cus_42", tags={"team": "search"})
        search.record(USAGE)
        search.record({**USAGE.to_payload(), "tags": {"env": "canary", "ab": "b"}})
        prod.record(USAGE)
        bodies = [call[1] for call in transport.calls]
        self.assertEqual(bodies[0]["customerId"], "cus_42")
        self.assertEqual(bodies[0]["tags"], {"env": "prod", "team": "search"})
        self.assertEqual(bodies[1]["tags"], {"env": "canary", "team": "search", "ab": "b"})
        self.assertEqual(bodies[2]["tags"], {"env": "prod", "team": "core"})

    def test_track_merges_over_scoped_tags(self):
        tracker, transport, _ = make(stored())
        tracker.with_attribution(tags={"env": "prod"}).track(OPENAI_CHAT, tags={"ab": "b"})
        tracker.flush()
        self.assertEqual(transport.calls[0][1]["tags"], {"env": "prod", "ab": "b"})

    def test_no_tags_key_without_tags_and_none_on_outcomes(self):
        tracker, transport, _ = make(stored(), stored_outcome())
        tracker.with_attribution(tags={}).record(USAGE)
        tracker.with_attribution(customer_id="cus_42", tags={"env": "prod"}).record_outcome("ticket_resolved")
        self.assertNotIn("tags", transport.calls[0][1])
        # The outcomes API rejects unknown fields, so tags must stay off.
        self.assertEqual(transport.calls[1][1], {"name": "ticket_resolved", "customerId": "cus_42"})

    def test_record_doesnt_change_the_callers_dict(self):
        tracker, _, _ = make(stored())
        payload = {**USAGE.to_payload(), "tags": {"ab": "b"}}
        tracker.with_attribution(tags={"env": "prod"}).record(payload)
        self.assertEqual(payload["tags"], {"ab": "b"})


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


ANSWER = {
    "allowed": False,
    "reasons": ["run_budget"],
    "estimatedCostUsd": "0.250000",
    "month": {
        "period": "2026-11",
        "capUsd": "100.000000",
        "spentUsd": "40.000000",
        "remainingUsd": "60.000000",
        "allowed": True,
    },
    "run": {
        "runId": "run_42",
        "capUsd": "2.000000",
        "spentUsd": "1.900000",
        "remainingUsd": "0.100000",
        "allowed": False,
    },
}


def checked(answer=None):
    return 200, json.dumps(answer or ANSWER).encode()


@mock.patch("cost_tracker.time.sleep", lambda seconds: None)
class CheckBudgetTest(unittest.TestCase):
    def test_posts_the_estimate_and_run_and_returns_the_answer(self):
        tracker, transport, _ = make(checked())
        check = tracker.check_budget("0.25", run_id="run_42")
        url, body, headers = transport.calls[0]
        self.assertEqual(url, "https://costs.example.com/api/budget/check")
        self.assertEqual(headers["authorization"], "Bearer act_test")
        self.assertEqual(body, {"estimatedCostUsd": "0.25", "runId": "run_42"})
        self.assertEqual(
            check,
            BudgetCheck(
                allowed=False,
                reasons=("run_budget",),
                estimated_cost_usd="0.250000",
                month=MonthBudget("100.000000", "40.000000", "60.000000", True, period="2026-11"),
                run=RunBudget("2.000000", "1.900000", "0.100000", False, run_id="run_42"),
            ),
        )

    def test_uses_a_scoped_trackers_run_unless_one_is_passed(self):
        tracker, transport, _ = make(checked(), checked(), checked())
        run = tracker.with_attribution(run_id="run_42", customer_id="cus_1", tags={"env": "prod"})
        run.check_budget(0.25)
        run.check_budget(run_id="run_other")
        tracker.check_budget()
        # Only the run matters to a check; other attribution isn't sent.
        self.assertEqual(transport.calls[0][1], {"estimatedCostUsd": 0.25, "runId": "run_42"})
        self.assertEqual(transport.calls[1][1], {"runId": "run_other"})
        self.assertEqual(transport.calls[2][1], {})

    def test_sends_decimals_in_fixed_point_and_rejects_booleans(self):
        tracker, transport, _ = make(checked())
        tracker.check_budget(Decimal("1E+3"))
        self.assertEqual(transport.calls[0][1], {"estimatedCostUsd": "1000"})
        with self.assertRaises(TypeError):
            tracker.check_budget(True)

    def test_without_a_run_or_caps(self):
        answer = {
            **ANSWER,
            "allowed": True,
            "reasons": [],
            "month": {**ANSWER["month"], "capUsd": None, "remainingUsd": None},
            "run": None,
        }
        tracker, _, _ = make(checked(answer))
        check = tracker.check_budget()
        self.assertTrue(check.allowed)
        self.assertIsNone(check.run)
        self.assertIsNone(check.month.cap_usd)

    def test_retries_network_errors_429_and_5xx(self):
        tracker, transport, _ = make(OSError("down"), failed(503, "unavailable"), checked())
        self.assertFalse(tracker.check_budget().allowed)
        self.assertEqual(len(transport.calls), 3)

    def test_raises_the_api_error_or_for_an_unexpected_response(self):
        tracker, _, _ = make(failed(400, "invalid_payload"), (200, b'{"ok": true}'))
        with self.assertRaises(CostTrackerError) as caught:
            tracker.check_budget("-1")
        self.assertEqual((caught.exception.status, caught.exception.code), (400, "invalid_payload"))
        with self.assertRaisesRegex(CostTrackerError, "Unexpected response"):
            tracker.check_budget()


HOLD = {
    "reservationId": "run_42-step_3",
    "amountUsd": "0.250000",
    "runId": "run_42",
    "status": "held",
    "expiresAt": "2026-11-14T12:10:00.000Z",
}
CAP = {"capUsd": None, "spentUsd": "1.000000", "heldUsd": "0.250000", "remainingUsd": None, "allowed": True}


def reserved(hold=HOLD, allowed=True):
    return 200, json.dumps(
        {
            "allowed": allowed,
            "reasons": [] if allowed else ["monthly_budget"],
            "estimatedCostUsd": "0.250000",
            "month": {"period": "2026-11", **CAP},
            "run": {"runId": "run_42", **CAP},
            "reservation": hold,
            "replayed": False,
        }
    ).encode()


@mock.patch("cost_tracker.time.sleep", lambda seconds: None)
class ReserveBudgetTest(unittest.TestCase):
    def test_reserves_with_a_scoped_run_and_returns_the_hold(self):
        tracker, transport, _ = make(reserved())
        run = tracker.with_attribution(run_id="run_42", customer_id="cus_1")
        result = run.reserve_budget(Decimal("0.25"), reservation_id="run_42-step_3", ttl_seconds=120)
        url, body, _ = transport.calls[0]
        self.assertEqual(url, "https://costs.example.com/api/budget/reserve")
        self.assertEqual(
            body,
            {"reservationId": "run_42-step_3", "estimatedCostUsd": "0.25", "runId": "run_42", "ttlSeconds": 120},
        )
        self.assertIsInstance(result, BudgetReservation)
        self.assertTrue(result.allowed)
        self.assertEqual(result.check.month.held_usd, "0.250000")
        self.assertEqual(
            result.reservation,
            Reservation("run_42-step_3", "0.250000", "run_42", "held", "2026-11-14T12:10:00.000Z"),
        )
        self.assertFalse(result.replayed)

    def test_returns_a_denial_with_no_hold(self):
        tracker, _, _ = make(reserved(hold=None, allowed=False))
        result = tracker.reserve_budget(5, reservation_id="s")
        self.assertFalse(result.allowed)
        self.assertIsNone(result.reservation)
        self.assertEqual(result.check.reasons, ("monthly_budget",))

    def test_retries_since_the_id_makes_it_safe(self):
        tracker, transport, _ = make(failed(503, "unavailable"), reserved())
        self.assertTrue(tracker.reserve_budget("0.25", reservation_id="s").allowed)
        self.assertEqual(len(transport.calls), 2)

    def test_raises_a_conflict_and_rejects_booleans(self):
        tracker, _, _ = make(failed(409, "reservation_conflict"))
        with self.assertRaises(CostTrackerError) as caught:
            tracker.reserve_budget("1", reservation_id="s")
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "reservation_conflict"))
        with self.assertRaises(TypeError):
            tracker.reserve_budget(True, reservation_id="s")

    def test_releases_a_hold(self):
        tracker, transport, _ = make(
            (200, json.dumps({"reservation": {**HOLD, "status": "released"}}).encode()),
            failed(404, "reservation_not_found"),
        )
        self.assertEqual(tracker.release_budget("run_42-step_3").status, "released")
        url, body, _ = transport.calls[0]
        self.assertEqual(url, "https://costs.example.com/api/budget/release")
        self.assertEqual(body, {"reservationId": "run_42-step_3"})
        with self.assertRaises(CostTrackerError) as caught:
            tracker.release_budget("nope")
        self.assertEqual(caught.exception.code, "reservation_not_found")

    def test_settles_a_hold_through_record(self):
        tracker, transport, _ = make(stored())
        tracker.record(Usage("openai", "gpt-4.1", 1000, 500, reservation_id="run_42-step_3"))
        self.assertEqual(transport.calls[0][1]["reservationId"], "run_42-step_3")

    def test_returns_a_null_cost_for_unpriced_usage(self):
        tracker, _, _ = make(stored(cost=None))
        self.assertEqual(tracker.record(USAGE), RecordResult(None, False))


class DeliveryTest(unittest.TestCase):
    def test_jitters_retry_delays_within_a_cap(self):
        self.assertEqual(_retry_delay(1, lambda: 0), 0.125)
        self.assertEqual(_retry_delay(1, lambda: 1), 0.25)
        self.assertEqual(_retry_delay(2, lambda: 1), 1.0)
        self.assertEqual(_retry_delay(9, lambda: 1), 30.0)

    def test_drops_usage_past_max_pending_and_counts_it(self):
        gate = threading.Event()

        def slow_transport(url, body, headers, timeout):
            gate.wait(5)
            return stored()

        errors = []
        tracker = CostTracker(
            "https://costs.example.com",
            "act_test",
            transport=slow_transport,
            on_error=lambda error, usage: errors.append((error, usage)),
            max_pending=2,
        )
        for _ in range(3):
            self.assertIs(tracker.track(ANTHROPIC), ANTHROPIC)
        self.assertEqual(tracker.stats(), DeliveryStats(sent=0, failed=0, dropped=1, pending=2))
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0][0].code, "queue_full")
        gate.set()
        tracker.flush(5)
        scoped = tracker.with_attribution(customer_id="c")
        self.assertEqual(scoped.stats(), DeliveryStats(sent=2, failed=0, dropped=1, pending=0))
        tracker.close()

    def test_counts_reports_that_failed(self):
        tracker, _, errors = make(failed(400, "invalid_payload"))
        tracker.track(ANTHROPIC)
        tracker.flush(5)
        self.assertEqual(tracker.stats().failed, 1)
        self.assertEqual(len(errors), 1)


STREAMS = {
    "openai_chat": [
        {"id": "chatcmpl-1", "object": "chat.completion.chunk", "model": "gpt-4.1", "choices": [], "usage": None},
        {
            "id": "chatcmpl-1",
            "object": "chat.completion.chunk",
            "model": "gpt-4.1",
            "choices": [],
            "usage": {"prompt_tokens": 1200, "completion_tokens": 300, "prompt_tokens_details": {"cached_tokens": 1024}},
        },
    ],
    "openai_responses": [
        {"type": "response.output_text.delta", "delta": "Hi"},
        {
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "object": "response",
                "model": "gpt-5.4-mini",
                "usage": {"input_tokens": 2000, "output_tokens": 700, "input_tokens_details": {"cached_tokens": 512}},
            },
        },
    ],
    "anthropic": [
        {
            "type": "message_start",
            "message": {
                "id": "msg_1",
                "type": "message",
                "model": "claude-sonnet-5-5",
                "usage": {
                    "input_tokens": 50,
                    "cache_read_input_tokens": 8000,
                    "cache_creation_input_tokens": 2000,
                    "output_tokens": 1,
                },
            },
        },
        {"type": "content_block_delta", "delta": {"text": "Hi"}},
        {"type": "message_delta", "usage": {"output_tokens": 400}},
        {"type": "message_stop"},
    ],
    "gemini": [
        {"responseId": "g1", "modelVersion": "gemini-2.5-pro", "usageMetadata": {"promptTokenCount": 100}},
        {
            "responseId": "g1",
            "modelVersion": "gemini-2.5-pro",
            "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 40, "thoughtsTokenCount": 10},
        },
    ],
}


def _collect(chunks, ended=True):
    collected = StreamUsage()
    for chunk in chunks:
        collected.push(chunk)
    return collected.usage(ended)


class StreamUsageTest(unittest.TestCase):
    def test_reads_each_providers_final_usage(self):
        chat = _collect(STREAMS["openai_chat"])
        self.assertEqual((chat.input_tokens, chat.output_tokens, chat.cached_input_tokens), (1200, 300, 1024))
        responses = _collect(STREAMS["openai_responses"])
        self.assertEqual((responses.input_tokens, responses.output_tokens, responses.request_id), (2000, 700, "resp_1"))
        anthropic = _collect(STREAMS["anthropic"])
        self.assertEqual(
            (anthropic.input_tokens, anthropic.output_tokens, anthropic.cached_input_tokens, anthropic.request_id),
            (10050, 400, 8000, "msg_1"),
        )
        gemini = _collect(STREAMS["gemini"])
        self.assertEqual((gemini.input_tokens, gemini.output_tokens), (100, 50))

    def test_reads_sdk_objects(self):
        start = Obj(
            type="message_start",
            message=Obj(
                id="msg_2",
                model="claude-sonnet-5-5",
                usage=Obj(input_tokens=10, output_tokens=1, cache_read_input_tokens=None),
            ),
        )
        delta = Obj(type="message_delta", usage=Obj(output_tokens=7))
        usage = _collect([start, delta])
        self.assertEqual((usage.input_tokens, usage.output_tokens, usage.request_id), (10, 7, "msg_2"))

    def test_has_nothing_for_a_stream_cut_short(self):
        self.assertIsNone(_collect(STREAMS["anthropic"][:2]))
        self.assertIsNone(_collect(STREAMS["gemini"], ended=False))
        self.assertIsNone(_collect(STREAMS["openai_chat"][:1]))


@mock.patch("cost_tracker.time.sleep", lambda seconds: None)
class TrackStreamTest(unittest.TestCase):
    def test_passes_chunks_through_and_reports_once_it_ends(self):
        tracker, transport, errors = make(stored())
        scoped = tracker.with_attribution(customer_id="cus_1")
        seen = list(scoped.track_stream(iter(STREAMS["anthropic"]), feature="chat"))
        self.assertEqual(seen, STREAMS["anthropic"])
        tracker.flush(5)
        body = transport.calls[0][1]
        self.assertEqual(
            (body["provider"], body["outputTokens"], body["customerId"], body["feature"]),
            ("anthropic", 400, "cus_1", "chat"),
        )
        self.assertEqual(errors, [])
        self.assertEqual(tracker.stats().sent, 1)

    def test_reports_nothing_for_a_stream_without_usage(self):
        tracker, transport, errors = make()
        list(tracker.track_stream(iter(STREAMS["openai_chat"][:1])))
        self.assertEqual(transport.calls, [])
        self.assertEqual(errors[0][0].code, "no_usage")

    def test_reports_nothing_when_stopped_early(self):
        tracker, transport, errors = make()
        stream = tracker.track_stream(iter(STREAMS["anthropic"]))
        next(stream)
        stream.close()
        self.assertEqual(transport.calls, [])
        self.assertEqual(errors[0][0].code, "incomplete_stream")

    def test_passes_the_streams_error_to_the_caller(self):
        tracker, _, errors = make()

        def failing():
            yield STREAMS["anthropic"][0]
            raise ConnectionError("connection reset")

        with self.assertRaises(ConnectionError):
            list(tracker.track_stream(failing()))
        self.assertEqual(errors[0][0].code, "incomplete_stream")

    def test_reads_an_async_stream(self):
        tracker, transport, _ = make(stored())

        async def chunks():
            for chunk in STREAMS["gemini"]:
                yield chunk

        async def read():
            return [chunk async for chunk in tracker.track_async_stream(chunks())]

        self.assertEqual(asyncio.run(read()), STREAMS["gemini"])
        tracker.flush(5)
        self.assertEqual(transport.calls[0][1]["provider"], "google")
