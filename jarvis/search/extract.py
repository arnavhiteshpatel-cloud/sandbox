"""Text extraction for indexing and the read_file tool."""
from __future__ import annotations

import os
import sys

KINDS = {
    "pdf": {".pdf"},
    "document": {".docx", ".doc", ".rtf", ".pages", ".odt", ".md", ".txt"},
    "presentation": {".pptx", ".key", ".odp"},
    "spreadsheet": {".xlsx", ".xls", ".csv", ".numbers", ".ods", ".tsv"},
    "image": {".png", ".jpg", ".jpeg", ".heic", ".gif", ".tiff", ".webp"},
    "code": {".py", ".js", ".ts", ".tsx", ".jsx", ".swift", ".java", ".c", ".cpp", ".h", ".rs", ".go", ".rb", ".sh",
             ".html", ".css", ".json", ".yaml", ".yml", ".toml", ".sql", ".ipynb", ".r", ".m", ".kt"},
    "text": {".txt", ".md", ".rst", ".log", ".tex", ".bib"},
}
INDEXABLE = set().union(*KINDS.values())


def kind_of(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    for k in ("pdf", "presentation", "spreadsheet", "image", "code", "document", "text"):
        if ext in KINDS[k]:
            return k
    return "other"


def extract_text(path: str, max_chars: int = 200_000, ocr_images: bool = True) -> str:
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".pdf":
            from pypdf import PdfReader

            r = PdfReader(path)
            out, n = [], 0
            for page in r.pages:
                t = page.extract_text() or ""
                out.append(t)
                n += len(t)
                if n > max_chars:
                    break
            text = "\n".join(out)
            if not text.strip() and sys.platform == "darwin" and ocr_images:
                text = _mac_pdf_text(path)
            return text[:max_chars]
        if ext == ".docx":
            import docx

            d = docx.Document(path)
            parts = [p.text for p in d.paragraphs]
            for tbl in d.tables:
                for row in tbl.rows:
                    parts.append(" | ".join(c.text for c in row.cells))
            return "\n".join(parts)[:max_chars]
        if ext == ".pptx":
            from pptx import Presentation

            prs = Presentation(path)
            parts = []
            for i, slide in enumerate(prs.slides, 1):
                parts.append(f"[Slide {i}]")
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        parts.append(shape.text_frame.text)
                if slide.has_notes_slide:
                    parts.append("Notes: " + slide.notes_slide.notes_text_frame.text)
            return "\n".join(parts)[:max_chars]
        if ext in (".xlsx",):
            import openpyxl

            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
            parts, n = [], 0
            for ws in wb.worksheets:
                parts.append(f"[Sheet {ws.title}]")
                for row in ws.iter_rows(values_only=True):
                    line = " | ".join("" if v is None else str(v) for v in row).strip(" |")
                    if line:
                        parts.append(line)
                        n += len(line)
                    if n > max_chars:
                        break
            return "\n".join(parts)[:max_chars]
        if ext == ".ipynb":
            import json

            nb = json.load(open(path, encoding="utf-8", errors="replace"))
            return "\n".join("".join(c.get("source", "")) for c in nb.get("cells", []))[:max_chars]
        if ext in KINDS["image"]:
            if ocr_images and sys.platform == "darwin":
                from ..platform.macos.screen import ocr_image_file

                return "\n".join(i["text"] for i in ocr_image_file(path))[:max_chars]
            return ""
        if ext in (".doc", ".rtf", ".pages", ".key", ".numbers", ".odt") and sys.platform == "darwin":
            return _mac_textutil(path)[:max_chars]
        if ext in INDEXABLE:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read(max_chars)
    except Exception as e:  # extraction failures should never break indexing
        return f"[could not extract text: {type(e).__name__}]"
    return ""


def _mac_textutil(path: str) -> str:
    import subprocess

    p = subprocess.run(["textutil", "-convert", "txt", "-stdout", path], capture_output=True, text=True, timeout=30)
    if p.returncode == 0:
        return p.stdout
    p = subprocess.run(["mdls", "-raw", "-name", "kMDItemTextContent", path], capture_output=True, text=True, timeout=10)
    return p.stdout if p.returncode == 0 and p.stdout.strip() != "(null)" else ""


def _mac_pdf_text(path: str) -> str:
    try:
        from Foundation import NSURL  # type: ignore
        from Quartz import PDFDocument  # type: ignore

        doc = PDFDocument.alloc().initWithURL_(NSURL.fileURLWithPath_(path))
        return str(doc.string() or "") if doc else ""
    except Exception:
        return ""


def chunk(text: str, size: int = 1200, overlap: int = 150) -> list[str]:
    text = " ".join(text.split())
    if not text:
        return []
    out, i = [], 0
    while i < len(text):
        end = min(len(text), i + size)
        if end < len(text):
            sp = text.rfind(" ", i + size - 200, end)
            if sp > i:
                end = sp
        out.append(text[i:end])
        if end >= len(text):
            break
        i = max(end - overlap, i + 1)
    return out
