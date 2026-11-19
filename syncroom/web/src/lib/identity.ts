// Lightweight persistent identity: a random id + display name in localStorage (no accounts needed).
const ID_KEY = 'syncroom.userId';
const NAME_KEY = 'syncroom.name';

function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export function userId(): string {
  let id = safeGet(ID_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^\w-]/g, '');
    safeSet(ID_KEY, id);
  }
  return id;
}
export function displayName(): string | null { return safeGet(NAME_KEY); }
export function setDisplayName(name: string) {
  safeSet(NAME_KEY, name.trim().slice(0, 32));
  fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: userId(), name }) }).catch(() => {});
}
export const store = { get: safeGet, set: safeSet, del: (k: string) => { try { localStorage.removeItem(k); } catch { /* */ } } };
