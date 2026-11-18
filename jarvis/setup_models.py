"""Download every model JARVIS needs, once. After this, JARVIS runs fully offline.

  jarvis setup-models            all models for all power modes
  jarvis setup-models --skip-llm voice/speech only (no Ollama pulls)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.request

from . import paths
from .config import Settings

KOKORO_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = ["kokoro-v1.0.int8.onnx", "voices-v1.0.bin"]


def _download(url: str, dest: str) -> None:
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"  ✓ {os.path.basename(dest)} (already present)")
        return
    tmp = dest + ".part"
    print(f"  ↓ {url}")
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r    {done / 2**20:7.1f} / {total / 2**20:.1f} MB", end="", flush=True)
    print()
    os.replace(tmp, dest)


def wake_word() -> None:
    print("Wake word (openWakeWord 'hey_jarvis'):")
    from .voice.wakeword import WakeWord

    w = WakeWord("hey_jarvis")
    w.load()  # bundled with openwakeword 0.4.x; verifies the model actually loads
    print(f"  ✓ {w.model_path()}")


def kokoro() -> None:
    print("Voice (Kokoro-82M, int8):")
    d = paths.models_dir() / "kokoro"
    d.mkdir(parents=True, exist_ok=True)
    for f in KOKORO_FILES:
        _download(KOKORO_BASE + f, str(d / f))


def whisper(sizes=("turbo", "small")) -> None:
    from .voice.stt import STT

    print("Speech recognition (Whisper):")
    for size in sizes:
        stt = STT("auto", size)
        stt.load()
        print(f"  ✓ {stt.backend}/{size}")
        stt.unload()


def ollama_pull(models: list[str], base_url: str) -> None:
    print("Local language models (Ollama):")
    try:
        urllib.request.urlopen(base_url.rstrip("/") + "/api/version", timeout=5).read()
    except Exception:
        raise SystemExit("  ✗ Ollama isn't running. Open the Ollama app (Applications), then run this again:\n"
                         "    /Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis setup-models")
    for m in models:
        print(f"  ↓ {m}")
        req = urllib.request.Request(base_url.rstrip("/") + "/api/pull", data=json.dumps({"model": m}).encode(),
                                     headers={"Content-Type": "application/json"})
        last = ""
        with urllib.request.urlopen(req, timeout=3600) as r:
            for line in r:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("error"):
                    raise SystemExit(f"    ✗ {ev['error']}")
                st = ev.get("status", "")
                if ev.get("total"):
                    print(f"\r    {st} {ev.get('completed', 0) / 2**30:.2f}/{ev['total'] / 2**30:.2f} GB", end="", flush=True)
                elif st != last:
                    print(f"\r    {st}" + " " * 30, end="", flush=True)
                last = st
        print(f"\n  ✓ {m}")


def main(args) -> None:
    s = Settings()
    wake_word()
    kokoro()
    try:
        whisper()
    except Exception as e:
        print(f"  ! Whisper prefetch failed ({e}); it will download on first use.")
    if not getattr(args, "skip_llm", False):
        if s.get("llm.provider") != "ollama":
            print("LLM provider is not Ollama; download your model with your runtime's tools.")
        else:
            models = sorted(set(s.get("llm.models").values()) | {s.get("llm.embed_model")})
            ollama_pull(models, s.get("llm.base_url"))
    print("\nAll models are installed. JARVIS can now run offline.")


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--skip-llm", action="store_true")
    main(p.parse_args())
    sys.exit(0)
