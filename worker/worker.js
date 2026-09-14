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
 */

const KV_KEY = 'vault';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
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
    return text('not found', 404);
  },
};
