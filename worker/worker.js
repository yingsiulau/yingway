/*
 * Yingway Sync – Cloudflare Worker
 *
 * Speichert genau EINEN verschlüsselten Datenblock ("vault") in KV, plus
 * optional verschlüsselte PDF-Belege in einem R2-Bucket. Der Worker sieht
 * nie Klartext: alles, was er entgegennimmt, ist bereits AES-256-GCM-
 * verschlüsselt (mit der Passphrase, die nur im Browser existiert).
 *
 * Zugriff: jede Anfrage muss  Authorization: Bearer <token>  mitschicken.
 *   token = SHA-256("yingway|" + passphrase)   (im Browser berechnet)
 * Der Worker kennt nur SHA-256(token) und kann daraus die Passphrase
 * nicht zurückrechnen. Wer die Passphrase kennt, darf lesen + schreiben,
 * sonst niemand.
 *
 * Endpunkte:
 *   GET  /vault                -> { rev, blob, updatedAt }   (blob=null wenn leer)
 *   PUT  /vault                Body { blob, baseRev }
 *                              -> 200 { rev, updatedAt }
 *                              -> 409 { error:"conflict", rev, blob }  (anderes Gerät war schneller)
 *                              -> 403  falsche Passphrase für vorhandene Daten
 *
 *   GET    /files/<ledger>/<id>  -> rohe verschlüsselte Bytes (PDF-Beleg)
 *   PUT    /files/<ledger>/<id>  Body = rohe verschlüsselte Bytes  -> 200 {ok:true}
 *   DELETE /files/<ledger>/<id>                                    -> 200 {ok:true}
 *   Belege gehören zu einem bereits beanspruchten Vault – ohne beanspruchten
 *   Vault (siehe oben) lehnt /files jede Anfrage ab.
 *
 * News-Monitor: ein Cron-Trigger (alle 5 Min.) prüft reihum die in der App eingetragenen
 * Shops (Shopify-Kollektionen und wog.ch), filtert auf Pokémon / One Piece / Dragon Ball,
 * vergleicht mit dem letzten Stand und meldet per Mail (Resend-API): neue Produkte,
 * Preisänderungen, ausverkauft -> wieder verfügbar.
 *   GET    /news                -> { sources, events, lastRun, lastError, mail }
 *   POST   /news/check          -> nächste Prüfrunde sofort ausführen (wie der Cron)
 *   POST   /news/test           -> Testmail
 *   POST   /news/sources        Body { urls:[…≤8], filter }  -> Quellen hinzufügen (Typ wird erkannt)
 *   PUT    /news/sources/<id>   Body { name?, off?, filter? }
 *   DELETE /news/sources/<id>
 *   Gleiche Passphrase-Auth wie /files. Mail nur, wenn die Secrets RESEND_API_KEY und NEWS_TO
 *   gesetzt sind (siehe SETUP-SYNC.md); sonst läuft nur das Dashboard.
 */

const KV_KEY = 'vault';
const CFG_KEY = 'watch:cfg';
const STATE_KEY = 'watch:state';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const WOG_LIST = 'https://www.wog.ch/de/index.cfm/ajax.productList';
const WATCH_UA = 'Mozilla/5.0 (compatible; YingwayMonitor/1.0; +https://yingsiulau.github.io/yingway/)';
const MAX_SOURCES = 100;
const MAX_PAGES = 4;          // Shopify: bis 4 x 250 Produkte pro Kollektion
const EVENTS_KEEP = 500;
// Pro Cron-Lauf: Workers-Limit sind 50 Anfragen; das Datenbudget hält die CPU-Zeit klein (Free-Tarif).
const RUN_SUBREQ = 40;
const RUN_BYTES = 2500000;

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Cache-Control': 'no-store',
  }, extra || {});
}
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
const text = (msg, status) =>
  new Response(msg, { status: status || 200, headers: corsHeaders() });

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readVault(env) {
  const stored = await env.DB.get(KV_KEY);
  return stored ? JSON.parse(stored) : null;
}

async function handleVault(request, env, tokenHash) {
  const rec = await readVault(env);
  if (rec && rec.tokenHash !== tokenHash) return text('forbidden', 403);

  if (request.method === 'GET') {
    if (!rec) return json({ rev: 0, blob: null });
    return json({ rev: rec.rev, blob: rec.blob, updatedAt: rec.updatedAt });
  }
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch (e) { return text('bad json', 400); }
    if (!body || typeof body.blob !== 'string' || body.blob.length < 16)
      return text('bad body', 400);
    if (body.blob.length > MAX_FILE_BYTES) return text('too large', 413);

    const curRev = rec ? rec.rev : 0;
    const baseRev = Number(body.baseRev || 0);
    if (baseRev !== curRev)
      return json({ error: 'conflict', rev: curRev, blob: rec ? rec.blob : null }, 409);

    const next = { blob: body.blob, rev: curRev + 1, updatedAt: new Date().toISOString(), tokenHash };
    await env.DB.put(KV_KEY, JSON.stringify(next));
    return json({ rev: next.rev, updatedAt: next.updatedAt });
  }
  return text('method not allowed', 405);
}

