"""AI API Cost Tracker client: reports token usage to ``POST /api/usage``.

Dependency-free (standard library only, Python 3.10+). Copy this file into
your project. Only token counts are sent, never prompts or responses.

    tracker = CostTracker(base_url, api_key)
    reply = tracker.track(client.messages.create(...))
    tracker.flush()  # before a short-lived process exits

Responses can be SDK objects (OpenAI, Anthropic, google-genai) or the
plain JSON dicts the REST APIs return.
"""

from __future__ import annotations

import copy
import json
import logging
import random
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, AsyncIterable, AsyncIterator, Callable, Dict, Iterable, Iterator, Optional, Tuple, Union
from urllib.parse import urljoin

__all__ = [
    "BudgetCap",
    "BudgetCheck",
    "BudgetReservation",
    "CostTracker",
    "CostTrackerError",
    "DeliveryStats",
    "MonthBudget",
    "OutcomeResult",
    "RecordResult",
    "Reservation",
    "RunBudget",
    "StreamUsage",
    "Usage",
    "usage_from_anthropic",
    "usage_from_gemini",
    "usage_from_openai_chat",
    "usage_from_openai_response",
    "usage_from_response",
]

logger = logging.getLogger("cost_tracker")


@dataclass
class Usage:
    """One request's usage, as ``POST /api/usage`` takes it."""

    provider: str
    model: str
    #: All input tokens, including cached and cache-write tokens.
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int = 0
    cache_write_input_tokens: int = 0
    #: The provider's ID for the request; makes retries safe.
    request_id: Optional[str] = None
    occurred_at: Optional[Union[str, datetime]] = None
    metadata: Optional[Dict[str, Any]] = field(default=None)
    #: Attribution: IDs you choose, up to 200 characters each.
    customer_id: Optional[str] = None
    #: The end user in your app.
    user_id: Optional[str] = None
    feature: Optional[str] = None
    #: One agent run or workflow.
    run_id: Optional[str] = None
    #: Free-form labels such as ``{"env": "prod"}``: up to 20, keys of
    #: letters, digits and ``_ . / -``, values up to 200 characters.
    tags: Optional[Dict[str, str]] = None
    #: The part of cache_write_input_tokens written with the longer cache lifetime (Anthropic 1-hour, OpenAI 12-hour), which
    #: Anthropic bills at a higher rate. Last, so positional use is unchanged.
    cache_write_1h_input_tokens: int = 0
    #: "batch" for a provider's discounted Batch API (Anthropic: 50%); None
    #: means standard, the server's default.
    service_tier: Optional[str] = None
    #: Server-side web searches the request ran, charged per 1,000 on top of
    #: tokens (Anthropic: $10). Needs a web search price for the model.
    web_search_requests: int = 0
    #: Audio tokens, billed at the model's audio rates (OpenAI's audio and
    #: realtime models): parts of input_tokens, cached_input_tokens and
    #: output_tokens. Needs audio rates for the model.
    audio_input_tokens: int = 0
    cached_audio_input_tokens: int = 0
    audio_output_tokens: int = 0
    #: Image tokens (OpenAI's image generation models), billed at the model's
    #: image rates, or as text without them: parts of the same totals.
    image_input_tokens: int = 0
    cached_image_input_tokens: int = 0
    image_output_tokens: int = 0
    #: The reserve_budget() hold this usage settles.
    reservation_id: Optional[str] = None

    def to_payload(self) -> Dict[str, Any]:
        occurred_at = self.occurred_at
        if isinstance(occurred_at, datetime):
            if occurred_at.tzinfo is None:
                raise ValueError("occurred_at must be timezone-aware")
            occurred_at = occurred_at.isoformat()
        payload = {
            "provider": self.provider,
            "model": self.model,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cachedInputTokens": self.cached_input_tokens,
            "cacheWriteInputTokens": self.cache_write_input_tokens,
            "cacheWrite1hInputTokens": self.cache_write_1h_input_tokens,
            "serviceTier": self.service_tier,
            # Sent only when there were searches.
            "webSearchRequests": self.web_search_requests or None,
            # Sent only when there are any.
            "audioInputTokens": self.audio_input_tokens or None,
            "cachedAudioInputTokens": self.cached_audio_input_tokens or None,
            "audioOutputTokens": self.audio_output_tokens or None,
            "imageInputTokens": self.image_input_tokens or None,
            "cachedImageInputTokens": self.cached_image_input_tokens or None,
            "imageOutputTokens": self.image_output_tokens or None,
            "requestId": self.request_id,
            "occurredAt": occurred_at,
            "metadata": self.metadata,
            "customerId": self.customer_id,
            "userId": self.user_id,
            "feature": self.feature,
            "runId": self.run_id,
            "tags": self.tags,
            "reservationId": self.reservation_id,
        }
        return {key: value for key, value in payload.items() if value is not None}


