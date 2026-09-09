/*
 * Yingway Sync – Cloudflare Worker
 *
 * Speichert genau EINEN verschlüsselten Datenblock ("vault") in KV.
 * Der Worker sieht nie Klartext: der Body ist bereits AES-256-GCM-
 * verschlüsselt (mit der Passphrase, die nur im Browser existiert).
 *
 * Zugriff: jede Anfrage muss  Authorization: Bearer <token>  mitschicken.
 *   token = SHA-256("yingway|" + passphrase)   (im Browser berechnet)
 * Der Worker kennt nur SHA-256(token) und kann daraus die Passphrase
 * nicht zurückrechnen. Wer die Passphrase kennt, darf lesen + schreiben,
 * sonst niemand.
 *
 * Endpunkte:
 *   GET  /vault           -> { rev, blob, updatedAt }   (blob=null wenn leer)
 *   PUT  /vault           Body { blob, baseRev }
 *                         -> 200 { rev, updatedAt }
 *                         -> 409 { error:"conflict", rev, blob }  (anderes Gerät war schneller)
 *                         -> 403  falsche Passphrase für vorhandene Daten
 */

const KV_KEY = 'vault';

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return text('', 204);

    const url = new URL(request.url);
    if (url.pathname !== '/vault') return text('not found', 404);
    if (!env.DB) return text('KV binding "DB" fehlt', 500);

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return text('missing token', 401);
    const tokenHash = await sha256hex(token);

    const stored = await env.DB.get(KV_KEY);
    const rec = stored ? JSON.parse(stored) : null;

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
      if (body.blob.length > 20 * 1024 * 1024) return text('too large', 413);

      const curRev = rec ? rec.rev : 0;
      const baseRev = Number(body.baseRev || 0);
      if (baseRev !== curRev)
        return json({ error: 'conflict', rev: curRev, blob: rec ? rec.blob : null }, 409);

      const next = {
        blob: body.blob,
        rev: curRev + 1,
        updatedAt: new Date().toISOString(),
        tokenHash,
      };
      await env.DB.put(KV_KEY, JSON.stringify(next));
      return json({ rev: next.rev, updatedAt: next.updatedAt });
    }

    return text('method not allowed', 405);
  },
};
