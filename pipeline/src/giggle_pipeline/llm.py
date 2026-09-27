"""LLM access for the build: Cloudflare Workers AI, or a fake for offline runs and tests.

Each task names its model in MODELS, so moving a task to a cheaper or better model is
a one-line change: put the old model in PREVIOUS_MODELS and its cached answers keep
counting (they're checked again on every build anyway) until the new model replaces them.
Responses are requested as JSON matching a schema; the caller validates them and falls
back to rules when a model can't comply.

A client carries the run's request budget, shared by every task, with a cap per task
(`task_max_calls`) so one task can't spend the others' share. Workers AI's free tier is
a daily allowance: once it says that's spent, the client stops asking for the night.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from collections import Counter
from collections.abc import Callable, Mapping
from typing import Any, Protocol

import httpx

from giggle_pipeline.cache import Cache, key_for

QWEN3 = "@cf/qwen/qwen3-30b-a3b-fp8"
MODELS = {"lineup": QWEN3, "blurb": QWEN3}
PREVIOUS_MODELS: dict[str, tuple[str, ...]] = {}
# Tasks that don't benefit from Qwen3's reasoning pass: /no_think makes line-ups ~4x faster
# (5 s instead of 22 s per batch of 12) with the same answers on our listings.
NO_THINK = {"lineup", "blurb"}
ATTEMPTS = 3
FAILED_SHARE = 0.2  # more of a task's requests failing than this needs looking at

_THINK = re.compile(r"<think>.*?</think>", re.S)
# Workers AI's answer once the account's free daily neurons are spent (HTTP 429).
_DAILY_QUOTA = re.compile(r"\b4006\b|daily free allocation", re.I)


class LLMError(Exception):
    pass


class QuotaExhausted(LLMError):
    """The provider's daily allowance is spent: no more requests tonight."""


class BudgetSpent(LLMError):
    """This run's request budget (or the task's share of it) is spent."""


class LLM(Protocol):
    name: str

    def json(self, task: str, system: str, user: str, schema: dict[str, Any]) -> Any:
        """Ask for a JSON value matching `schema`. Raises LLMError on failure."""
        ...

    def remaining(self, task: str) -> int:
        """Requests `task` may still make this run."""
        ...


class Client:
    """Budget and bookkeeping shared by the real and the fake model. Thread-safe: tasks
    send their requests from a thread pool."""

    name = "client"

    def __init__(
        self, max_calls: int | None = None, task_max_calls: Mapping[str, int] | None = None
    ) -> None:
        self.max_calls = max_calls
        self.task_max_calls = dict(task_max_calls or {})
        self.calls = 0  # requests sent (retries included)
        self.task_calls: Counter[str] = Counter()
        self.asked: Counter[str] = Counter()  # json() calls per task
        self.failed: Counter[str] = Counter()  # ...that failed
        self.skipped: Counter[str] = Counter()  # ...not sent: budget or quota spent
        self.quota_exhausted = False
        self._lock = threading.Lock()

    def remaining(self, task: str) -> int:
        if self.quota_exhausted:
            return 0
        left = [sys.maxsize]
        if self.max_calls is not None:
            left.append(self.max_calls - self.calls)
        if task in self.task_max_calls:
            left.append(self.task_max_calls[task] - self.task_calls[task])
        return max(0, min(left))

    def json(self, task: str, system: str, user: str, schema: dict[str, Any]) -> Any:
        with self._lock:
            self.asked[task] += 1
        try:
            value = self._json(task, system, user, schema)
            _check_shape(value, schema)
            return value
        except (BudgetSpent, QuotaExhausted):
            with self._lock:
                self.skipped[task] += 1
            raise
        except LLMError:
            with self._lock:
                self.failed[task] += 1
            raise

    def _json(self, task: str, system: str, user: str, schema: dict[str, Any]) -> Any:
        raise NotImplementedError

    def _spend(self, task: str) -> None:
        """Count one request against the budget, or raise if there's none left."""
        with self._lock:
            if self.quota_exhausted:
                raise QuotaExhausted("daily allowance already spent")
            if self.remaining(task) <= 0:
                raise BudgetSpent(f"{task}: request budget spent")
            self.calls += 1
            self.task_calls[task] += 1

    def problem(self) -> str | None:
        """What went wrong this run, if it needs a person to look."""
        if self.quota_exhausted:
            skipped = ", ".join(f"{n} {task}" for task, n in self.skipped.items() if n)
            return (
                f"The daily Workers AI allowance ran out after {self.calls} requests; "
                f"the rest of tonight's LLM work was skipped ({skipped or 'nothing'} requests)."
            )
        failing = [
            f"{self.failed[task]} of {sent} {task} requests failed"
            for task in self.asked
            if (sent := self.asked[task] - self.skipped[task])
            and self.failed[task] >= 2
            and self.failed[task] > FAILED_SHARE * sent
        ]
        return "; ".join(failing) + "." if failing else None


