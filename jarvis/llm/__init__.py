"""Local LLM providers behind one interface.

Internal message format is OpenAI-style:
  {"role": "system|user|assistant|tool", "content": str, "images": [b64...]?,
   "tool_calls": [{"id", "name", "arguments": dict}]?, "tool_call_id": str?, "name": str?}
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import aiohttp


@dataclass
class ToolCall:
    name: str
    arguments: dict
    id: str = field(default_factory=lambda: "call_" + uuid.uuid4().hex[:10])


@dataclass
class ChatResult:
    content: str
    tool_calls: list[ToolCall]
    ms: int
    model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    thinking: str = ""
    raw: str | None = None   # exact generated text when tool calls were parsed from it (cache-friendly replay)


class LLMError(Exception):
    pass


INLINE_CALL = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|$)", re.S)
XML_FUNC = re.compile(r"<function=([\w.-]+)>(.*?)(?:</function>|$)", re.S)
XML_PARAM = re.compile(r"<parameter=([\w.-]+)>\s*(.*?)\s*</parameter>", re.S)


def _param_value(v: str):
    v = v.strip()
    if v[:1] in "[{" or v in ("true", "false", "null") or re.fullmatch(r"-?\d+(\.\d+)?", v):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            pass
    return v


def _parse_inline_calls(content: str) -> tuple[str, list[ToolCall]]:
    """Recover tool calls that a runtime left in the text instead of parsing them.

    Handles both Qwen formats: JSON  <tool_call>{"name":..,"arguments":{..}}</tool_call>
    and XML  <tool_call><function=open_app><parameter=name>Spotify</parameter></function></tool_call>.
    """
    calls: list[ToolCall] = []
    text = content or ""
    for m in INLINE_CALL.finditer(text):
        body = m.group(1).strip()
        if body.startswith("{"):
            try:
                obj = json.loads(body)
                calls.append(ToolCall(obj.get("name", ""), _coerce_args(obj.get("arguments") or obj.get("parameters") or {})))
                continue
            except json.JSONDecodeError:
                pass
        for f in XML_FUNC.finditer(body):
            args = {p.group(1): _param_value(p.group(2)) for p in XML_PARAM.finditer(f.group(2))}
            calls.append(ToolCall(f.group(1), args))
    if not calls:  # bare <function=...> without the <tool_call> wrapper
        for f in XML_FUNC.finditer(text):
            args = {p.group(1): _param_value(p.group(2)) for p in XML_PARAM.finditer(f.group(2))}
            calls.append(ToolCall(f.group(1), args))
    if calls:
        text = INLINE_CALL.sub("", text)
        text = XML_FUNC.sub("", text).strip()
    return text, calls


def _strip_think(content: str) -> tuple[str, str]:
    m = re.search(r"<think>(.*?)</think>", content or "", re.S)
    if m:
        return (content[: m.start()] + content[m.end():]).strip(), m.group(1).strip()
    i = (content or "").find("<think>")
    if i >= 0:   # cut off mid-thought (length limit): none of it is the answer, and it must never be spoken
        return content[:i].strip(), content[i + 7:].strip()
    return content, ""


def _coerce_args(a: Any) -> dict:
    if isinstance(a, dict):
        return a
    if isinstance(a, str):
        try:
            v = json.loads(a) if a.strip() else {}
            return v if isinstance(v, dict) else {"value": v}
        except json.JSONDecodeError:
            return {"_raw": a}
    return {}


class LLMClient:
    def __init__(self, base_url: str, timeout_s: float = 180):
        self.base_url = base_url.rstrip("/")
        self.timeout = aiohttp.ClientTimeout(total=timeout_s, connect=5)
        self._session: aiohttp.ClientSession | None = None

    async def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self.timeout)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def _post(self, path: str, payload: dict, headers: dict | None = None) -> dict:
        s = await self.session()
        try:
            async with s.post(self.base_url + path, json=payload, headers=headers or {}) as r:
                text = await r.text()
                if r.status >= 400:
                    raise LLMError(f"{r.status} from {path}: {text[:400]}")
                return json.loads(text) if text else {}
        except aiohttp.ClientConnectorError as e:
            raise LLMError(f"The local AI runtime isn't reachable at {self.base_url}. Is it running?") from e
        except aiohttp.ClientError as e:
            raise LLMError(f"The local AI runtime dropped the connection ({type(e).__name__}).") from e
        except asyncio.TimeoutError as e:
            raise LLMError("The local AI model took too long to answer.") from e

    async def _get(self, path: str) -> dict:
        s = await self.session()
        try:
            async with s.get(self.base_url + path) as r:
                return await r.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            raise LLMError(f"The local AI runtime isn't reachable at {self.base_url}.") from e

    # interface
    async def chat(self, messages: list[dict], model: str, tools: list[dict] | None = None, *, temperature: float = 0.2,
                   num_ctx: int = 16384, think: bool = False, keep_alive: str | int | None = None,
                   max_tokens: int = 1024, json_mode: bool = False) -> ChatResult:
        raise NotImplementedError

    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        raise NotImplementedError

    async def available(self) -> bool:
        raise NotImplementedError

    async def list_models(self) -> list[dict]:
        return []

    async def loaded_models(self) -> list[dict]:
        return []

    async def warm(self, model: str, keep_alive: str | int) -> None:
        return None

    async def unload(self, model: str) -> None:
        return None


class OllamaClient(LLMClient):
    """Ollama (https://ollama.com): free, MIT-licensed, manages model downloads and load/unload."""

    def _to_ollama(self, messages: list[dict]) -> list[dict]:
        out = []
        for m in messages:
            om = {"role": m["role"], "content": m.get("content") or ""}
            if m.get("images"):
                om["images"] = m["images"]
            if m.get("tool_calls"):
                om["tool_calls"] = [{"function": {"name": tc["name"], "arguments": tc["arguments"]}} for tc in m["tool_calls"]]
            if m["role"] == "tool":
                om["tool_name"] = m.get("name", "")
            out.append(om)
        return out

    async def chat(self, messages, model, tools=None, *, temperature=0.2, num_ctx=16384, think=False,
                   keep_alive=None, max_tokens=1024, json_mode=False):
        payload: dict[str, Any] = {
            "model": model, "messages": self._to_ollama(messages), "stream": False,
            "options": {"temperature": temperature, "num_ctx": num_ctx, "num_predict": max_tokens},
            "think": bool(think),
        }
        if tools:
            payload["tools"] = tools
        if keep_alive is not None:
            payload["keep_alive"] = keep_alive
        if json_mode:
            payload["format"] = "json"
        t0 = time.monotonic()
        try:
            data = await self._post("/api/chat", payload)
        except LLMError as e:
            if "does not support thinking" in str(e) or "think" in str(e).lower() and "support" in str(e).lower():
                payload.pop("think", None)
                data = await self._post("/api/chat", payload)
            else:
                raise
        msg = data.get("message", {})
        content, thinking = _strip_think(msg.get("content", ""))
        calls = [ToolCall(tc["function"]["name"], _coerce_args(tc["function"].get("arguments"))) for tc in msg.get("tool_calls") or []]
        if not calls:
            content, calls = _parse_inline_calls(content)
        return ChatResult(content, calls, int((time.monotonic() - t0) * 1000), model,
                          data.get("prompt_eval_count"), data.get("eval_count"), msg.get("thinking") or thinking)

    async def embed(self, texts, model):
        data = await self._post("/api/embed", {"model": model, "input": texts, "keep_alive": "2m"})
        return data.get("embeddings", [])

    async def available(self):
        try:
            await self._get("/api/version")
            return True
        except LLMError:
            return False

    async def list_models(self):
        return (await self._get("/api/tags")).get("models", [])

    async def loaded_models(self):
        return (await self._get("/api/ps")).get("models", [])

    async def warm(self, model, keep_alive):
        await self._post("/api/generate", {"model": model, "keep_alive": keep_alive})

    async def unload(self, model):
        try:
            await self._post("/api/generate", {"model": model, "keep_alive": 0})
        except LLMError:
            pass


class OpenAICompatClient(LLMClient):
    """Any OpenAI-compatible local server: mlx_lm.server, llama.cpp llama-server, LM Studio, vLLM."""

    def __init__(self, base_url: str, timeout_s: float = 180, api_key: str = ""):
        super().__init__(base_url, timeout_s)
        self.api_key = api_key

    def _headers(self):
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    def _to_openai(self, messages):
        out = []
        for m in messages:
            om: dict[str, Any] = {"role": m["role"]}
            if m.get("images"):
                om["content"] = [{"type": "text", "text": m.get("content") or ""}] + [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}} for b in m["images"]]
            else:
                om["content"] = m.get("content") or ""
            if m.get("tool_calls"):
                om["tool_calls"] = [{"id": tc["id"], "type": "function",
                                     "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])}}
                                    for tc in m["tool_calls"]]
            if m["role"] == "tool":
                om["tool_call_id"] = m.get("tool_call_id", "")
            out.append(om)
        return out

    async def chat(self, messages, model, tools=None, *, temperature=0.2, num_ctx=16384, think=False,
                   keep_alive=None, max_tokens=1024, json_mode=False):
        payload: dict[str, Any] = {"model": model, "messages": self._to_openai(messages), "temperature": temperature,
                                   "max_tokens": max_tokens, "stream": False}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        # Qwen-family templates honour this flag on llama.cpp / vLLM / mlx servers.
        payload["chat_template_kwargs"] = {"enable_thinking": bool(think)}
        t0 = time.monotonic()
        data = await self._post("/v1/chat/completions", payload, self._headers())
        choice = (data.get("choices") or [{}])[0].get("message", {})
        raw_text = choice.get("content") or ""
        content, thinking = _strip_think(raw_text)
        calls = [ToolCall(tc["function"]["name"], _coerce_args(tc["function"].get("arguments")), tc.get("id") or "call_" + uuid.uuid4().hex[:10])
                 for tc in choice.get("tool_calls") or []]
        raw = None
        if not calls:
            content, calls = _parse_inline_calls(content)
            if calls:
                raw = raw_text
        usage = data.get("usage") or {}
        return ChatResult(content, calls, int((time.monotonic() - t0) * 1000), model,
                          usage.get("prompt_tokens"), usage.get("completion_tokens"), choice.get("reasoning_content") or thinking, raw)

    async def embed(self, texts, model):
        data = await self._post("/v1/embeddings", {"model": model, "input": texts}, self._headers())
        return [d["embedding"] for d in data.get("data", [])]

    async def available(self):
        try:
            await self._get("/v1/models")
            return True
        except LLMError:
            return False

    async def list_models(self):
        return (await self._get("/v1/models")).get("data", [])


def make_client(settings) -> LLMClient:
    provider = settings.get("llm.provider", "ollama")
    url = settings.get("llm.base_url")
    timeout = settings.get("llm.request_timeout_s", 180)
    if provider == "ollama":
        return OllamaClient(url, timeout)
    key = settings.get("llm.api_key", "")
    if not key:
        try:
            from .. import secrets

            key = secrets.get("llm_api_key") or ""
        except Exception:
            key = ""
    return OpenAICompatClient(url, timeout, key)