async function handleFiles(request, env, url, tokenHash) {
  if (!env.FILES) return text('R2-Bucket "FILES" fehlt (siehe SETUP-SYNC.md)', 500);

  const rec = await readVault(env);
  if (!rec) return text('kein Vault angelegt', 409);
  if (rec.tokenHash !== tokenHash) return text('forbidden', 403);

  const key = decodeURIComponent(url.pathname.slice('/files/'.length));
  if (!key || key.includes('..') || key.split('/').length !== 2) return text('bad key', 400);

  if (request.method === 'GET') {
    const obj = await env.FILES.get(key);
    if (!obj) return text('not found', 404);
    return new Response(obj.body, {
      headers: corsHeaders({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(obj.size) }),
    });
  }
  if (request.method === 'PUT') {
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_FILE_BYTES) return text('too large', 413);
    await env.FILES.put(key, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
    return json({ ok: true });
  }
  if (request.method === 'DELETE') {
    await env.FILES.delete(key);
    return json({ ok: true });
  }
  return text('method not allowed', 405);
}

// ---------- News-Monitor (viele Shops) ----------
//
// Konfiguration (Liste der Quellen) und Zustand (Schnappschüsse, Ereignisse, Status) liegen in
// getrennten KV-Einträgen: der Cron schreibt nur den Zustand, die App nur die Konfiguration.

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chf = (v) => (v == null ? 'Preis folgt' : 'CHF ' + Number(v).toFixed(2));
const FRANCHISES = [['Pokémon', /pok[eé]mon/i], ['One Piece', /one[\s\-_]*piece/i], ['Dragon Ball', /dragon[\s\-_]*ball/i]];
const franchiseOf = (hay) => (FRANCHISES.find(([, re]) => re.test(hay)) || [''])[0];

const DEFAULT_SOURCES = [{ id: 'wog', name: 'World of Games', url: 'https://www.wog.ch/de/index.cfm/lastAdded/platform/Trading-Cards', type: 'wog', filter: true }];

async function readCfg(env) {
  const s = await env.DB.get(CFG_KEY);
  return s ? JSON.parse(s) : { sources: DEFAULT_SOURCES.slice() };
}
async function readState(env) {
  const s = await env.DB.get(STATE_KEY);
  return s ? JSON.parse(s) : { snap: {}, src: {}, events: [] };
}

// Alle Adapter liefern [{ id, t, p, a, u, i, g }]: Titel, Preis, verfügbar (0/1), Link, Bild, Franchise.
async function getJson(url, init) {
  const res = await fetch(url, Object.assign({ headers: { 'User-Agent': WATCH_UA, Accept: 'application/json' } }, init || {}));
  if (!res.ok) throw new Error(new URL(url).host + ': HTTP ' + res.status);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(new URL(url).host + ': keine JSON-Antwort'); }
  return { data, bytes: text.length };
}

function shopifyApi(src) {
  const u = new URL(src.url);
  const m = u.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?collections\/([^/]+)/);
  return u.origin + (m ? '/collections/' + m[1] : '') + '/products.json';
}
const shopifyImg = (src) => (src ? src.replace(/(\.\w+)(\?.*)?$/, '_150x$1$2') : '');

async function fetchShopify(src) {
  const base = shopifyApi(src), origin = new URL(src.url).origin;
  const out = [];
  let pages = 0, bytes = 0, truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, bytes: b } = await getJson(base + '?limit=250&page=' + page);
    pages++; bytes += b;
    const list = data.products;
    if (!Array.isArray(list)) throw new Error(new URL(base).host + ': kein Shopify-Shop');
    for (const p of list) {
      const prices = (p.variants || []).map((v) => parseFloat(v.price)).filter((x) => x >= 0);
      const tagStr = Array.isArray(p.tags) ? p.tags.join(' ') : String(p.tags || '');
      const hay = [p.title, p.product_type, p.vendor, tagStr].join(' ');
      if (src.filter && !FRANCHISES.some(([, re]) => re.test(hay))) continue;
      out.push({
        id: String(p.id), t: p.title,
        p: prices.length ? Math.min(...prices) : null,
        a: (p.variants || []).some((v) => v.available) ? 1 : 0,
        u: origin + '/products/' + p.handle,
        i: shopifyImg(p.images && p.images[0] && p.images[0].src),
        g: franchiseOf(hay),
      });
    }
    if (list.length < 250) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { list: out, pages, bytes, truncated };
}

