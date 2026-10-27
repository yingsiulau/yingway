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
 * News-Monitor (wog.ch): ein Cron-Trigger (alle 10 Min.) fragt die Neuheiten-
 * Liste "Trading-Cards" ab, behält Pokémon / One Piece / Dragon Ball, merkt sich
 * gesehene Produkte in KV und schickt bei neuen eine Mail (Resend-API).
 *   GET  /news        -> { items, lastCheck, lastError, mail }
 *   POST /news/check  -> sofort prüfen, wie der Cron
 *   POST /news/test   -> Testmail mit den 3 neuesten Treffern
 *   Gleiche Passphrase-Auth wie /files. Mail nur, wenn das Secret RESEND_API_KEY
 *   gesetzt ist (siehe SETUP-SYNC.md); sonst läuft nur das Dashboard.
 */

const KV_KEY = 'vault';
const NEWS_KEY = 'news';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const WOG_LIST = 'https://www.wog.ch/de/index.cfm/ajax.productList';
const WOG_UA = 'Mozilla/5.0 (compatible; YingwayMonitor/1.0; +https://yingsiulau.github.io/yingway/)';
// Nur Treffer im Produkttitel (Gross-/Kleinschreibung egal, "Pokemon" ohne é geht auch).
const NEWS_FILTER = /pok[eé]mon|one\s*piece|dragon\s*ball/i;
const NEWS_KEEP = 300; // so viele Treffer bleiben im Dashboard
const NEWS_SEEN_KEEP = 1500;

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

// ---------- News-Monitor ----------

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function fetchWog() {
  const res = await fetch(WOG_LIST, {
    method: 'POST',
    headers: {
      'User-Agent': WOG_UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': 'https://www.wog.ch/de/index.cfm/lastAdded/platform/Trading-Cards',
    },
    body: 'listType=lastAdded&platform=Trading-Cards&maxRows=48&page=1',
  });
  if (!res.ok) throw new Error('wog.ch antwortet mit HTTP ' + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.products)) throw new Error('wog.ch: unerwartetes Antwortformat');
  return data.products
    .filter((p) => NEWS_FILTER.test(p.title || p.fullTitle || ''))
    .map((p) => ({
      id: p.productID,
      t: p.fullTitle || p.title,
      p: p.unitPrice > 0 ? p.unitPrice : null,
      s: p.deliveryText || '',
      c: p.deliveryClass || '',
      r: p.releaseDateOnly || '',
      u: p.linkTo,
      i: p.coverSmallImage ? 'https://www.wog.ch' + p.coverSmallImage : '',
    }));
}

const chf = (v) => (v == null ? 'Preis folgt' : 'CHF ' + v.toFixed(2));

async function sendMail(env, items, test) {
  const to = (env.NEWS_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!env.RESEND_API_KEY || !to.length) return { skipped: true };
  const rows = items.map((it) =>
    '<tr><td style="padding:10px 0;border-bottom:1px solid #eee">' +
    '<a href="' + esc(it.u) + '" style="font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none">' + esc(it.t) + '</a><br>' +
    '<span style="color:#555;font-size:14px">' + esc(chf(it.p)) + ' · ' + esc(it.s) + (it.r ? ' · ' + esc(it.r) : '') + '</span><br>' +
    '<a href="' + esc(it.u) + '" style="font-size:13px;color:#0b6bcb">' + esc(it.u) + '</a></td></tr>').join('');
  const html = '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">' +
    '<h2 style="margin:0 0 4px">' + (test ? 'Testmail – ' : '') + items.length + ' neue Treffer bei wog.ch</h2>' +
    '<p style="color:#777;margin:0 0 12px;font-size:13px">Trading-Cards · Pokémon / One Piece / Dragon Ball</p>' +
    '<table style="border-collapse:collapse;width:100%">' + rows + '</table></div>';
  const textBody = items.map((it) => it.t + '\n' + chf(it.p) + ' · ' + it.s + (it.r ? ' · ' + it.r : '') + '\n' + it.u).join('\n\n');
  const subject = (test ? 'Test: ' : '') + (items.length === 1 ? 'Neu bei wog.ch: ' + items[0].t : items.length + ' neue TCG-Produkte bei wog.ch');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.NEWS_FROM || 'Yingway News <onboarding@resend.dev>', to, subject, html, text: textBody }),
  });
  if (!res.ok) throw new Error('Resend: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return { sent: to.length };
}

async function readNews(env) {
  const stored = await env.DB.get(NEWS_KEY);
  return stored ? JSON.parse(stored) : null;
}

// Eine Prüfrunde. Erster Lauf: alles als "gesehen" markieren, keine Mail.
async function runNewsCheck(env) {
  const now = new Date().toISOString();
  const state = (await readNews(env)) || { seen: [], items: [], init: false };
  const mailOn = !!env.RESEND_API_KEY && !!env.NEWS_TO;
  state.lastCheck = now;
  try {
    const found = await fetchWog();
    const seen = new Set(state.seen);
    const fresh = found.filter((it) => !seen.has(it.id));
    const known = new Map(state.items.map((it) => [it.id, it]));

    // Status/Preis bereits bekannter Treffer aktuell halten (First-seen bleibt).
    for (const it of found) if (known.has(it.id)) Object.assign(known.get(it.id), it, { f: known.get(it.id).f });

    let mailErr = null;
    if (fresh.length && state.init && mailOn) {
      try { await sendMail(env, fresh, false); state.lastMail = now; }
      catch (e) { mailErr = e.message; }
    }
    // Schlug die Mail fehl, bleiben die Produkte "ungesehen" -> nächster Lauf versucht es erneut.
    if (!mailErr) fresh.forEach((it) => seen.add(it.id));
    for (const it of fresh) known.set(it.id, Object.assign({ f: now, n: state.init }, it));

    state.init = true;
    state.items = [...known.values()].sort((a, b) => b.id - a.id).slice(0, NEWS_KEEP);
    state.seen = [...seen].sort((a, b) => b - a).slice(0, NEWS_SEEN_KEEP);
    state.lastOk = now;
    state.lastError = mailErr;
  } catch (e) {
    state.lastError = e.message;
  }
  await env.DB.put(NEWS_KEY, JSON.stringify(state));
  return state;
}

async function handleNews(request, env, url, tokenHash) {
  const rec = await readVault(env);
  if (!rec) return text('kein Vault angelegt', 409);
  if (rec.tokenHash !== tokenHash) return text('forbidden', 403);

  const view = (st) => json({
    items: st.items || [], lastCheck: st.lastCheck || null, lastOk: st.lastOk || null,
    lastError: st.lastError || null, lastMail: st.lastMail || null,
    mail: !!env.RESEND_API_KEY && !!env.NEWS_TO,
  });

  if (url.pathname === '/news' && request.method === 'GET') {
    return view((await readNews(env)) || {});
  }
  if (url.pathname === '/news/check' && request.method === 'POST') {
    return view(await runNewsCheck(env));
  }
  if (url.pathname === '/news/test' && request.method === 'POST') {
    const st = (await readNews(env)) || (await runNewsCheck(env));
    try {
      const r = await sendMail(env, (st.items || []).slice(0, 3), true);
      if (r.skipped) return json({ error: 'Mail nicht eingerichtet (RESEND_API_KEY / NEWS_TO fehlt)' }, 400);
      return json({ ok: true, sent: r.sent });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
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
    if (env.DB) ctx.waitUntil(runNewsCheck(env));
  },
};
