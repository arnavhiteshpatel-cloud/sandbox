"""Background internet lookups: search and read pages without touching the screen or your browser.

Free providers, no accounts or API keys, tried in order until one returns results:
DuckDuckGo (HTML, then Lite) → Bing → Wikipedia. Requests carry no cookies or personal data; only the
query text (or page URL) leaves the Mac, and only when you ask for a lookup.
"""
from __future__ import annotations

import asyncio
import base64
import html as htmllib
import io
import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

import aiohttp

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
WIKI_UA = "JARVIS-personal-assistant/0.2 (local, personal use)"
TIMEOUT = aiohttp.ClientTimeout(total=15, connect=6)


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", "", s or ""))).strip()


def parse_ddg_html(page: str) -> list[dict]:
    out = []
    for m in re.finditer(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]*class="result__a"|$)', page, re.S):
        url, title, rest = m.group(1), _clean(m.group(2)), m.group(3)
        if "duckduckgo.com/l/?" in url:
            url = unquote(parse_qs(urlparse(htmllib.unescape(url)).query).get("uddg", [url])[0])
        if "duckduckgo.com/y.js" in url or not url.startswith("http"):
            continue  # ads
        sn = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', rest, re.S)
        out.append({"title": title, "url": url, "snippet": _clean(sn.group(1)) if sn else ""})
    return out


def parse_ddg_lite(page: str) -> list[dict]:
    out = []
    links = list(re.finditer(r"<a[^>]*class=['\"]result-link['\"][^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>|"
                             r"<a[^>]*href=['\"]([^'\"]+)['\"][^>]*class=['\"]result-link['\"][^>]*>(.*?)</a>", page, re.S))
    snippets = [_clean(s) for s in re.findall(r"class=['\"]result-snippet['\"][^>]*>(.*?)</td>", page, re.S)]
    for i, m in enumerate(links):
        url, title = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
        if "duckduckgo.com/l/?" in url:
            url = unquote(parse_qs(urlparse(htmllib.unescape(url)).query).get("uddg", [url])[0])
        if not url.startswith("http") or "duckduckgo.com/y.js" in url:
            continue
        out.append({"title": _clean(title), "url": url, "snippet": snippets[i] if i < len(snippets) else ""})
    return out


def _bing_url(u: str) -> str:
    u = htmllib.unescape(u)
    if "bing.com/ck/a" in u:
        q = parse_qs(urlparse(u).query).get("u", [""])[0]
        if q.startswith("a1"):
            b = q[2:]
            try:
                return base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)).decode()
            except Exception:
                return u
    return u


def parse_bing(page: str) -> list[dict]:
    out = []
    for block in page.split('<li class="b_algo"')[1:]:
        m = re.search(r"<h2[^>]*>\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", block, re.S)
        if not m:
            continue
        sn = re.search(r"<p[^>]*>(.*?)</p>", block, re.S)
        snippet = _clean(sn.group(1)) if sn else ""
        snippet = re.sub(r"^[A-Z][a-z]{2} \d{1,2}, \d{4}\s*·\s*", "", snippet)
        out.append({"title": _clean(m.group(2)), "url": _bing_url(m.group(1)), "snippet": snippet})
    return out


async def _fetch_text(session: aiohttp.ClientSession, method: str, url: str, **kw) -> tuple[int, str]:
    async with session.request(method, url, **kw) as r:
        return r.status, await r.text(errors="replace")


async def web_search(query: str, n: int = 6) -> dict:
    """Returns {"provider", "results": [{title, url, snippet}]} or {"error"}."""
    headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    errors = []
    async with aiohttp.ClientSession(timeout=TIMEOUT, headers=headers) as s:
        attempts = [
            ("DuckDuckGo", lambda: _fetch_text(s, "POST", "https://html.duckduckgo.com/html/", data={"q": query, "kl": "us-en"}), parse_ddg_html),
            ("DuckDuckGo Lite", lambda: _fetch_text(s, "POST", "https://lite.duckduckgo.com/lite/", data={"q": query}), parse_ddg_lite),
            ("Bing", lambda: _fetch_text(s, "GET", f"https://www.bing.com/search?q={quote_plus(query)}&setlang=en&cc=US"), parse_bing),
        ]
        for name, get, parse in attempts:
            try:
                status, page = await get()
                results = parse(page) if status == 200 else []
                if results:
                    return {"provider": name, "results": results[:n]}
                errors.append(f"{name}: {status}, no results")
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                errors.append(f"{name}: {type(e).__name__}")
        try:  # Wikipedia as a last resort (encyclopedic questions)
            async with s.get("https://en.wikipedia.org/w/api.php", params={"action": "query", "list": "search", "srsearch": query,
                                                                              "format": "json", "srlimit": str(n)},
                             headers={"User-Agent": WIKI_UA}) as r:
                data = await r.json(content_type=None)
            res = [{"title": h["title"], "url": "https://en.wikipedia.org/wiki/" + quote_plus(h["title"].replace(" ", "_")),
                    "snippet": _clean(h.get("snippet", ""))} for h in data.get("query", {}).get("search", [])]
            if res:
                return {"provider": "Wikipedia", "results": res}
        except Exception as e:
            errors.append(f"Wikipedia: {type(e).__name__}")
    return {"error": "No search provider answered (offline?). " + "; ".join(errors), "results": []}


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "button", "iframe", "template"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "tr", "section", "article", "td", "pre", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.skip:
            self.parts.append(data)


def html_to_text(page: str) -> tuple[str, str]:
    main = re.search(r"<(article|main)\b[^>]*>(.*?)</\1>", page, re.S | re.I)
    p = _TextExtractor()
    p.feed(page if not main or len(main.group(2)) < 500 else re.search(r"<title>.*?</title>", page, re.S | re.I).group(0) + main.group(2)
           if re.search(r"<title>.*?</title>", page, re.S | re.I) else main.group(2))
    text = re.sub(r"[ \t ]+", " ", "".join(p.parts))
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return p.title.strip(), text


async def fetch_page(url: str, max_chars: int = 8000) -> dict:
    if not re.match(r"https?://", url):
        url = "https://" + url
    try:
        async with aiohttp.ClientSession(timeout=TIMEOUT, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}) as s:
            async with s.get(url, allow_redirects=True) as r:
                ctype = r.headers.get("Content-Type", "")
                body = await r.content.read(4 * 1024 * 1024)
                final = str(r.url)
                status = r.status
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        return {"ok": False, "error": f"Couldn't load {url}: {type(e).__name__}"}
    if status >= 400:
        return {"ok": False, "error": f"{url} returned HTTP {status}"}
    if "pdf" in ctype or final.lower().endswith(".pdf"):
        try:
            from pypdf import PdfReader

            text = "\n".join((pg.extract_text() or "") for pg in PdfReader(io.BytesIO(body)).pages[:30])
            return {"ok": True, "url": final, "title": final.rsplit("/", 1)[-1], "text": text[:max_chars]}
        except Exception as e:
            return {"ok": False, "error": f"Couldn't read the PDF: {e}"}
    page = body.decode(r.charset or "utf-8", errors="replace") if hasattr(r, "charset") else body.decode("utf-8", "replace")
    title, text = html_to_text(page) if "html" in ctype or "<html" in page[:2000].lower() else ("", page)
    return {"ok": True, "url": final, "title": title, "text": text[:max_chars]}