@dataclass(frozen=True)
class OutcomeResult:
    #: The stored outcome's ID.
    id: str
    #: True when this outcome ID was already recorded.
    replayed: bool


@dataclass(frozen=True)
class BudgetCap:
    """One cap in a budget check. Amounts are exact decimal strings."""

    #: None when no cap is set, which never denies.
    cap_usd: Optional[str]
    spent_usd: str
    #: Negative when over the cap; None without a cap.
    remaining_usd: Optional[str]
    allowed: bool


@dataclass(frozen=True)
class MonthBudget(BudgetCap):
    #: The UTC month, e.g. "2026-11".
    period: str
    #: Unexpired reservations, which count like spend.
    held_usd: str = "0.000000"


@dataclass(frozen=True)
class RunBudget(BudgetCap):
    run_id: str
    #: Unexpired reservations, which count like spend.
    held_usd: str = "0.000000"


@dataclass(frozen=True)
class BudgetCheck:
    """The answer to ``check_budget()``."""

    allowed: bool
    #: Why it was denied ("monthly_budget", "run_budget"); empty when allowed.
    reasons: Tuple[str, ...]
    estimated_cost_usd: str
    #: This UTC month against the project's monthly budget.
    month: MonthBudget
    #: The run against the project's run budget; None without a run ID.
    run: Optional[RunBudget]


def _cap_fields(data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "cap_usd": data["capUsd"],
        "spent_usd": data["spentUsd"],
        "remaining_usd": data["remainingUsd"],
        "allowed": data["allowed"],
        "held_usd": data.get("heldUsd", "0.000000"),
    }


def _budget_check(data: Dict[str, Any]) -> BudgetCheck:
    try:
        month = MonthBudget(period=data["month"]["period"], **_cap_fields(data["month"]))
        run_data = data.get("run")
        run = RunBudget(run_id=run_data["runId"], **_cap_fields(run_data)) if run_data else None
        allowed = data["allowed"]
        if not isinstance(allowed, bool):
            raise TypeError("allowed")
        return BudgetCheck(
            allowed=allowed,
            reasons=tuple(data["reasons"]),
            estimated_cost_usd=data["estimatedCostUsd"],
            month=month,
            run=run,
        )
    except (KeyError, TypeError) as error:
        raise CostTrackerError("Unexpected response") from error


@dataclass(frozen=True)
class Reservation:
    """A hold on part of the budgets, from ``reserve_budget()``."""

    reservation_id: str
    #: The amount held, as an exact decimal string.
    amount_usd: str
    run_id: Optional[str]
    #: "held", "released", "settled", or "expired" once past expires_at.
    status: str
    expires_at: str


@dataclass(frozen=True)
class BudgetReservation:
    """The answer to ``reserve_budget()``: the check, and the hold if allowed."""

    check: BudgetCheck
    #: None when denied: nothing is held.
    reservation: Optional[Reservation]
    #: True when this reservation ID was already used.
    replayed: bool

    @property
    def allowed(self) -> bool:
        return self.check.allowed


def _reservation(data: Any) -> Reservation:
    try:
        return Reservation(
            reservation_id=data["reservationId"],
            amount_usd=data["amountUsd"],
            run_id=data.get("runId"),
            status=data["status"],
            expires_at=data["expiresAt"],
        )
    except (KeyError, TypeError, AttributeError) as error:
        raise CostTrackerError("Unexpected response") from error


