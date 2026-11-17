"""Screenshots (screencapture) and on-device OCR (Apple Vision). Nothing is kept on disk."""
from __future__ import annotations

import os
import subprocess
import tempfile


def screenshot(max_dim: int = 1280) -> bytes:
    fd, path = tempfile.mkstemp(suffix=".png", prefix="jarvis-")
    os.close(fd)
    try:
        proc = subprocess.run(["screencapture", "-x", "-t", "png", path], capture_output=True, timeout=10)
        if proc.returncode != 0 or os.path.getsize(path) == 0:
            raise RuntimeError("Screen capture failed. Allow JARVIS under Privacy & Security > Screen & System Audio Recording.")
        if max_dim:
            subprocess.run(["sips", "-Z", str(max_dim), path], capture_output=True, timeout=10)
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _screen_points() -> tuple[float, float]:
    from AppKit import NSScreen  # type: ignore

    f = NSScreen.mainScreen().frame()
    return f.size.width, f.size.height


def ocr_image_file(path: str, fast: bool = False) -> list[dict]:
    """Recognize text; returns boxes normalized to 0..1 with top-left origin."""
    import Vision  # type: ignore
    from Foundation import NSURL  # type: ignore

    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(path), {})
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelFast if fast else Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(True)
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError(f"Vision OCR failed: {err}")
    out = []
    for obs in req.results() or []:
        cands = obs.topCandidates_(1)
        if not cands:
            continue
        bb = obs.boundingBox()
        out.append({
            "text": str(cands[0].string()), "conf": float(cands[0].confidence()),
            "x": bb.origin.x, "y": 1.0 - bb.origin.y - bb.size.height, "w": bb.size.width, "h": bb.size.height,
        })
    return out


def ocr_screen() -> list[dict]:
    """OCR the main display; boxes converted to global screen points (clickable)."""
    fd, path = tempfile.mkstemp(suffix=".png", prefix="jarvis-ocr-")
    os.close(fd)
    try:
        subprocess.run(["screencapture", "-x", "-t", "png", path], capture_output=True, timeout=10, check=True)
        items = ocr_image_file(path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    W, H = _screen_points()
    for it in items:
        it["x"], it["y"], it["w"], it["h"] = (round(it["x"] * W), round(it["y"] * H), round(it["w"] * W), round(it["h"] * H))
        it["center"] = [it["x"] + it["w"] // 2, it["y"] + it["h"] // 2]
    return items
