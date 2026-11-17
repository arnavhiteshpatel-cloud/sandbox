import os
import tempfile

import pytest

os.environ.setdefault("JARVIS_PLATFORM", "fake")


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_HOME", str(tmp_path / "jarvis"))
    return tmp_path


@pytest.fixture()
def settings(home):
    from jarvis.config import Settings

    s = Settings()
    s.set("voice.enabled", False)
    s.set("power.auto_switch", False)
    return s


@pytest.fixture()
def db(home):
    from jarvis.db import Database

    return Database()


class ScriptedLLM:
    """Replays a fixed list of responses. Used to test the agent loop's control logic only."""

    def __init__(self, script):
        from jarvis.llm import ChatResult, ToolCall

        self.ChatResult, self.ToolCall = ChatResult, ToolCall
        self.script = list(script)
        self.calls = []

    async def chat(self, messages, model, tools=None, **kw):
        self.calls.append(messages[-1])
        item = self.script.pop(0) if self.script else ("text", "Done.")
        kind, payload = item
        if kind == "text":
            return self.ChatResult(payload, [], 5, model)
        calls = [self.ToolCall(n, a) for n, a in payload]
        return self.ChatResult("", calls, 5, model)

    async def available(self):
        return True

    async def warm(self, *a, **k):
        pass

    async def embed(self, texts, model):
        raise RuntimeError("no embeddings in tests")

    async def close(self):
        pass

    async def list_models(self):
        return []

    async def loaded_models(self):
        return []


@pytest.fixture()
def scripted():
    return ScriptedLLM


@pytest.fixture()
def assistant(settings, db):
    from jarvis.assistant import Assistant
    from jarvis.platform.fake import FakeComputer

    a = Assistant(settings=settings, db=db, computer=FakeComputer())
    return a