@dataclass(frozen=True)
class DeliveryStats:
    """How background reporting has gone since the tracker was created."""

    #: Reports the server accepted.
    sent: int
    #: Reports that failed after their retries; each went to on_error.
    failed: int
    #: Usage not sent because too many reports were pending.
    dropped: int
    #: Reports still waiting or in flight.
    pending: int


class _Counts:
    """Delivery counts, shared by a tracker and its scoped copies."""

    def __init__(self) -> None:
        self.sent = 0
        self.failed = 0
        self.dropped = 0


def _retry_delay(attempt: int, rand: Callable[[], float] = random.random) -> float:
    """Seconds before retry ``attempt`` (1, 2, ...): 0.25, then 1, 4...,
    jittered to 50-100% so clients that failed together don't retry together."""
    return min(0.25 * 4 ** (attempt - 1) * (0.5 + rand() * 0.5), 30.0)


@dataclass(frozen=True)
class RecordResult:
    #: The stored cost in USD, as an exact decimal string; None while unpriced.
    cost_usd: Optional[str]
    #: True when this request ID was already recorded.
    replayed: bool


class CostTrackerError(Exception):
    """A rejected or failed ``POST /api/usage``."""

    def __init__(self, message: str, status: Optional[int] = None, code: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code


def _get(obj: Any, *names: str) -> Any:
    """Reads the first present field, from an SDK object or a JSON dict."""
    if obj is None:
        return None
    for name in names:
        value = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
        if value is not None:
            return value
    return None


def _n(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _cached_audio(input_tokens: int, cached: int, audio_in: int, reported: Optional[int]) -> int:
    """Cached audio (or image) input: as reported, or else the least the
    totals allow."""
    if reported is None:
        reported = max(0, audio_in - (input_tokens - cached))
    return min(reported, audio_in, cached)


def usage_from_openai_image(response: Any) -> Optional[Usage]:
    """OpenAI Images API (``images.generate`` / ``images.edit``): input split
    into text and image tokens; the output is the generated images. The
    response names no model, so pass one to track()."""
    usage = _get(response, "usage")
    if not isinstance(_get(usage, "input_tokens"), int):
        return None
    input_tokens = _n(_get(usage, "input_tokens"))
    output_tokens = _n(_get(usage, "output_tokens"))
    details = _get(usage, "input_tokens_details")
    cached = _n(_get(details, "cached_tokens"))
    image_in = _n(_get(details, "image_tokens"))
    output_details = _get(usage, "output_tokens_details")
    # Older models report no output split: all of it is image.
    image_out = _n(_get(output_details, "image_tokens")) if output_details is not None else output_tokens
    return Usage(
        provider="openai",
        model=_get(response, "model") or "",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_input_tokens=cached,
        image_input_tokens=image_in,
        cached_image_input_tokens=_cached_audio(input_tokens, cached, image_in, None),
        image_output_tokens=image_out,
    )


def usage_from_openai_chat(response: Any) -> Optional[Usage]:
    """OpenAI Chat Completions: cached tokens are part of ``prompt_tokens``,
    and audio tokens (gpt-audio) are reported in the token details."""
    usage = _get(response, "usage")
    if not isinstance(_get(usage, "prompt_tokens"), int):
        return None
    input_tokens = _n(_get(usage, "prompt_tokens"))
    details = _get(usage, "prompt_tokens_details")
    cached = _n(_get(details, "cached_tokens"))
    audio_in = _n(_get(details, "audio_tokens"))
    return Usage(
        provider="openai",
        model=_get(response, "model") or "",
        input_tokens=input_tokens,
        # Includes reasoning tokens, which are billed as output.
        output_tokens=_n(_get(usage, "completion_tokens")),
        cached_input_tokens=cached,
        audio_input_tokens=audio_in,
        cached_audio_input_tokens=_cached_audio(input_tokens, cached, audio_in, None),
        audio_output_tokens=_n(_get(_get(usage, "completion_tokens_details"), "audio_tokens")),
        request_id=_get(response, "id"),
    )


def usage_from_openai_response(response: Any) -> Optional[Usage]:
    """OpenAI Responses API: cached tokens are part of ``input_tokens``. Also
    reads a Realtime API response (from ``response.done``), whose
    ``input_token_details`` split audio from text, cached included."""
    usage = _get(response, "usage")
    if not isinstance(_get(usage, "input_tokens"), int):
        return None
    input_tokens = _n(_get(usage, "input_tokens"))
    realtime = _get(usage, "input_token_details")
    details = _get(usage, "input_tokens_details") or realtime
    cached = _n(_get(details, "cached_tokens"))
    audio_in = _n(_get(details, "audio_tokens"))
    reported = _n(_get(_get(realtime, "cached_tokens_details"), "audio_tokens")) if realtime is not None else None
    # GPT-5.6 and later charge for cache writes; 12-hour writes cost more.
    cache_write = _n(_get(details, "cache_write_tokens"))
    cache_write_12h = min(_n(_get(_get(details, "cache_write_tokens_details"), "ttl_12h_tokens")), cache_write)
    return Usage(
        provider="openai",
        model=_get(response, "model") or "",
        input_tokens=input_tokens,
        output_tokens=_n(_get(usage, "output_tokens")),
        cached_input_tokens=cached,
        cache_write_input_tokens=cache_write,
        cache_write_1h_input_tokens=cache_write_12h,
        audio_input_tokens=audio_in,
        cached_audio_input_tokens=_cached_audio(input_tokens, cached, audio_in, reported),
        audio_output_tokens=_n(_get(_get(usage, "output_token_details"), "audio_tokens")),
        request_id=_get(response, "id"),
    )


def usage_from_anthropic(response: Any) -> Optional[Usage]:
    """Anthropic Messages: ``input_tokens`` excludes cache reads and writes,
    so they're added back to give the total input the tracker expects."""
    usage = _get(response, "usage")
    if not isinstance(_get(usage, "input_tokens"), int):
        return None
    cache_read = _n(_get(usage, "cache_read_input_tokens"))
    cache_write = _n(_get(usage, "cache_creation_input_tokens"))
    # ``cache_creation`` splits the writes by TTL; 1-hour writes cost more.
    cache_write_1h = min(_n(_get(_get(usage, "cache_creation"), "ephemeral_1h_input_tokens")), cache_write)
    return Usage(
        provider="anthropic",
        model=_get(response, "model") or "",
        input_tokens=_n(_get(usage, "input_tokens")) + cache_read + cache_write,
        output_tokens=_n(_get(usage, "output_tokens")),
        cached_input_tokens=cache_read,
        cache_write_input_tokens=cache_write,
        cache_write_1h_input_tokens=cache_write_1h,
        # Billed per search, apart from tokens.
        web_search_requests=_n(_get(_get(usage, "server_tool_use"), "web_search_requests")),
        request_id=_get(response, "id"),
    )


def usage_from_gemini(response: Any) -> Optional[Usage]:
    """Gemini ``generate_content``: the prompt count already includes cached
    content. Thinking tokens are billed as output, and tool-use prompt
    tokens as input, so both are added in."""
    usage = _get(response, "usage_metadata", "usageMetadata")
    prompt = _get(usage, "prompt_token_count", "promptTokenCount")
    if not isinstance(prompt, int):
        return None
    return Usage(
        provider="google",
        model=_get(response, "model_version", "modelVersion") or "",
        input_tokens=prompt + _n(_get(usage, "tool_use_prompt_token_count", "toolUsePromptTokenCount")),
        output_tokens=_n(_get(usage, "candidates_token_count", "candidatesTokenCount"))
        + _n(_get(usage, "thoughts_token_count", "thoughtsTokenCount")),
        cached_input_tokens=_n(_get(usage, "cached_content_token_count", "cachedContentTokenCount")),
        request_id=_get(response, "response_id", "responseId"),
    )


_ANTHROPIC_USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation",
    "server_tool_use",
)


def _anthropic_usage(usage: Any) -> Dict[str, Any]:
    """An Anthropic usage block as a dict, from an SDK object or a dict."""
    fields = {name: _get(usage, name) for name in _ANTHROPIC_USAGE_FIELDS}
    return {name: value for name, value in fields.items() if value is not None}


class StreamUsage:
    """Collects usage from a streamed response's chunks as they pass. Each
    provider reports a stream's usage once it's complete:

    - OpenAI Chat Completions: a last chunk with ``usage``, only when the
      request sets ``stream_options={"include_usage": True}``.
    - OpenAI Responses: the ``response.completed`` (or ``.incomplete``) event.
    - Anthropic Messages: ``message_start`` has the input counts and
      ``message_delta`` the final output count.
    - Gemini: each chunk's usage metadata; the last one has the totals.

    ``usage(ended)`` is None until the final usage has been seen, so a
    stream cut short is never reported with partial counts."""

    def __init__(self) -> None:
        self._final: Optional[Usage] = None
        self._anthropic: Optional[Dict[str, Any]] = None
        self._gemini: Any = None

    def push(self, chunk: Any) -> None:
        if chunk is None:
            return
        kind = _get(chunk, "type")
        if _get(chunk, "object") == "chat.completion.chunk" and _get(chunk, "usage") is not None:
            self._final = usage_from_openai_chat(chunk)
        elif kind in ("response.completed", "response.incomplete") and _get(chunk, "response") is not None:
            self._final = usage_from_openai_response(_get(chunk, "response"))
        elif kind == "message_start" and _get(chunk, "message") is not None:
            message = _get(chunk, "message")
            self._anthropic = {
                "type": "message",
                "id": _get(message, "id"),
                "model": _get(message, "model"),
                "usage": _anthropic_usage(_get(message, "usage")),
            }
        elif kind == "message_delta" and _get(chunk, "usage") is not None and self._anthropic is not None:
            # The delta's counts are cumulative; they replace the start's.
            self._anthropic["usage"].update(_anthropic_usage(_get(chunk, "usage")))
            self._final = usage_from_anthropic(self._anthropic)
        elif _get(chunk, "usage_metadata", "usageMetadata") is not None:
            self._gemini = chunk

    def usage(self, ended: bool) -> Optional[Usage]:
        """The stream's usage, if complete; Gemini's needs the stream ended."""
        if self._final is not None:
            return self._final
        return usage_from_gemini(self._gemini) if ended and self._gemini is not None else None


def usage_from_response(response: Any) -> Optional[Usage]:
    """Reads usage from a response of any supported API, or returns None when
    the response has none (e.g. a stream chunk without usage)."""
    if response is None or isinstance(response, (str, bytes, int, float)):
        return None
    if _get(response, "usage_metadata", "usageMetadata") is not None:
        return usage_from_gemini(response)
    if _get(response, "type") == "message":
        return usage_from_anthropic(response)
    kind = _get(response, "object")
    # A Realtime ``response.done`` event's response names no model, so pass
    # one to track().
    if kind in ("response", "realtime.response"):
        return usage_from_openai_response(response)
    if kind == "chat.completion":
        return usage_from_openai_chat(response)
    # An Images API response: generated images in ``data``, no object type.
    if isinstance(_get(response, "data"), list) and isinstance(_get(response, "created"), int):
        return usage_from_openai_image(response)
    return None


def _attribution(
    customer_id: Optional[str], user_id: Optional[str], feature: Optional[str], run_id: Optional[str]
) -> Dict[str, str]:
    """The given attribution, keyed by API field name, without unset values."""
    values = {"customerId": customer_id, "userId": user_id, "feature": feature, "runId": run_id}
    return {key: value for key, value in values.items() if value is not None}


#: Sends one POST and returns (status, body). Replaceable for tests.
Transport = Callable[[str, bytes, Dict[str, str], float], Tuple[int, bytes]]


def _urllib_transport(url: str, body: bytes, headers: Dict[str, str], timeout: float) -> Tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def _warn(error: BaseException, usage: Optional[Usage]) -> None:
    logger.warning("usage not recorded: %s", error)


class CostTracker:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        on_error: Optional[Callable[[BaseException, Optional[Usage]], None]] = None,
        timeout: float = 10.0,
        retries: int = 2,
        transport: Optional[Transport] = None,
        max_pending: int = 1000,
    ) -> None:
        self._base_url = base_url
        self._api_key = api_key
        self._on_error = on_error or _warn
        self._timeout = timeout
        self._retries = retries
        self._transport = transport or _urllib_transport
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cost-tracker")
        self._pending: "set[Future[None]]" = set()
        #: Background reports allowed at once; beyond this, usage is dropped.
        self._max_pending = max_pending
        self._counts = _Counts()
        self._lock = threading.Lock()
        #: Attribution added by with_attribution(), as API field names.
        self._defaults: Dict[str, str] = {}
        #: Tags added by with_attribution(), for usage only.
        self._default_tags: Dict[str, str] = {}

    def with_attribution(
        self,
        *,
        customer_id: Optional[str] = None,
        user_id: Optional[str] = None,
        feature: Optional[str] = None,
        run_id: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None,
    ) -> "CostTracker":
        """A tracker that adds this attribution to everything it records,
        e.g. once per request, and these tags to its usage (outcomes have no
        tags). Values passed to record() or track() win; tags merge key by
        key. It shares this tracker's background threads, so flush() and
        close() on either cover both."""
        scoped = copy.copy(self)
        scoped._defaults = {
            **self._defaults,
            **_attribution(customer_id, user_id, feature, run_id),
        }
        scoped._default_tags = {**self._default_tags, **(tags or {})}
        return scoped

    def _post(self, path: str, payload: Dict[str, Any], retryable: bool) -> Dict[str, Any]:
        """POSTs a JSON body and returns the parsed response. Network errors,
        429s and 5xx are retried only when ``retryable``, i.e. when the body
        carries an ID that keeps a retry from being stored twice."""
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
        }
        attempts = self._retries + 1 if retryable else 1
        last_error: CostTrackerError = CostTrackerError("not sent")
        for attempt in range(attempts):
            if attempt > 0:
                time.sleep(_retry_delay(attempt))
            try:
                status, raw = self._transport(urljoin(self._base_url, path), body, headers, self._timeout)
            except OSError as error:  # network errors and timeouts
                last_error = CostTrackerError(f"Could not reach the cost tracker: {error}")
                continue
            try:
                data = json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                data = {}
            if 200 <= status < 300 and isinstance(data, dict):
                return data
            error = data.get("error") if isinstance(data, dict) and isinstance(data.get("error"), dict) else {}
            last_error = CostTrackerError(error.get("message") or f"HTTP {status}", status, error.get("code"))
            if status != 429 and status < 500:
                break
        raise last_error

    def record(self, usage: Union[Usage, Dict[str, Any]]) -> RecordResult:
        """Sends one usage record and returns the stored cost.
        Raises CostTrackerError if it isn't stored."""
        payload = usage.to_payload() if isinstance(usage, Usage) else dict(usage)
        for key, value in self._defaults.items():
            payload.setdefault(key, value)
        tags = {**self._default_tags, **(payload.get("tags") or {})}
        if tags:
            payload["tags"] = tags
        else:
            payload.pop("tags", None)
        # Without a request ID a retry could store the usage twice.
        data = self._post("/api/usage", payload, bool(payload.get("requestId")))
        event = data.get("event")
        if not isinstance(event, dict) or "costUsd" not in event:
            raise CostTrackerError("Unexpected response")
        return RecordResult(cost_usd=event["costUsd"], replayed=bool(data.get("replayed")))

    def record_outcome(
        self,
        name: str,
        *,
        count: Optional[int] = None,
        outcome_id: Optional[str] = None,
        occurred_at: Optional[Union[str, datetime]] = None,
        customer_id: Optional[str] = None,
        user_id: Optional[str] = None,
        feature: Optional[str] = None,
        run_id: Optional[str] = None,
    ) -> OutcomeResult:
        """Records a business outcome, such as a resolved ticket, for cost
        per outcome. Attribute it like usage; a scoped tracker's attribution
        is added. Retried only with an ``outcome_id``. Raises CostTrackerError
        if it isn't stored."""
        if isinstance(occurred_at, datetime):
            if occurred_at.tzinfo is None:
                raise ValueError("occurred_at must be timezone-aware")
            occurred_at = occurred_at.isoformat()
        fields = {"name": name, "count": count, "outcomeId": outcome_id, "occurredAt": occurred_at}
        payload = {key: value for key, value in fields.items() if value is not None}
        payload.update(_attribution(customer_id, user_id, feature, run_id))
        for key, value in self._defaults.items():
            payload.setdefault(key, value)
        data = self._post("/api/outcomes", payload, outcome_id is not None)
        outcome = data.get("outcome")
        if not isinstance(outcome, dict) or "id" not in outcome:
            raise CostTrackerError("Unexpected response")
        return OutcomeResult(id=outcome["id"], replayed=bool(data.get("replayed")))

    def check_budget(
        self,
        estimated_cost_usd: Optional[Union[str, int, float, Decimal]] = None,
        *,
        run_id: Optional[str] = None,
    ) -> BudgetCheck:
        """Asks whether the project may spend ``estimated_cost_usd`` now,
        under its monthly budget and, given a run ID, its run budget. A
        scoped tracker's ``run_id`` is used unless one is passed.

        A denial is a result with ``allowed=False``, not an error. Failures
        raise CostTrackerError, so decide whether to fail open or closed.
        Retried after network errors, 429s and 5xx, since a check changes
        nothing."""
        payload: Dict[str, Any] = {}
        if estimated_cost_usd is not None:
            if isinstance(estimated_cost_usd, bool):
                raise TypeError("estimated_cost_usd must be a number or a decimal string")
            # Decimal("1E+3") would be sent as "1E+3"; fixed-point is what the API reads.
            payload["estimatedCostUsd"] = (
                format(estimated_cost_usd, "f") if isinstance(estimated_cost_usd, Decimal) else estimated_cost_usd
            )
        run = run_id if run_id is not None else self._defaults.get("runId")
        if run is not None:
            payload["runId"] = run
        return _budget_check(self._post("/api/budget/check", payload, True))

    def reserve_budget(
        self,
        estimated_cost_usd: Union[str, int, float, Decimal],
        *,
        reservation_id: str,
        run_id: Optional[str] = None,
        ttl_seconds: Optional[int] = None,
    ) -> BudgetReservation:
        """Holds ``estimated_cost_usd`` of the budgets for a step if it fits,
        so concurrent steps can't overspend together. Settle the hold by
        sending the step's usage with the same ``reservation_id``, or call
        release_budget(). A denial has ``allowed=False`` and no reservation.
        Retried after network errors, 429s and 5xx: the ID makes it safe."""
        if isinstance(estimated_cost_usd, bool):
            raise TypeError("estimated_cost_usd must be a number or a decimal string")
        payload: Dict[str, Any] = {
            "reservationId": reservation_id,
            "estimatedCostUsd": (
                format(estimated_cost_usd, "f") if isinstance(estimated_cost_usd, Decimal) else estimated_cost_usd
            ),
        }
        run = run_id if run_id is not None else self._defaults.get("runId")
        if run is not None:
            payload["runId"] = run
        if ttl_seconds is not None:
            payload["ttlSeconds"] = ttl_seconds
        data = self._post("/api/budget/reserve", payload, True)
        if "reservation" not in data:
            raise CostTrackerError("Unexpected response")
        hold = data["reservation"]
        return BudgetReservation(
            check=_budget_check(data),
            reservation=_reservation(hold) if hold is not None else None,
            replayed=bool(data.get("replayed")),
        )

    def release_budget(self, reservation_id: str) -> Reservation:
        """Ends a hold whose step didn't spend. Safe to repeat."""
        data = self._post("/api/budget/release", {"reservationId": reservation_id}, True)
        return _reservation(data.get("reservation"))

    def track(
        self,
        response: Any,
        *,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        customer_id: Optional[str] = None,
        user_id: Optional[str] = None,
        feature: Optional[str] = None,
        run_id: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None,
        service_tier: Optional[str] = None,
    ) -> Any:
        """Reports a provider response's usage in the background and returns
        the response unchanged. Reporting errors go to ``on_error`` and never
        reach the caller.

        ``model`` overrides the model to price (OpenAI responses name dated
        snapshots); ``provider`` is for OpenAI-compatible APIs such as Mistral's.
        ``customer_id``, ``user_id``, ``feature`` and ``run_id`` attribute the
        usage; ``tags`` label it, merged over a scoped tracker's tags.
        ``service_tier="batch"`` records a Batch API response at the batch price.
        """
        usage = usage_from_response(response)
        if usage is None:
            self._on_error(CostTrackerError("No usage in response"), None)
            return response
        self._report(
            usage,
            model=model,
            provider=provider,
            metadata=metadata,
            customer_id=customer_id,
            user_id=user_id,
            feature=feature,
            run_id=run_id,
            tags=tags,
            service_tier=service_tier,
        )
        return response

    def track_stream(self, stream: Iterable[Any], **options: Any) -> Iterator[Any]:
        """Passes a streamed response's chunks through unchanged and reports
        its usage in the background once the stream has finished. Iterate what
        it returns instead of the stream; it takes the same keyword options as
        track(). A stream that ends without its usage, or is stopped early,
        reports nothing and calls ``on_error`` with code "no_usage" or
        "incomplete_stream". Stream errors reach you as usual."""
        collected = StreamUsage()
        ended = False
        try:
            for chunk in stream:
                collected.push(chunk)
                yield chunk
            ended = True
        finally:
            self._finish_stream(collected, ended, options)

    async def track_async_stream(self, stream: AsyncIterable[Any], **options: Any) -> AsyncIterator[Any]:
        """track_stream() for an async stream, such as the async SDKs'."""
        collected = StreamUsage()
        ended = False
        try:
            async for chunk in stream:
                collected.push(chunk)
                yield chunk
            ended = True
        finally:
            self._finish_stream(collected, ended, options)

    def _finish_stream(self, collected: StreamUsage, ended: bool, options: Dict[str, Any]) -> None:
        usage = collected.usage(ended)
        if usage is not None:
            self._report(usage, **options)
        elif ended:
            self._on_error(
                CostTrackerError(
                    "No usage in stream (OpenAI Chat Completions need stream_options include_usage)",
                    None,
                    "no_usage",
                ),
                None,
            )
        else:
            self._on_error(CostTrackerError("Stream ended before its usage arrived", None, "incomplete_stream"), None)

    def _report(
        self,
        usage: Usage,
        *,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        customer_id: Optional[str] = None,
        user_id: Optional[str] = None,
        feature: Optional[str] = None,
        run_id: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None,
        service_tier: Optional[str] = None,
    ) -> None:
        """Applies track() options and sends in the background, within the bound."""
        if model:
            usage.model = model
        if provider:
            usage.provider = provider
        usage.metadata = metadata
        usage.customer_id = customer_id
        usage.user_id = user_id
        usage.feature = feature
        usage.run_id = run_id
        usage.tags = tags
        usage.service_tier = service_tier

        def report() -> None:
            try:
                self.record(usage)
            except Exception as error:  # never let reporting break the app
                with self._lock:
                    self._counts.failed += 1
                self._on_error(error, usage)
            else:
                with self._lock:
                    self._counts.sent += 1

        with self._lock:
            full = len(self._pending) >= self._max_pending
            if full:
                self._counts.dropped += 1
            else:
                future = self._executor.submit(report)
                self._pending.add(future)
        if full:
            # A slow or unreachable tracker can't grow memory without bound.
            self._on_error(
                CostTrackerError(f"{self._max_pending} reports already pending; usage dropped", None, "queue_full"),
                usage,
            )
            return
        future.add_done_callback(self._forget)

    def _forget(self, future: "Future[None]") -> None:
        with self._lock:
            self._pending.discard(future)

    def stats(self) -> DeliveryStats:
        """Counts of background reports, shared by scoped trackers."""
        with self._lock:
            return DeliveryStats(
                sent=self._counts.sent,
                failed=self._counts.failed,
                dropped=self._counts.dropped,
                pending=len(self._pending),
            )

    def flush(self, timeout: Optional[float] = None) -> None:
        """Waits for every background report, e.g. before a process exits."""
        with self._lock:
            pending = list(self._pending)
        wait(pending, timeout=timeout)

    def close(self) -> None:
        """Waits for pending reports and stops the background threads."""
        self._executor.shutdown(wait=True)

    def __enter__(self) -> "CostTracker":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
