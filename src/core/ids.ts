/** Time-sortable unique ids (ULID-like, base36). */
let last = 0;
let seq = 0;
export function newId(prefix = ""): string {
  const now = Date.now();
  if (now === last) seq++;
  else {
    last = now;
    seq = 0;
  }
  const rand = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return prefix + now.toString(36).padStart(9, "0") + seq.toString(36).padStart(3, "0") + rand;
}

/** cyrb53: fast 53-bit string hash, returned as base36. */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** SHA-256 hex of text (WebCrypto; available in browsers, WKWebView and Node 20+). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