async function fetchWog(src) {
  const { data, bytes } = await getJson(WOG_LIST, {
    method: 'POST',
    headers: {
      'User-Agent': WATCH_UA, Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': 'https://www.wog.ch/de/index.cfm/lastAdded/platform/Trading-Cards',
    },
    body: 'listType=lastAdded&platform=Trading-Cards&maxRows=48&page=1',
  });
  if (!Array.isArray(data.products)) throw new Error('wog.ch: unerwartetes Antwortformat');
  const list = data.products
    .filter((p) => !src.filter || FRANCHISES.some(([, re]) => re.test(p.title || p.fullTitle || '')))
    .map((p) => ({
      id: String(p.productID), t: p.fullTitle || p.title,
      p: p.unitPrice > 0 ? p.unitPrice : null,
      a: p.deliveryClass === 'circle-grey' ? 0 : 1,
      u: p.linkTo,
      i: p.coverSmallImage ? 'https://www.wog.ch' + p.coverSmallImage : '',
      g: franchiseOf(p.fullTitle || p.title || ''),
    }));
  return { list, pages: 1, bytes };
}

const fetchSource = (src) => (src.type === 'wog' ? fetchWog(src) : fetchShopify(src));

// Shopify-Shop? Dann Typ + Name zurückgeben.
async function detectSource(url) {
  let u;
  try { u = new URL(url.includes('://') ? url : 'https://' + url); } catch (e) { throw new Error('keine gültige URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('keine gültige URL');
  const host = u.hostname.replace(/^www\./, '');
  const name = host.replace(/\.(ch|com|de|net|shop|store)$/, '');
  if (/(^|\.)wog\.ch$/.test(host)) return { type: 'wog', url: DEFAULT_SOURCES[0].url, name: 'World of Games' };
  const probe = { url: u.href };
  try {
    const { data } = await getJson(shopifyApi(probe) + '?limit=1');
    if (Array.isArray(data.products)) return { type: 'shopify', url: u.origin + u.pathname.replace(/\/+$/, ''), name };
  } catch (e) { /* weiter */ }
  throw new Error('Shop-Typ nicht erkannt (unterstützt: Shopify-Shops, wog.ch)');
}

// ---- Vergleich: neu / Preis / wieder verfügbar ----
function diff(src, list, prev, init, now) {
  const next = Object.assign({}, prev);
  const events = [];
  for (const it of list) {
    const old = prev[it.id];
    if (init) {
      const ev = { s: src.name, id: it.id, t: it.t, p: it.p, a: it.a, u: it.u, i: it.i, g: it.g, at: now };
      if (!old) events.push(Object.assign({ k: 'new' }, ev));
      else {
        if (old[0] != null && it.p != null && Math.abs(old[0] - it.p) > 0.004) events.push(Object.assign({ k: 'price', o: old[0] }, ev));
        if (old[1] === 0 && it.a === 1) events.push(Object.assign({ k: 'stock' }, ev));
      }
    }
    next[it.id] = [it.p, it.a];
  }
  return { next, events };
}

const KIND_LABEL = { new: 'Neu', price: 'Preisänderung', stock: 'Wieder verfügbar' };
function describe(ev) {
  if (ev.k === 'price') return chf(ev.o) + ' → ' + chf(ev.p) + (ev.p < ev.o ? ' ▼' : ' ▲');
  return chf(ev.p) + (ev.k === 'new' ? (ev.a ? ' · verfügbar' : ' · ausverkauft') : ' · wieder verfügbar');
}

async function sendMail(env, events, test) {
  const to = (env.NEWS_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!env.RESEND_API_KEY || !to.length) return { skipped: true };
  const shown = events.slice(0, 80), more = events.length - shown.length;
  const row = (ev) =>
    '<tr><td style="padding:9px 0;border-bottom:1px solid #eee">' +
    '<span style="font-size:11px;color:#777;text-transform:uppercase">' + esc(KIND_LABEL[ev.k]) + ' · ' + esc(ev.s) + '</span><br>' +
    '<a href="' + esc(ev.u) + '" style="font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none">' + esc(ev.t) + '</a><br>' +
    '<span style="color:#555;font-size:14px">' + esc(describe(ev)) + '</span><br>' +
    '<a href="' + esc(ev.u) + '" style="font-size:13px;color:#0b6bcb">' + esc(ev.u) + '</a></td></tr>';
  const count = (k) => events.filter((e) => e.k === k).length;
  const parts = [['new', 'neu'], ['price', 'Preis'], ['stock', 'wieder verfügbar']].filter(([k]) => count(k)).map(([k, l]) => count(k) + ' ' + l);
  const html = '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:580px">' +
    '<h2 style="margin:0 0 4px">' + (test ? 'Testmail – ' : '') + esc(parts.join(' · ')) + '</h2>' +
    '<p style="color:#777;margin:0 0 12px;font-size:13px">Pokémon / One Piece / Dragon Ball</p>' +
    '<table style="border-collapse:collapse;width:100%">' + shown.map(row).join('') + '</table>' +
    (more > 0 ? '<p style="color:#777">… und ' + more + ' weitere in der App unter News.</p>' : '') + '</div>';
  const textBody = shown.map((ev) => '[' + KIND_LABEL[ev.k] + ' · ' + ev.s + '] ' + ev.t + '\n' + describe(ev) + '\n' + ev.u).join('\n\n');
  const subject = (test ? 'Test: ' : '') +
    (events.length === 1 ? KIND_LABEL[events[0].k] + ': ' + events[0].t + ' (' + events[0].s + ')' : events.length + ' News: ' + parts.join(', '));
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.NEWS_FROM || 'Yingway News <onboarding@resend.dev>', to, subject, html, text: textBody }),
  });
  if (!res.ok) throw new Error('Resend: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return { sent: to.length };
}

