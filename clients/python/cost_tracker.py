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

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, Optional, Tuple, Union
from urllib.parse import urljoin

__all__ = [
    "CostTracker",
    "CostTrackerError",
    "RecordResult",
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
            "requestId": self.request_id,
            "occurredAt": occurred_at,
            "metadata": self.metadata,
        }
        return {key: value for key, value in payload.items() if value is not None}


@dataclass(frozen=True)
class RecordResult:
    #: The stored cost in USD, as an exact decimal string.
    cost_usd: str
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


def usage_from_openai_chat(response: Any) -> Optional[Usage]:
    """OpenAI Chat Completions: cached tokens are part of ``prompt_tokens``."""
    usage = _get(response, "usage")
    if not isinstance(_get(usage, "prompt_tokens"), int):
        return None
    return Usage(
        provider="openai",
        model=_get(response, "model") or "",
        input_tokens=_n(_get(usage, "prompt_tokens")),
        # Includes reasoning tokens, which are billed as output.
        output_tokens=_n(_get(usage, "completion_tokens")),
        cached_input_tokens=_n(_get(_get(usage, "prompt_tokens_details"), "cached_tokens")),
        request_id=_get(response, "id"),
    )


def usage_from_openai_response(response: Any) -> Optional[Usage]:
    """OpenAI Responses API: cached tokens are part of ``input_tokens``."""
    usage = _get(response, "usage")
    if not isinstance(_get(usage, "input_tokens"), int):
        return None
    return Usage(
        provider="openai",
        model=_get(response, "model") or "",
        input_tokens=_n(_get(usage, "input_tokens")),
        output_tokens=_n(_get(usage, "output_tokens")),
        cached_input_tokens=_n(_get(_get(usage, "input_tokens_details"), "cached_tokens")),
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
    return Usage(
        provider="anthropic",
        model=_get(response, "model") or "",
        input_tokens=_n(_get(usage, "input_tokens")) + cache_read + cache_write,
        output_tokens=_n(_get(usage, "output_tokens")),
        cached_input_tokens=cache_read,
        cache_write_input_tokens=cache_write,
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
    if kind == "response":
        return usage_from_openai_response(response)
    if kind == "chat.completion":
        return usage_from_openai_chat(response)
    return None


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
    ) -> None:
        self._endpoint = urljoin(base_url, "/api/usage")
        self._api_key = api_key
        self._on_error = on_error or _warn
        self._timeout = timeout
        self._retries = retries
        self._transport = transport or _urllib_transport
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cost-tracker")
        self._pending: "set[Future[None]]" = set()
        self._lock = threading.Lock()

    def record(self, usage: Union[Usage, Dict[str, Any]]) -> RecordResult:
        """Sends one usage record and returns the stored cost.
        Raises CostTrackerError if it isn't stored."""
        payload = usage.to_payload() if isinstance(usage, Usage) else dict(usage)
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
        }
        # Without a request ID a retry could store the usage twice.
        attempts = self._retries + 1 if payload.get("requestId") else 1
        last_error: CostTrackerError = CostTrackerError("not sent")
        for attempt in range(attempts):
            if attempt > 0:
                time.sleep(0.25 * 4 ** (attempt - 1))
            try:
                status, raw = self._transport(self._endpoint, body, headers, self._timeout)
            except OSError as error:  # network errors and timeouts
                last_error = CostTrackerError(f"Could not reach the cost tracker: {error}")
                continue
            try:
                data = json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                data = {}
            if 200 <= status < 300 and isinstance(data.get("event"), dict):
                return RecordResult(
                    cost_usd=data["event"]["costUsd"],
                    replayed=bool(data.get("replayed")),
                )
            error = data.get("error") if isinstance(data.get("error"), dict) else {}
            last_error = CostTrackerError(
                error.get("message") or f"HTTP {status}", status, error.get("code")
            )
            if status != 429 and status < 500:
                break
        raise last_error

    def track(
        self,
        response: Any,
        *,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Reports a provider response's usage in the background and returns
        the response unchanged. Reporting errors go to ``on_error`` and never
        reach the caller.

        ``model`` overrides the model to price (OpenAI responses name dated
        snapshots); ``provider`` is for OpenAI-compatible APIs such as Mistral's.
        """
        usage = usage_from_response(response)
        if usage is None:
            self._on_error(CostTrackerError("No usage in response"), None)
            return response
        if model:
            usage.model = model
        if provider:
            usage.provider = provider
        usage.metadata = metadata

        def report() -> None:
            try:
                self.record(usage)
            except Exception as error:  # never let reporting break the app
                self._on_error(error, usage)

        future = self._executor.submit(report)
        with self._lock:
            self._pending.add(future)
        future.add_done_callback(self._forget)
        return response

    def _forget(self, future: "Future[None]") -> None:
        with self._lock:
            self._pending.discard(future)

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
