"""JARVIS command line.

  jarvis serve [--no-voice]        run the assistant (the app does this for you)
  jarvis ask "open spotify"        send a command to the running assistant
  jarvis run "open spotify"        process one command in-process (no daemon needed)
  jarvis doctor                    verify hardware, OS, permissions, models
  jarvis bench [--models a,b]      benchmark local models on real JARVIS tasks
  jarvis index [--max-seconds N]   index authorized folders now
  jarvis setup-models              download wake word, voice and speech models
  jarvis shortcuts export|import FILE
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import logging.handlers
import os
import platform
import subprocess
import sys

from . import paths


def setup_logging(verbose: bool = False) -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    fh = logging.handlers.RotatingFileHandler(paths.logs_dir() / "jarvis.log", maxBytes=5_000_000, backupCount=3)
    fh.setFormatter(fmt)
    root.addHandler(fh)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    sh.setLevel(logging.INFO if verbose else logging.WARNING)
    root.addHandler(sh)


def cmd_serve(args) -> None:
    from .assistant import Assistant
    from .config import Settings
    from .server import serve

    s = Settings()
    asyncio.run(serve(Assistant(s), s.get("server.host"), args.port or s.get("server.port"), voice=not args.no_voice))


def _api(method: str, path: str, payload: dict | None = None):
    import urllib.request

    from .config import Settings
    from .server import load_token

    s = Settings()
    url = f"http://127.0.0.1:{s.get('server.port')}{path}"
    req = urllib.request.Request(url, method=method, data=json.dumps(payload or {}).encode() if payload is not None else None,
                                 headers={"X-Jarvis-Token": load_token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read() or b"{}")


def cmd_ask(args) -> None:
    print(json.dumps(_api("POST", "/api/command", {"text": " ".join(args.text), "wait": True}), indent=2))


def cmd_run(args) -> None:
    from .assistant import Assistant

    async def go():
        a = Assistant()
        await a.start(voice=False)
        res = await a.handle_text(" ".join(args.text))
        await a.shutdown()
        return res

    print(json.dumps(asyncio.run(go()), indent=2, default=str))


def _sh(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception as e:
        return f"(unavailable: {e})"


def cmd_doctor(args) -> None:
    out: dict = {"python": sys.version.split()[0], "platform": sys.platform, "machine": platform.machine()}
    if sys.platform == "darwin":
        out["macos"] = _sh(["sw_vers", "-productVersion"])
        out["build"] = _sh(["sw_vers", "-buildVersion"])
        out["chip"] = _sh(["sysctl", "-n", "machdep.cpu.brand_string"])
        out["memory_gb"] = round(int(_sh(["sysctl", "-n", "hw.memsize"]) or 0) / 2**30, 1)
        out["cpu_cores"] = {"performance": _sh(["sysctl", "-n", "hw.perflevel0.physicalcpu"]),
                            "efficiency": _sh(["sysctl", "-n", "hw.perflevel1.physicalcpu"])}
        hw = _sh(["system_profiler", "SPHardwareDataType"])
        out["model"] = next((l.split(":", 1)[1].strip() for l in hw.splitlines() if "Model Name" in l or "Model Identifier" in l), "?")
        bat = _sh(["system_profiler", "SPPowerDataType"])
        out["battery"] = {k: next((l.split(":", 1)[1].strip() for l in bat.splitlines() if k in l), None)
                          for k in ("Cycle Count", "Condition", "Maximum Capacity", "Full Charge Capacity")}
        out["power_now"] = _sh(["pmset", "-g", "batt"]).splitlines()[:2]
        out["arc_installed"] = os.path.isdir("/Applications/Arc.app")
        out["ollama_app"] = os.path.isdir("/Applications/Ollama.app")
        from .platform.macos import MacComputer

        out["permissions"] = MacComputer().permissions()
        expect = {"chip": "M4 Pro", "memory_gb": 24.0}
        out["matches_user_spec"] = {"chip": expect["chip"] in out["chip"], "memory": abs(out["memory_gb"] - 24.0) < 1,
                                    "macos_15": out["macos"].startswith("15.")}
    from importlib.util import find_spec

    out["python_packages"] = {m: bool(find_spec(m)) for m in
                              ("aiohttp", "numpy", "rapidfuzz", "sounddevice", "openwakeword", "onnxruntime", "mlx_whisper",
                               "faster_whisper", "kokoro_onnx", "pypdf", "docx", "pptx", "openpyxl", "objc", "Quartz", "Vision")}
    try:
        import sounddevice as sd

        out["audio_devices"] = {"default_input": str(sd.query_devices(kind="input")["name"]),
                                "default_output": str(sd.query_devices(kind="output")["name"])}
    except Exception as e:
        out["audio_devices"] = f"unavailable: {e}"
    from .config import Settings
    from .llm import make_client

    s = Settings()

    async def llm_check():
        c = make_client(s)
        try:
            ok = await c.available()
            models = [m.get("name") or m.get("id") for m in (await c.list_models())] if ok else []
            return {"reachable": ok, "installed_models": models, "configured": s.get("llm.models")}
        finally:
            await c.close()

    out["llm"] = asyncio.run(llm_check())
    from .voice.tts import TTS

    out["kokoro_ready"] = TTS.kokoro_available()
    out["data_dir"] = str(paths.data_dir())
    out["claude_or_anthropic_dependency"] = "none (JARVIS never contacts Anthropic or any paid AI service)"
    print(json.dumps(out, indent=2, default=str))


def cmd_index(args) -> None:
    from .assistant import Assistant
    from .config import Settings
    from .db import Database
    from .llm import make_client
    from .search.indexer import Indexer

    s = Settings()
    db = Database()
    client = make_client(s)

    def embed(texts):
        async def go():
            return await client.embed(texts, s.get("llm.embed_model"))
        return asyncio.run(go())

    stats = Indexer(db, s, embed=embed if s.get("search.semantic", True) else None).run(max_seconds=args.max_seconds)
    print(json.dumps(stats.__dict__, indent=2))


def cmd_setup_models(args) -> None:
    from .setup_models import main as setup_main

    setup_main(args)


def cmd_bench(args) -> None:
    from .bench import main as bench_main

    bench_main(args)


def cmd_shortcuts(args) -> None:
    from .db import Database
    from .shortcuts import ShortcutStore

    store = ShortcutStore(Database())
    if args.action == "export":
        data = json.dumps(store.export(), indent=2)
        if args.file:
            open(args.file, "w").write(data)
        else:
            print(data)
    elif args.action == "import":
        print(json.dumps(store.import_(json.load(open(args.file))), indent=2))
    else:
        for sc in store.list():
            print(f"{sc['id']:30} {sc['name']:30} triggers={sc['triggers']}")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="jarvis", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd")
    sp = sub.add_parser("serve"); sp.add_argument("--no-voice", action="store_true"); sp.add_argument("--port", type=int); sp.set_defaults(fn=cmd_serve)
    sp = sub.add_parser("ask"); sp.add_argument("text", nargs="+"); sp.set_defaults(fn=cmd_ask)
    sp = sub.add_parser("run"); sp.add_argument("text", nargs="+"); sp.set_defaults(fn=cmd_run)
    sp = sub.add_parser("doctor"); sp.set_defaults(fn=cmd_doctor)
    sp = sub.add_parser("index"); sp.add_argument("--max-seconds", type=float, default=None); sp.set_defaults(fn=cmd_index)
    sp = sub.add_parser("setup-models"); sp.add_argument("--skip-llm", action="store_true"); sp.add_argument("--mode", default="all"); sp.set_defaults(fn=cmd_setup_models)
    sp = sub.add_parser("bench")
    sp.add_argument("--models", default=None, help="comma-separated model names")
    sp.add_argument("--base-url", default=None); sp.add_argument("--provider", default=None)
    sp.add_argument("--repeat", type=int, default=2); sp.add_argument("--out", default=None)
    sp.add_argument("--only", default=None, help="comma-separated case ids")
    sp.set_defaults(fn=cmd_bench)
    sp = sub.add_parser("shortcuts"); sp.add_argument("action", choices=["list", "export", "import"]); sp.add_argument("file", nargs="?"); sp.set_defaults(fn=cmd_shortcuts)
    args = p.parse_args(argv)
    if not getattr(args, "fn", None):
        args = p.parse_args(["serve"])
    setup_logging(args.verbose)
    args.fn(args)


if __name__ == "__main__":
    main()