// Eine Prüfrunde: die am längsten ungeprüften Quellen, solange das Budget (Anfragen/Datenmenge)
// reicht. Neue Quellen: erster Lauf nur Schnappschuss, keine Ereignisse.
async function runWatch(env) {
  const now = new Date().toISOString();
  const cfg = await readCfg(env);
  const state = await readState(env);
  const mailOn = !!env.RESEND_API_KEY && !!env.NEWS_TO;

  const todo = cfg.sources.filter((s) => !s.off)
    .sort((a, b) => ((state.src[a.id] || {}).lastCheck || '').localeCompare((state.src[b.id] || {}).lastCheck || ''));
  const batch = [];
  let pagesLeft = RUN_SUBREQ, bytesLeft = RUN_BYTES;
  for (const s of todo) {
    const h = state.src[s.id] || {};
    const pg = h.pages || 1, by = h.bytes || 300000;
    if (batch.length && (pg > pagesLeft || by > bytesLeft)) continue;
    batch.push(s); pagesLeft -= pg; bytesLeft -= by;
  }

  const results = await Promise.all(batch.map(async (s) => {
    try { return { s, r: await fetchSource(s) }; } catch (e) { return { s, err: e.message }; }
  }));

  const events = [];
  const commits = []; // [sourceId, nextSnap, st, nEvents]
  for (const { s, r, err } of results) {
    const st = Object.assign({}, state.src[s.id], { lastCheck: now });
    if (err) { st.lastError = err; state.src[s.id] = st; continue; }
    const d = diff(s, r.list, state.snap[s.id] || {}, !!st.init, now);
    Object.assign(st, { lastOk: now, lastError: r.truncated ? 'sehr grosse Kollektion – nur die ersten ' + (MAX_PAGES * 250) + ' Produkte' : null,
      count: r.list.length, pages: r.pages, bytes: r.bytes, init: true });
    commits.push([s.id, d.next, st, d.events.length]);
    events.push(...d.events);
  }

  let mailErr = null;
  if (events.length && mailOn) {
    try { await sendMail(env, events, false); state.lastMail = now; } catch (e) { mailErr = e.message; }
  }
  // Schlug die Mail fehl, bleibt der alte Schnappschuss der betroffenen Quellen -> nächster Lauf versucht es erneut.
  for (const [id, next, st, n] of commits) {
    if (mailErr && n) { st.lastError = 'Mail fehlgeschlagen, neuer Versuch folgt'; state.src[id] = st; continue; }
    state.snap[id] = next; state.src[id] = st;
  }
  if (!mailErr && events.length) state.events = events.concat(state.events).slice(0, EVENTS_KEEP);
  state.lastRun = now;
  state.lastError = mailErr;
  // Gelöschte Quellen aufräumen
  const ids = new Set(cfg.sources.map((s) => s.id));
  for (const k of Object.keys(state.snap)) if (!ids.has(k)) { delete state.snap[k]; delete state.src[k]; }
  await env.DB.put(STATE_KEY, JSON.stringify(state));
  return { cfg, state };
}

