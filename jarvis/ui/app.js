/* JARVIS UI — vanilla JS, no dependencies (works offline). One file serves three views:
   ?view=hud (floating pill), ?view=compact (menu-bar popover), default = command center. */
"use strict";
(() => {
const qs = new URLSearchParams(location.search);
const VIEW = qs.get("view") || "center";
const TOKEN = window.JARVIS_TOKEN || new URLSearchParams(location.hash.slice(1)).get("token") || qs.get("token") || "";
const root = document.documentElement;
root.dataset.view = VIEW;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const native = msg => { try { window.webkit.messageHandlers.jarvis.postMessage(msg); } catch (e) { /* not in the app */ } };
const ago = ts => { const s = Date.now() / 1000 - ts; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : new Date(ts * 1000).toLocaleDateString(); };
const MODES = { battery_saver: "Battery Saver", balanced: "Balanced", max_performance: "Max Performance" };
const STATUS_TEXT = { idle: "Idle", listening: "Listening…", transcribing: "Understanding…", thinking: "Thinking…", acting: "Working…", speaking: "Speaking", question: "Waiting for you" };

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "X-Jarvis-Token": TOKEN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const S = { state: null, settings: null, shortcuts: [], sel: null, steps: [], convo: [], question: null, hudTimer: null };

/* ---------------- live events ---------------- */
let ws, retry = 500;
function connect() {
  ws = new WebSocket(`ws://${location.host}/api/events?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => { retry = 500; };
  ws.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); };
}
function setStatus(st, detail) {
  root.dataset.status = st;
  if (VIEW === "hud") native({ type: "status", status: st });
  const line = STATUS_TEXT[st] || st;
  if ($("#c-status")) $("#c-status").textContent = line;
  if ($("#d-status")) $("#d-status").textContent = line;
  if (VIEW === "hud") {
    if (st === "listening") hud("Listening…", "");
    else if (st === "transcribing") hud("…", "");
    else if (st === "thinking" || st === "acting") hud(S.lastTranscript || line, detail ? detail : line);
    if (st === "idle") hudLinger();
    else { clearTimeout(S.hudTimer); native({ type: "hud", visible: true }); }
  }
}
function hud(line, sub, actions) {
  $("#hud-line").textContent = line; $("#hud-sub").textContent = sub || "";
  const box = $("#hud-actions"); box.innerHTML = "";
  for (const [label, fn, cls] of actions || []) { const b = document.createElement("button"); b.textContent = label; b.className = cls || ""; b.onclick = fn; box.appendChild(b); }
}
function hudLinger() { clearTimeout(S.hudTimer); S.hudTimer = setTimeout(() => { if (root.dataset.status === "idle") native({ type: "hud", visible: false }); }, 3500); }

function onEvent(ev) {
  switch (ev.type) {
    case "hello": S.state = ev.state; renderState(); setStatus(ev.state.status || "idle"); break;
    case "status": setStatus(ev.status, ev.detail); break;
    case "level": root.style.setProperty("--level", (1 + ev.value * 0.6).toFixed(2)); break;
    case "transcript":
      if (!ev.text) break;
      S.lastTranscript = ev.text; addConvo("u", ev.text);
      if (VIEW === "hud") hud(ev.text, "…"); break;
    case "response": case "say":
      if (ev.type === "response") addConvo("a", ev.text);
      if (VIEW === "hud") { hud(ev.text, S.lastTranscript && ev.type === "response" ? `“${S.lastTranscript}”` : ""); native({ type: "hud", visible: true }); }
      $("#d-last") && ($("#d-last").textContent = ev.text); break;
    case "question":
      S.question = ev.text;
      if (ev.text) {
        root.dataset.status = "question"; addConvo("a q", ev.text);
        const yes = () => answer("yes"), no = () => answer("no");
        if (VIEW === "hud") { hud(ev.text, "Say yes or no", [["Yes", yes, "primary"], ["No", no]]); native({ type: "hud", visible: true }); }
        showQuestion(ev.text);
      } else { showQuestion(null); }
      break;
    case "task":
      if (ev.status === "running") { S.steps = []; renderCurrent(ev.text); }
      else { renderCurrent(null, ev); loadTasks(); }
      break;
    case "agent_step": case "shortcut_step":
      S.steps.push(ev.type === "agent_step" ? { n: ev.step, tool: ev.tool, ok: ev.ok, res: ev.result }
        : { n: ev.i + 1, tool: ev.action, ok: ev.ok, res: ev.message });
      renderSteps();
      if (VIEW === "hud") hud(S.lastTranscript || "Working…", `${ev.tool || ev.action}${ev.ok ? "" : " — retrying"}`);
      break;
    case "agent_thinking": if (VIEW === "hud") hud(S.lastTranscript || "Thinking…", `Thinking · step ${ev.step}`); break;
    case "stopped": addConvo("a", "Stopped."); if (VIEW === "hud") hud("Stopped.", ""); break;
    case "power": if (S.state) { S.state.power = { ...S.state.power, ...ev }; renderState(); } break;
    case "llm": if (S.state) { S.state.llm_available = ev.available; S.state.model = ev.model; renderState(); } break;
    case "voice": refreshState(); break;
    case "permissions": if (location.hash.startsWith("#settings")) loadSettings(); break;
    case "error": addActivity({ ts: ev.ts, level: "error", category: ev.where || "error", message: ev.message }); if (VIEW === "hud") { root.dataset.status = "error"; hud("Something went wrong", ev.message); } break;
    case "open_editor": if (VIEW === "center") { location.hash = "#shortcuts"; newShortcut(ev.name, ev.description); } else native({ type: "openCenter", hash: "shortcuts" }); break;
  }
}
async function answer(text) { await api("POST", "/api/answer", { text }); showQuestion(null); }
function showQuestion(q) {
  const b = $("#l-question"); if (!b) return;
  if (!q) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  b.innerHTML = `<b>${esc(q)}</b><button class="primary sm" id="qy">Yes</button><button class="sm" id="qn">No</button>`;
  $("#qy").onclick = () => answer("yes"); $("#qn").onclick = () => answer("no");
}

/* ---------------- state rendering ---------------- */
async function refreshState() { try { S.state = await api("GET", "/api/state"); renderState(); } catch (e) { console.warn(e); } }
function renderState() {
  const st = S.state; if (!st) return;
  const p = st.power || {}, v = st.voice;   // v is null when the voice subsystem is unavailable
  const motion = S.settings?.ui?.reduced_motion ? "minimal" : p.mode === "battery_saver" ? "minimal" : p.mode === "max_performance" ? "full" : "normal";
  root.dataset.motion = motion;
  $$(".seg [data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === p.mode));
  const batt = p.percent != null ? `${p.percent}% ${p.source === "ac" ? "· charging" : "· on battery"}` : p.source || "";
  const listening = v ? (v.muted ? "Muted" : v.wake_word ? "“Hey JARVIS” + ⌥⇧C" : "Hold ⌥⇧C") : "Voice off";
  if ($("#c-meta")) $("#c-meta").innerHTML = [`<span class="chip">${esc(MODES[p.mode] || p.mode)}</span>`, `<span class="chip">${esc(batt)}</span>`,
    `<span class="chip ${st.llm_available ? "on" : "warn"}">${esc(st.model)}${st.llm_available ? "" : " · offline"}</span>`, `<span class="chip">${esc(listening)}</span>`].join("");
  if ($("#c-mute")) $("#c-mute").textContent = v && v.muted ? "Unmute mic" : "Mute mic";
  const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  set("#sf-mode", MODES[p.mode] || p.mode); set("#sf-model", st.model); set("#sf-wake", listening);
  set("#side-sub", st.platform === "macos" ? "Local assistant" : "SIMULATED computer");
  set("#d-power", MODES[p.mode] || "—"); set("#d-battery", batt + (p.pending ? ` · switching to ${MODES[p.pending]} after this task` : ""));
  set("#d-model", st.model || "—"); set("#d-llm", st.llm_available ? "Running locally · no cloud" : "Local runtime not reachable (start Ollama)");
  set("#d-voice", listening); set("#d-voice2", v ? `${v.stt} · voice ${v.voice} · mic ${v.mic_open ? "open" : "closed"}` : "Voice subsystem unavailable");
}
function addConvo(cls, text) {
  const ul = $("#l-convo"); if (!ul) return;
  const li = document.createElement("li"); li.className = cls; li.textContent = text; ul.appendChild(li);
  while (ul.children.length > 60) ul.firstChild.remove();
  ul.scrollTop = ul.scrollHeight;
}
function renderCurrent(text, done) {
  const el = $("#l-current"); if (!el) return;
  if (text) { el.classList.remove("empty"); el.innerHTML = `<span class="chip on">running</span> ${esc(text)} <button class="danger sm" id="cur-stop">Stop</button>`; $("#cur-stop").onclick = stopAll; renderSteps(); }
  else if (done) { el.classList.remove("empty"); el.innerHTML = `<span class="chip ${done.status === "ok" ? "on" : "warn"}">${esc(done.status)}</span> ${esc(done.text)} <span class="muted">· ${esc(done.route || "")} · ${(done.ms / 1000).toFixed(1)}s</span><div class="muted">${esc(done.message || "")}</div>`; }
}
function renderSteps() {
  const ol = $("#l-steps"); if (!ol) return;
  ol.innerHTML = S.steps.map(s => `<li class="${s.ok ? "" : "bad"}"><span class="n">${s.n}</span><span class="tool">${esc(s.tool)}</span><span class="res" title="${esc(s.res)}">${esc(s.res)}</span></li>`).join("");
  ol.scrollTop = ol.scrollHeight;
}
async function loadTasks() {
  let rows = [];
  try { rows = await api("GET", "/api/tasks?limit=40"); } catch (e) { return; }
  const convo = $("#l-convo");
  if (convo && !convo.children.length) rows.slice(0, 6).reverse().forEach(r => { addConvo("u", r.objective); if (r.result) addConvo("a", r.result); });
  const tb = $("#l-tasks tbody");
  if (tb) tb.innerHTML = rows.map(r => `<tr><td>${ago(r.started_at)}</td><td>${esc(r.objective)}</td><td><span class="chip">${esc(r.route)}</span></td>
    <td class="r" title="${esc(r.result)}"><span class="st ${esc(r.status)}" style="display:inline-block;margin:0 6px 1px 0"></span>${esc(r.result)}</td><td>${r.latency_ms != null ? (r.latency_ms / 1000).toFixed(1) + "s" : ""}</td></tr>`).join("");
  const ct = $("#c-tasks");
  if (ct) ct.innerHTML = rows.slice(0, 8).map(r => `<li><span class="st ${esc(r.status)}"></span><div class="t"><div>${esc(r.objective)}</div><small>${esc(r.result || r.status)}</small></div><small class="muted">${ago(r.started_at)}</small></li>`).join("") || `<li class="muted">No tasks yet. Try “open Spotify”.</li>`;
}
function addActivity(a) {
  const ul = $("#l-activity"); if (!ul) return;
  const li = document.createElement("li"); li.className = a.level;
  li.innerHTML = `<span>${new Date(a.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span class="cat">${esc(a.category)}</span><span>${esc(a.message)}</span>`;
  ul.prepend(li);
}
async function loadActivity() {
  const ul = $("#l-activity"); if (!ul) return;
  const rows = await api("GET", "/api/activity?limit=120").catch(() => []);
  ul.innerHTML = ""; rows.reverse().forEach(addActivity);
}
async function sendCommand(text) { if (!text.trim()) return; await api("POST", "/api/command", { text, source: "ui" }); }
async function stopAll() { await api("POST", "/api/stop", { source: "ui" }); }
async function setMode(mode) { const p = await api("POST", "/api/power", { mode }); S.state.power = { ...S.state.power, ...p }; renderState(); }

/* ---------------- navigation ---------------- */
function route() {
  const h = (location.hash || "#live").slice(1).split("&")[0];
  $$("#nav a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#" + h));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "v-" + h));
  if (h === "shortcuts") loadShortcuts();
  if (h === "memory") loadMemory();
  if (h === "search") loadSearchStats();
  if (h === "settings") loadSettings();
  if (h === "dashboard") loadDashboard();
  if (h === "live") { loadTasks(); loadActivity(); }
}

/* ---------------- dashboard ---------------- */
async function loadDashboard() {
  await refreshState();
  const [scs, st] = await Promise.all([api("GET", "/api/shortcuts").catch(() => []), api("GET", "/api/search/stats").catch(() => ({}))]);
  $("#d-files").textContent = st.files != null ? `${st.files.toLocaleString()} files indexed` : "—";
  $("#d-files2").textContent = st.indexing ? "Indexing now (background, low priority)" : st.only_when_charging ? "Indexes while charging" : "Index on demand";
  $("#d-quick").innerHTML = scs.filter(s => s.enabled).map(s => `<button data-t="${esc(s.triggers[0])}">${esc(s.name)}</button>`).join("") || `<span class="muted">No shortcuts yet.</span>`;
  $$("#d-quick button").forEach(b => b.onclick = () => sendCommand(b.dataset.t));
}

/* ---------------- shortcuts editor ---------------- */
const CONDS = ["page_ready", "url_contains", "title_contains", "text_present", "element_present", "app_running", "app_frontmost", "file_exists"];
const F = (k, type, extra) => ({ k, type, extra });
const ACTIONS = {
  open_url: [F("url", "text", "https://…"), F("browser", "text", "Arc"), F("new_tab", "bool"), F("expect_url_contains", "text", "optional check")],
  open_app: [F("app", "text", "Spotify")], focus_app: [F("app", "text")], quit_app: [F("app", "text")],
  browser: [F("command", "select", ["back", "forward", "reload", "new_tab", "close_tab"])],
  click: [F("target", "text", "button or link text"), F("app", "text", "app (optional)")],
  type: [F("text", "text"), F("target", "text", "field label (optional)"), F("submit", "bool")],
  keys: [F("combo", "text", "cmd+t")], scroll: [F("direction", "select", ["down", "up", "top", "bottom"])],
  wait: [F("seconds", "number")],
  wait_for: [F("condition.type", "select", CONDS), F("condition.value", "text"), F("timeout", "number")],
  verify: [F("condition.type", "select", CONDS), F("condition.value", "text")],
  menu: [F("app", "text"), F("path", "text", "File > New Window")],
  open_file: [F("path", "text", "~/Documents/…"), F("app", "text", "app (optional)")], reveal_file: [F("path", "text")],
  move_file: [F("src", "text"), F("dst", "text")],
  macos_shortcut: [F("name", "text", "Shortcuts app shortcut name")],
  arrange_windows: [F("layout", "select", ["halves", "thirds", "columns", "maximize", "left", "right"]), F("apps", "text", "Arc, Notes")],
  volume: [F("level", "number")], say: [F("text", "text")], notify: [F("text", "text")],
  run_shortcut: [F("shortcut", "text", "another shortcut's id")],
  agent: [F("instruction", "text", "what the AI should figure out")],
  if: [F("condition.type", "select", CONDS), F("condition.value", "text"), F("then", "json"), F("else", "json")],
  set: [F("var", "text"), F("value", "text")],
  media: [F("key", "select", ["play", "next", "previous", "brightness_up", "brightness_down"])],
  system: [F("command", "select", ["dark_mode", "light_mode", "toggle_appearance", "wifi_on", "wifi_off", "open_settings", "screenshot",
    "minimize", "fullscreen", "hide", "new_window", "close_window", "show_desktop", "mission_control"]), F("value", "text", "settings pane or app (optional)")],
  note: [F("text", "text", "note text"), F("title", "text", "title (optional)")],
  reminder: [F("text", "text"), F("when", "text", "e.g. tomorrow at 9am (optional)")],
  open_location: [F("url", "text", "spotify:… zoommtg:… etc.")],
  applescript: [F("script", "textarea")], shell: [F("command", "text")],
};
const getp = (o, k) => k.split(".").reduce((a, p) => a?.[p], o);
const setp = (o, k, v) => { const ps = k.split("."); let n = o; ps.slice(0, -1).forEach(p => n = n[p] ??= {}); n[ps.at(-1)] = v; };

async function loadShortcuts() {
  S.shortcuts = await api("GET", "/api/shortcuts").catch(() => []);
  $("#s-list").innerHTML = S.shortcuts.map(s => `<li data-id="${esc(s.id)}" class="${S.sel?.id === s.id ? "sel" : ""}"><b>${esc(s.name)}</b>${s.enabled ? "" : ' <span class="chip">off</span>'}<small>“${esc(s.triggers.join("”, “"))}”</small></li>`).join("") || `<li class="muted">None yet.</li>`;
  $$("#s-list li[data-id]").forEach(li => li.onclick = () => editShortcut(structuredClone(S.shortcuts.find(s => s.id === li.dataset.id))));
}
function newShortcut(name, description) {
  editShortcut({ name: name || "New shortcut", triggers: [name ? name.toLowerCase() : ""].filter(Boolean), enabled: true, response: "", on_error: "agent",
    steps: [{ action: "open_url", url: "", browser: "Arc", new_tab: true }], description: description || "" }, true);
}
function editShortcut(sc, isNew) {
  S.sel = sc; S.selNew = !!isNew;
  $$("#s-list li").forEach(li => li.classList.toggle("sel", li.dataset.id === sc.id));
  const ed = $("#s-editor");
  ed.innerHTML = `
    ${sc.description ? `<div class="banner" style="margin-bottom:12px"><b>You said: “${esc(sc.description)}”. Fill in the steps below.</b></div>` : ""}
    <div class="field"><label>Name</label><input id="e-name" value="${esc(sc.name)}"></div>
    <div class="field"><label>Trigger phrases <span class="muted">(use {name} for a spoken parameter, e.g. “search youtube for {query}”)</span></label>
      <div class="chips" id="e-trig">${sc.triggers.map((t, i) => `<span class="chip">${esc(t)}<b data-i="${i}">×</b></span>`).join("")}<input placeholder="add phrase, press Enter"></div></div>
    <div class="field"><label>Steps</label><div id="e-steps"></div><div class="row gap"><button class="sm" id="e-add">+ Add step</button></div></div>
    <div class="row gap" style="flex-wrap:wrap">
      <div class="field grow"><label>Spoken confirmation</label><input id="e-resp" value="${esc(sc.response || "")}" placeholder="e.g. Your IB course is open."></div>
      <div class="field"><label>If a step fails</label><select id="e-err">${["agent", "report", "continue"].map(o => `<option ${sc.on_error === o ? "selected" : ""} value="${o}">${{ agent: "let the AI finish it", report: "stop and tell me", continue: "skip and continue" }[o]}</option>`).join("")}</select></div>
      <div class="field"><label>Enabled</label><select id="e-en"><option value="1">yes</option><option value="0" ${sc.enabled === false ? "selected" : ""}>no</option></select></div>
    </div>
    <details><summary class="muted">Advanced: edit as JSON</summary><textarea id="e-json" rows="12"></textarea><button class="sm" id="e-json-apply">Apply JSON</button></details>
    <div class="ed-foot"><button class="primary" id="e-save">Save</button><button id="e-test">Test run</button><span class="sp"></span>
      <span class="muted" id="e-msg"></span><button class="danger" id="e-del">${isNew ? "Discard" : "Delete"}</button></div>
    <div class="runlog" id="e-log"></div>`;
  const trig = $("#e-trig input");
  trig.onkeydown = e => { if (e.key === "Enter" && trig.value.trim()) { e.preventDefault(); sc.triggers.push(trig.value.trim()); editShortcut(sc, S.selNew); $("#e-trig input").focus(); } };
  $$("#e-trig b").forEach(b => b.onclick = () => { sc.triggers.splice(+b.dataset.i, 1); editShortcut(sc, S.selNew); });
  $("#e-name").oninput = e => sc.name = e.target.value;
  $("#e-resp").oninput = e => sc.response = e.target.value;
  $("#e-err").onchange = e => sc.on_error = e.target.value;
  $("#e-en").onchange = e => sc.enabled = e.target.value === "1";
  $("#e-add").onclick = () => { sc.steps.push({ action: "open_app", app: "" }); renderStepsEditor(sc); };
  $("#e-json").value = JSON.stringify(strip(sc), null, 2);
  $("#e-json-apply").onclick = () => { try { const v = JSON.parse($("#e-json").value); Object.assign(sc, v); editShortcut(sc, S.selNew); } catch (e) { msg("Invalid JSON: " + e.message, true); } };
  $("#e-save").onclick = saveShortcut; $("#e-test").onclick = testShortcut;
  $("#e-del").onclick = async () => { if (S.selNew) { $("#s-editor").innerHTML = `<div class="empty">Discarded.</div>`; return; }
    if (!confirm(`Delete “${sc.name}”?`)) return; await api("DELETE", "/api/shortcuts/" + encodeURIComponent(sc.id)); S.sel = null; $("#s-editor").innerHTML = `<div class="empty">Deleted.</div>`; loadShortcuts(); };
  renderStepsEditor(sc);
  loadRuns(sc.id);
}
const strip = sc => { const { updated_at, description, ...rest } = sc; return rest; };
function msg(t, bad) { const m = $("#e-msg"); m.textContent = t; m.style.color = bad ? "var(--orange)" : "var(--green)"; }
function renderStepsEditor(sc) {
  const box = $("#e-steps");
  box.innerHTML = sc.steps.map((st, i) => {
    const fields = (ACTIONS[st.action] || []).map(f => {
      const v = getp(st, f.k);
      if (f.type === "bool") return `<label><span>${f.k}</span><select data-k="${f.k}" data-t="bool"><option value="1" ${v !== false ? "selected" : ""}>yes</option><option value="0" ${v === false ? "selected" : ""}>no</option></select></label>`;
      if (f.type === "select") return `<label><span>${f.k.replace("condition.", "")}</span><select data-k="${f.k}">${f.extra.map(o => `<option ${v === o ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
      if (f.type === "json" || f.type === "textarea") return `<label style="grid-column:1/-1"><span>${f.k}</span><textarea rows="4" data-k="${f.k}" data-t="${f.type}">${esc(f.type === "json" ? JSON.stringify(v || [], null, 1) : v || "")}</textarea></label>`;
      return `<label><span>${f.k.replace("condition.", "")}</span><input data-k="${f.k}" data-t="${f.type}" value="${esc(Array.isArray(v) ? v.join(", ") : v ?? "")}" placeholder="${esc(f.extra || "")}"></label>`;
    }).join("");
    const risky = ["shell", "applescript"].includes(st.action);
    return `<div class="step" data-i="${i}"><div class="step-head"><span class="num">${i + 1}</span>
      <select class="act">${Object.keys(ACTIONS).map(a => `<option ${a === st.action ? "selected" : ""}>${a}</option>`).join("")}</select>
      ${risky ? '<span class="risk-high">runs code — asks before running if not created here</span>' : ""}<span class="sp"></span>
      <button class="ghost sm up">↑</button><button class="ghost sm down">↓</button><button class="ghost sm del">✕</button></div>
      <div class="step-fields">${fields}</div></div>`;
  }).join("");
  $$(".step", box).forEach(el => {
    const i = +el.dataset.i, st = sc.steps[i];
    $(".act", el).onchange = e => { sc.steps[i] = { action: e.target.value }; renderStepsEditor(sc); };
    $(".up", el).onclick = () => { if (i > 0) { [sc.steps[i - 1], sc.steps[i]] = [sc.steps[i], sc.steps[i - 1]]; renderStepsEditor(sc); } };
    $(".down", el).onclick = () => { if (i < sc.steps.length - 1) { [sc.steps[i + 1], sc.steps[i]] = [sc.steps[i], sc.steps[i + 1]]; renderStepsEditor(sc); } };
    $(".del", el).onclick = () => { sc.steps.splice(i, 1); renderStepsEditor(sc); };
    $$("[data-k]", el).forEach(inp => inp.onchange = () => {
      const t = inp.dataset.t; let v = inp.value;
      if (t === "bool") v = v === "1"; else if (t === "number") v = v === "" ? undefined : Number(v);
      else if (t === "json") { try { v = JSON.parse(v || "[]"); } catch (e) { msg("Invalid JSON in " + inp.dataset.k, true); return; } }
      else if (inp.dataset.k === "apps") v = v.split(",").map(s => s.trim()).filter(Boolean);
      setp(st, inp.dataset.k, v);
    });
  });
}
async function saveShortcut() {
  const sc = S.sel;
  if (!sc.triggers.length) sc.triggers = [sc.name.toLowerCase()];
  try { const saved = await api("POST", "/api/shortcuts", strip(sc)); S.sel = saved; S.selNew = false; msg("Saved."); await loadShortcuts(); editShortcut(structuredClone(saved)); msg("Saved."); }
  catch (e) { msg(e.message, true); }
}
async function testShortcut() {
  if (S.selNew) { await saveShortcut(); if (S.selNew) return; }
  msg("Running…");
  try { const r = await api("POST", `/api/shortcuts/${encodeURIComponent(S.sel.id)}/test`, {}); msg(r.ok ? "Worked: " + r.message : "Failed: " + r.message, !r.ok);
    $("#e-log").textContent = r.log.map(l => `${l.ok ? "✓" : "✗"} ${l.i + 1}. ${l.action}  ${l.message}  (${l.ms} ms${l.attempt > 1 ? ", attempt " + l.attempt : ""})`).join("\n"); loadRuns(S.sel.id); }
  catch (e) { msg(e.message, true); }
}
async function loadRuns(id) {
  if (!id || S.selNew) return;
  const runs = await api("GET", "/api/shortcut-runs?id=" + encodeURIComponent(id)).catch(() => []);
  const el = $("#e-log"); if (!el || el.textContent) return;
  el.textContent = runs.length ? "History:\n" + runs.slice(0, 8).map(r => `${new Date(r.started_at * 1000).toLocaleString()}  ${r.status}  (${r.log.length} steps)`).join("\n") : "";
}
$("#s-new") && ($("#s-new").onclick = () => newShortcut());
$("#s-export") && ($("#s-export").onclick = async () => {
  const data = await api("GET", "/api/shortcuts-export");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = "jarvis-shortcuts.json"; a.click();
});
$("#s-import") && ($("#s-import").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const r = await api("POST", "/api/shortcuts-import", JSON.parse(await f.text()));
  alert(`Imported ${r.added.length}, skipped ${r.skipped.length} existing${r.errors.length ? ", errors: " + r.errors.join("; ") : ""}`); loadShortcuts();
});

/* ---------------- memory ---------------- */
async function loadMemory() {
  const q = $("#m-q").value.trim();
  const rows = await api("GET", "/api/memory" + (q ? "?q=" + encodeURIComponent(q) : "")).catch(() => []);
  $("#m-export").href = "/api/memory-export?token=" + encodeURIComponent(TOKEN);
  $("#m-list").innerHTML = rows.map(m => `<li data-id="${m.id}"><span class="chip ${m.source === "explicit" ? "on" : "warn"}">${esc(m.source)}</span>
    <div class="body"><div contenteditable="true" spellcheck="false">${esc(m.content)}</div><small class="muted">${esc(m.kind)} · ${ago(m.updated_at)}${m.source === "inferred" ? ` · confidence ${m.confidence}` : ""}</small></div>
    <button class="ghost sm del">Delete</button></li>`).join("") || `<li class="muted">Nothing saved${q ? " matching that" : " yet. Say “JARVIS, remember that …”"}.</li>`;
  $$("#m-list li[data-id]").forEach(li => {
    const id = li.dataset.id, ed = $("[contenteditable]", li);
    ed.onblur = () => api("PUT", "/api/memory/" + id, { content: ed.textContent.trim() });
    $(".del", li).onclick = async () => { await api("DELETE", "/api/memory/" + id); li.remove(); };
  });
}
$("#m-q") && ($("#m-q").oninput = () => { clearTimeout(S.mt); S.mt = setTimeout(loadMemory, 200); });
$("#m-add") && ($("#m-add").onsubmit = async e => { e.preventDefault(); const c = $("#m-new").value.trim(); if (!c) return;
  await api("POST", "/api/memory", { content: c, kind: $("#m-kind").value || undefined }); $("#m-new").value = ""; loadMemory(); });

/* ---------------- search ---------------- */
async function loadSearchStats() {
  const st = await api("GET", "/api/search/stats").catch(() => null); if (!st) return;
  $("#f-stats").innerHTML = `${st.files.toLocaleString()} files · ${st.chunks.toLocaleString()} passages · ${st.embedded.toLocaleString()} with meaning vectors · ` +
    `${st.indexing ? "indexing now" : st.last_indexed ? "last indexed " + ago(st.last_indexed) + " ago" : "not indexed yet"} · Spotlight results included
    <button class="ghost sm" id="f-index">Index now</button>`;
  $("#f-index").onclick = async () => { await api("POST", "/api/index", { force: true }); loadSearchStats(); };
}
$("#f-form") && ($("#f-form").onsubmit = async e => {
  e.preventDefault();
  const q = $("#f-q").value.trim(); if (!q) return;
  const p = new URLSearchParams({ q }); if ($("#f-kind").value) p.set("kind", $("#f-kind").value); if ($("#f-days").value) p.set("days", $("#f-days").value);
  $("#f-results").innerHTML = `<li class="muted">Searching…</li>`;
  const rows = await api("GET", "/api/search?" + p).catch(err => { $("#f-results").innerHTML = `<li>${esc(err.message)}</li>`; return null; }); if (!rows) return;
  $("#f-results").innerHTML = rows.map(r => `<li><div class="body"><div class="name">${esc(r.name || r.path.split("/").pop())} <span class="chip">${esc(r.kind || "")}</span></div>
    <div class="path">${esc(r.path)}</div>${r.snippet ? `<div class="snip">${esc(r.snippet)}</div>` : ""}<small class="muted">${r.mtime ? new Date(r.mtime * 1000).toLocaleDateString() : ""} · via ${esc((r.sources || []).join(", "))}</small></div>
    <button class="sm" data-open="${esc(r.path)}">Open</button><button class="ghost sm" data-reveal="${esc(r.path)}">Show</button></li>`).join("") || `<li class="muted">No matches.</li>`;
  $$("[data-open]").forEach(b => b.onclick = () => api("POST", "/api/open", { path: b.dataset.open }));
  $$("[data-reveal]").forEach(b => b.onclick = () => api("POST", "/api/open?reveal=1", { path: b.dataset.reveal }));
});

/* ---------------- settings ---------------- */
const VOICES = { bm_george: "George — British, composed", bm_lewis: "Lewis — British, deeper", bm_fable: "Fable — British, lighter", bm_daniel: "Daniel — British",
  bf_emma: "Emma — British", bf_isabella: "Isabella — British", am_michael: "Michael — American", am_adam: "Adam — American", af_heart: "Heart — American", af_bella: "Bella — American" };
function inputFor(path, val, opts = {}) {
  if (opts.select) return `<select data-path="${path}">${Object.entries(opts.select).map(([k, l]) => `<option value="${esc(k)}" ${String(val) === String(k) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  if (opts.bool) return `<input type="checkbox" data-path="${path}" ${val ? "checked" : ""}>`;
  if (opts.range) return `<input type="range" data-path="${path}" min="${opts.range[0]}" max="${opts.range[1]}" step="${opts.range[2]}" value="${val}">`;
  if (opts.lines) return `<textarea data-path="${path}" data-lines="1" rows="${opts.rows || 4}">${esc((val || []).join("\n"))}</textarea>`;
  return `<input data-path="${path}" ${opts.num ? 'type="number"' : ""} value="${esc(val ?? "")}" ${opts.list ? `list="${opts.list}"` : ""}>`;
}
const fld = (label, html, help) => `<div class="field"><label>${label}</label>${html}${help ? `<div class="help">${help}</div>` : ""}</div>`;
const tog = (label, html) => `<div class="toggle"><span>${label}</span>${html}</div>`;
async function loadSettings() {
  const [s, models, perms] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/models").catch(() => ({})), api("POST", "/api/permissions", {}).catch(() => ({}))]);
  S.settings = s;
  const avail = (models.available || []).map(m => m.name || m.id);
  const modeSel = { battery_saver: "Battery Saver", balanced: "Balanced", max_performance: "Maximum Performance" };
  const permRow = (k, label, pane) => { const v = perms[k]; const ok = v === true || v === "granted";
    return `<div class="perm"><span>${label}</span><span><span class="chip ${ok ? "on" : "warn"}">${v === null || v === undefined ? "unknown" : ok ? "granted" : esc(String(v))}</span>
      ${ok ? "" : `<button class="sm" data-pane="${pane}">Open Settings</button>`}</span></div>`; };
  $("#settings").innerHTML = `
  <section class="panel"><h2>Power</h2>
    ${fld("Mode (now)", inputFor("power.mode", S.state?.power?.mode || s.power.mode, { select: modeSel }), "Choosing a mode here overrides automatic switching until the power source changes.")}
    ${tog("Switch automatically with the power source", inputFor("power.auto_switch", s.power.auto_switch, { bool: 1 }))}
    <div class="row gap">${fld("On battery", inputFor("power.auto_on_battery", s.power.auto_on_battery, { select: modeSel }))}${fld("Plugged in", inputFor("power.auto_on_ac", s.power.auto_on_ac, { select: modeSel }))}</div>
    ${fld("Battery Saver below (%)", inputFor("power.low_battery_percent", s.power.low_battery_percent, { num: 1 }))}
    ${tog("Keep the Mac awake during long tasks I start", inputFor("power.prevent_sleep_during_tasks", s.power.prevent_sleep_during_tasks, { bool: 1 }))}
    <div class="help">Mode changes never interrupt a running task. Indexing only runs while charging unless you start it.</div></section>
  <section class="panel"><h2>Voice</h2>
    ${fld("“Hey JARVIS” wake word", inputFor("voice.wake_word_policy", s.voice.wake_word_policy, { select: { ac_only: "Only when plugged in (hold ⌥⇧C on battery)", always: "Always", except_battery_saver: "Except in Battery Saver", never: "Never — hotkey only" } }))}
    ${fld("Wake-word sensitivity", inputFor("voice.wake_threshold", s.voice.wake_threshold, { range: [0.2, 0.9, 0.05] }), "Lower = triggers more easily (more false alarms).")}
    ${fld("Voice", inputFor("voice.tts_voice", s.voice.tts_voice, { select: VOICES }))}
    ${fld("Speaking speed", inputFor("voice.tts_speed", s.voice.tts_speed, { range: [0.8, 1.4, 0.05] }))}
    ${tog("Hands-free follow-ups (listen briefly after replies)", inputFor("voice.hands_free", s.voice.hands_free, { bool: 1 }))}
    ${fld("Follow-up window (seconds)", inputFor("voice.followup_seconds", s.voice.followup_seconds, { num: 1 }))}
    ${tog("Listening chime", inputFor("voice.chime", s.voice.chime, { bool: 1 }))}
    ${fld("Microphone (blank = system default)", inputFor("voice.input_device", s.voice.input_device ?? ""))}
    <button class="sm" id="v-preview">Preview voice</button></section>
  <section class="panel"><h2>Local AI</h2>
    <datalist id="mlist">${avail.map(m => `<option value="${esc(m)}">`).join("")}</datalist>
    ${fld("Runtime", inputFor("llm.provider", s.llm.provider, { select: { ollama: "Ollama (recommended)", openai_compatible: "OpenAI-compatible local server (MLX, llama.cpp, LM Studio)" } }))}
    ${fld("Address", inputFor("llm.base_url", s.llm.base_url))}
    ${fld("Battery Saver model", inputFor("llm.models.battery_saver", s.llm.models.battery_saver, { list: "mlist" }))}
    ${fld("Balanced model", inputFor("llm.models.balanced", s.llm.models.balanced, { list: "mlist" }))}
    ${fld("Max Performance model", inputFor("llm.models.max_performance", s.llm.models.max_performance, { list: "mlist" }))}
    ${fld("Embedding model (file search)", inputFor("llm.embed_model", s.llm.embed_model, { list: "mlist" }))}
    <div class="help">${avail.length ? "Installed: " + avail.map(esc).join(", ") : esc(models.error || "No models found.")} · Run <code>jarvis bench</code> to compare models on your Mac.</div></section>
  <section class="panel"><h2>Files &amp; search</h2>
    ${fld("Folders JARVIS may index (one per line)", inputFor("search.roots", s.search.roots, { lines: 1, rows: 3 }))}
    ${fld("Never index (patterns)", inputFor("search.exclude", s.search.exclude, { lines: 1, rows: 5 }))}
    ${tog("Index only while charging", inputFor("search.only_when_charging", s.search.only_when_charging, { bool: 1 }))}
    ${tog("Meaning-based (semantic) search", inputFor("search.semantic", s.search.semantic, { bool: 1 }))}
    ${tog("Read text in screenshots & images (OCR)", inputFor("search.ocr_images", s.search.ocr_images, { bool: 1 }))}
    ${tog("Include Spotlight results", inputFor("search.use_spotlight", s.search.use_spotlight, { bool: 1 }))}</section>
  <section class="panel"><h2>Browser &amp; safety</h2>
    ${fld("Default browser", inputFor("browser.default", s.browser.default, { select: { "Arc": "Arc", "Google Chrome": "Google Chrome", "Safari": "Safari", "Brave Browser": "Brave", "Microsoft Edge": "Edge" } }))}
    ${tog("Ask before high-impact actions (delete, submit, send, buy)", inputFor("agent.confirm_high_risk", s.agent.confirm_high_risk, { bool: 1 }))}
    ${fld("Apps JARVIS must never control", inputFor("security.blocked_apps", s.security.blocked_apps, { lines: 1, rows: 3 }))}
    ${fld("Folders JARVIS may reorganize without asking", inputFor("security.file_write_roots", s.security.file_write_roots, { lines: 1, rows: 3 }))}
    ${tog("Reduce motion", inputFor("ui.reduced_motion", s.ui.reduced_motion, { bool: 1 }))}</section>
  <section class="panel"><h2>Permissions</h2>
    ${permRow("microphone", "Microphone", "Privacy_Microphone")}
    ${permRow("accessibility", "Accessibility (click, type, read apps)", "Privacy_Accessibility")}
    ${permRow("screen_recording", "Screen Recording (screenshots, OCR)", "Privacy_ScreenCapture")}
    ${perms.accessibility === false ? `<div class="banner" style="margin-top:8px"><b>${perms.accessibility_app
      ? "JARVIS is allowed, but its background service isn't. Click Reset permissions, then allow JARVIS again."
      : "If JARVIS is already switched on in the Accessibility list, that entry belongs to an older build. Click Reset permissions, then switch JARVIS on again when macOS asks."}</b></div>` : ""}
    <div class="perm"><span>Automation (control Arc, Finder…)</span><span class="chip">asked per app</span></div>
    <div class="row gap" style="margin-top:10px"><button class="sm" id="p-req">Request missing permissions</button>
      <button class="sm" id="p-reset">Reset permissions</button></div>
    <div class="help">Talk key: hold <kbd>${esc(perms.talk_key || "⌥⇧C")}</kbd>${perms.talk_key === "⌃⌥C" ? " (switches to ⌥⇧C once Accessibility is allowed)" : ""}. This page re-checks automatically.</div>
    <div class="help">Hotkeys: hold <kbd>⌥⇧C</kbd> to talk · <kbd>⌃⌥⌘.</kbd> emergency stop.</div></section>`;
  $$("[data-path]", $("#settings")).forEach(el => el.onchange = async () => {
    let v = el.type === "checkbox" ? el.checked : el.dataset.lines ? el.value.split("\n").map(x => x.trim()).filter(Boolean) : el.type === "range" || el.type === "number" ? Number(el.value) : el.value;
    if (el.dataset.path === "voice.input_device" && v === "") v = null;
    const patch = {}; setp(patch, el.dataset.path, v);
    if (el.dataset.path === "power.mode") { await setMode(v); return; }
    S.settings = await api("PUT", "/api/settings", patch); refreshState();
  });
  $$("[data-pane]").forEach(b => b.onclick = () => native({ type: "openURL", url: "x-apple.systempreferences:com.apple.preference.security?" + b.dataset.pane }));
  $("#p-req").onclick = async () => { await api("POST", "/api/permissions", { request: true }); setTimeout(loadSettings, 1500); };
  $("#p-reset").onclick = async () => {
    if (!confirm("Reset JARVIS's macOS permissions? macOS will ask again; allow each one, and switch JARVIS on in Accessibility.")) return;
    await api("POST", "/api/permissions", { reset: true }); setTimeout(loadSettings, 1500);
  };
  // Re-check permissions every 3 s while Settings is open, so granting them shows up without reloading.
  clearInterval(S.permTimer);
  S.permKey = JSON.stringify(perms);
  S.permTimer = setInterval(async () => {
    if (!location.hash.startsWith("#settings") || document.hidden) return;
    const p = await api("POST", "/api/permissions", {}).catch(() => null);
    if (p && JSON.stringify(p) !== S.permKey) loadSettings();
  }, 3000);
  $("#v-preview").onclick = () => api("POST", "/api/voice/preview", { text: "Good evening. All systems are running locally, and nothing leaves this Mac." }).catch(e => alert(e.message));
}

/* ---------------- wiring ---------------- */
function bindForm(form, input) { const f = $(form); if (f) f.onsubmit = e => { e.preventDefault(); const t = $(input).value; $(input).value = ""; sendCommand(t); }; }
bindForm("#c-form", "#c-input"); bindForm("#l-form", "#l-input");
$$(".seg [data-mode]").forEach(b => b.onclick = () => setMode(b.dataset.mode));
["#c-stop", "#sf-stop"].forEach(id => $(id) && ($(id).onclick = stopAll));
$("#c-open") && ($("#c-open").onclick = () => native({ type: "openCenter" }));
$("#c-mute") && ($("#c-mute").onclick = async () => { const muted = !(S.state?.voice?.muted); await api("POST", "/api/mute", { muted }); refreshState(); });
$("#l-refresh") && ($("#l-refresh").onclick = () => { loadTasks(); loadActivity(); });
window.addEventListener("hashchange", route);
document.addEventListener("keydown", e => { if (e.key === "Escape" && root.dataset.status !== "idle") stopAll(); });
window.jarvisNative = { status: setStatus, refresh: refreshState };
connect();
refreshState();
api("GET", "/api/settings").then(s => { S.settings = s; renderState(); }).catch(() => {});
if (VIEW === "center") route();
if (VIEW === "compact") loadTasks();
})();