def _check_shape(value: Any, schema: dict[str, Any]) -> None:
    """The answer's top level, as far as callers rely on it: an object with its
    required keys, lists where the schema has arrays."""
    if schema.get("type") != "object":
        return
    if not isinstance(value, dict):
        raise LLMError(f"expected a JSON object, got: {str(value)[:200]}")
    for key in schema.get("required", []):
        wanted = (schema.get("properties") or {}).get(key, {}).get("type")
        if key not in value or (wanted == "array" and not isinstance(value[key], list)):
            raise LLMError(f"answer lacks {key!r}: {str(value)[:200]}")


class WorkersAI(Client):
    """Workers AI over its REST API. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."""

    name = "workers-ai"

    def __init__(
        self,
        account_id: str,
        token: str,
        timeout: float = 90.0,
        max_calls: int | None = None,
        task_max_calls: Mapping[str, int] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        http: httpx.Client | None = None,
    ) -> None:
        super().__init__(max_calls, task_max_calls)
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/"
        self.http = http or httpx.Client(
            headers={"Authorization": f"Bearer {token}"}, timeout=timeout
        )
        self.sleep = sleep

    @classmethod
    def from_env(cls, **kwargs: Any) -> WorkersAI:
        names = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")
        account, token = (os.environ.get(n) or None for n in names)
        if not account or not token:
            missing = [n for n, v in zip(names, (account, token), strict=True) if not v]
            raise LLMError(f"{', '.join(missing)} not set (see .env)")
        return cls(account, token, **kwargs)

    def _json(self, task, system, user, schema):
        model = MODELS[task]
        if task in NO_THINK and "qwen3" in model:
            system += "\n/no_think"
        body = {
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": schema},
            "temperature": 0.1,
            "max_tokens": 4096,
        }
        for attempt in range(ATTEMPTS):
            self._spend(task)
            try:
                r = self.http.post(self.base + model, json=body)
            except httpx.TransportError as exc:
                error = str(exc)
            else:
                if r.status_code == 200:
                    return _parse(r.json().get("result"))
                error = f"{r.status_code}: {r.text[:300]}"
                if _DAILY_QUOTA.search(r.text):
                    self.quota_exhausted = True  # retrying won't help before tomorrow
                    raise QuotaExhausted(f"{model}: {error}")
                if r.status_code < 500 and r.status_code != 429:
                    break
            if attempt < ATTEMPTS - 1:
                self.sleep(2 * (attempt + 1))
        raise LLMError(f"{model}: {error}")


def _parse(result: Any) -> Any:
    """Workers AI returns {"response": …} (already parsed or as text), or for newer
    models an OpenAI-style {"choices": [{"message": {"content": …}}]}."""
    if isinstance(result, dict) and "response" in result:
        value = result["response"]
    elif isinstance(result, dict) and result.get("choices"):
        value = result["choices"][0]["message"]["content"]
    else:
        raise LLMError(f"unexpected response shape: {str(result)[:200]}")
    if isinstance(value, str):
        text = _THINK.sub("", value).strip()
        text = re.sub(r"^```(?:json)?|```$", "", text).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError(f"not JSON: {text[:200]}") from exc
    return value


class FakeLLM(Client):
    """Answers from local rules instead of a model: for offline runs and tests."""

    def __init__(
        self,
        answer: Callable[[str, str], Any],
        max_calls: int | None = None,
        task_max_calls: Mapping[str, int] | None = None,
    ) -> None:
        super().__init__(max_calls, task_max_calls)
        self.answer = answer
        self.name = "fake"

    def _json(self, task, system, user, schema):
        self._spend(task)
        return self.answer(task, user)


# --- cached answers ------------------------------------------------------------------


def answer_models(task: str, llm: LLM | None) -> list[str]:
    """Whose cached answers count for `task`: the current model's, then previous
    models'. Without a real model it's the fake's own, which never mix with real ones."""
    if llm is None or llm.name == "fake":
        return ["fake"]
    return [MODELS[task], *PREVIOUS_MODELS.get(task, ())]


def cached_answer(
    cache: Cache, task: str, llm: LLM | None, version: int, item: Any
) -> tuple[Any, str] | None:
    """(the cached raw answer about `item`, the model that gave it), or None."""
    for model in answer_models(task, llm):
        value = cache.get(task, key_for(version, model, item))
        if value is not None:
            return value, model
    return None


def store_answer(
    cache: Cache, task: str, llm: LLM | None, version: int, item: Any, value: Any
) -> None:
    cache.put(task, key_for(version, answer_models(task, llm)[0], item), value)
