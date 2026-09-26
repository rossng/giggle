"""LLM access for the build: Cloudflare Workers AI, or a fake for offline runs and tests.

Each task names its model in MODELS, so moving a task to a cheaper or better model is
a one-line change. Responses are requested as JSON matching a schema; the caller
validates them and falls back to rules when a model can't comply.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable
from typing import Any, Protocol

import httpx

MODELS = {
    "lineup": "@cf/qwen/qwen3-30b-a3b-fp8",
}

_THINK = re.compile(r"<think>.*?</think>", re.S)


class LLMError(Exception):
    pass


class LLM(Protocol):
    name: str

    def json(self, task: str, system: str, user: str, schema: dict[str, Any]) -> Any:
        """Ask for a JSON value matching `schema`. Raises LLMError on failure."""
        ...


class WorkersAI:
    """Workers AI over its REST API. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."""

    def __init__(self, account_id: str, token: str, timeout: float = 90.0) -> None:
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/"
        self.http = httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=timeout)
        self.name = "workers-ai"
        self.calls = 0

    @classmethod
    def from_env(cls) -> WorkersAI:
        names = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")
        account, token = (os.environ.get(n) or None for n in names)
        if not account or not token:
            missing = [n for n, v in zip(names, (account, token), strict=True) if not v]
            raise LLMError(f"{', '.join(missing)} not set (see .env)")
        return cls(account, token)

    def json(self, task, system, user, schema):
        model = MODELS[task]
        body = {
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": schema},
            "temperature": 0.1,
            "max_tokens": 4096,
        }
        for attempt in range(3):
            self.calls += 1
            try:
                r = self.http.post(self.base + model, json=body)
            except httpx.TransportError as exc:
                error = str(exc)
            else:
                if r.status_code == 200:
                    return _parse(r.json().get("result"))
                error = f"{r.status_code}: {r.text[:300]}"
                if r.status_code < 500 and r.status_code != 429:
                    break
            time.sleep(2 * (attempt + 1))
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


class FakeLLM:
    """Answers from local rules instead of a model: for offline runs and tests."""

    def __init__(self, answer: Callable[[str, str], Any]) -> None:
        self.answer = answer
        self.name = "fake"
        self.calls = 0

    def json(self, task, system, user, schema):
        self.calls += 1
        return self.answer(task, user)