async function handleNews(request, env, url, tokenHash) {
  const rec = await readVault(env);
  if (!rec) return text('kein Vault angelegt', 409);
  if (rec.tokenHash !== tokenHash) return text('forbidden', 403);

  const view = (cfg, st) => json({
    sources: cfg.sources.map((s) => Object.assign({}, s, { st: st.src[s.id] || null })),
    events: (st.events || []).slice(0, 300),
    lastRun: st.lastRun || null, lastError: st.lastError || null, lastMail: st.lastMail || null,
    mail: !!env.RESEND_API_KEY && !!env.NEWS_TO,
  });
  const path = url.pathname, m = request.method;

  if (path === '/news' && m === 'GET') return view(await readCfg(env), await readState(env));
  if (path === '/news/check' && m === 'POST') { const r = await runWatch(env); return view(r.cfg, r.state); }

  if (path === '/news/test' && m === 'POST') {
    const st = await readState(env);
    const evs = st.events.length ? st.events.slice(0, 3)
      : [{ k: 'new', s: 'Testshop', t: 'Beispiel-Produkt (Testmail)', p: 19.9, a: 1, u: 'https://example.com/' }];
    try {
      const r = await sendMail(env, evs, true);
      if (r.skipped) return json({ error: 'Mail nicht eingerichtet (RESEND_API_KEY / NEWS_TO fehlt)' }, 400);
      return json({ ok: true, sent: r.sent });
    } catch (e) { return json({ error: e.message }, 502); }
  }

  if (path === '/news/sources' && m === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) { return text('bad json', 400); }
    const urls = (Array.isArray(body.urls) ? body.urls : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
    const cfg = await readCfg(env);
    const results = [];
    for (const raw of urls) {
      try {
        if (cfg.sources.length >= MAX_SOURCES) throw new Error('maximal ' + MAX_SOURCES + ' Quellen');
        const d = await detectSource(raw);
        const key = d.type === 'wog' ? 'wog' : shopifyApi(d);
        if (cfg.sources.some((s) => (s.type === 'wog' ? 'wog' : shopifyApi(s)) === key)) throw new Error('schon vorhanden');
        const id = d.type === 'wog' ? 'wog' : crypto.randomUUID().slice(0, 8);
        const filter = body.filter !== false && !FRANCHISES.some(([, re]) => re.test(d.url));
        cfg.sources.push({ id, name: d.name, url: d.url, type: d.type, filter });
        results.push({ url: raw, ok: true, name: d.name, type: d.type, filter });
      } catch (e) { results.push({ url: raw, ok: false, error: e.message }); }
    }
    await env.DB.put(CFG_KEY, JSON.stringify(cfg));
    return json({ results });
  }

  const sm = path.match(/^\/news\/sources\/([\w-]+)$/);
  if (sm) {
    const cfg = await readCfg(env);
    const i = cfg.sources.findIndex((s) => s.id === sm[1]);
    if (i < 0) return text('not found', 404);
    if (m === 'DELETE') cfg.sources.splice(i, 1);
    else if (m === 'PUT') {
      let body;
      try { body = await request.json(); } catch (e) { return text('bad json', 400); }
      const s = cfg.sources[i];
      if (typeof body.name === 'string' && body.name.trim()) s.name = body.name.trim().slice(0, 60);
      if (typeof body.off === 'boolean') s.off = body.off;
      if (typeof body.filter === 'boolean' && body.filter !== s.filter) { s.filter = body.filter; const st = await readState(env); delete st.src[s.id].init; delete st.snap[s.id]; await env.DB.put(STATE_KEY, JSON.stringify(st)); }
    } else return text('method not allowed', 405);
    await env.DB.put(CFG_KEY, JSON.stringify(cfg));
    return view(cfg, await readState(env));
  }
  return text('not found', 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return text('', 204);
    if (!env.DB) return text('KV binding "DB" fehlt', 500);

    const url = new URL(request.url);
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return text('missing token', 401);
    const tokenHash = await sha256hex(token);

    if (url.pathname === '/vault') return handleVault(request, env, tokenHash);
    if (url.pathname.startsWith('/files/')) return handleFiles(request, env, url, tokenHash);
    if (url.pathname === '/news' || url.pathname.startsWith('/news/')) return handleNews(request, env, url, tokenHash);
    return text('not found', 404);
  },

  async scheduled(event, env, ctx) {
    if (env.DB) ctx.waitUntil(runWatch(env));
  },
};
