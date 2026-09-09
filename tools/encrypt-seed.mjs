#!/usr/bin/env node
/*
 * Verschlüsselt seed.plain.json -> seed.enc.js  (window.__SEED__ = "<base64>")
 *
 * Format (identisch mit index.html):
 *   base64( salt[16] || iv[12] || AES-256-GCM ciphertext )
 *   Schlüssel: PBKDF2-SHA256, 250'000 Runden
 *
 * Aufruf:
 *   PASSPHRASE="deine-passphrase" node tools/encrypt-seed.mjs
 * oder ohne Env-Variable – dann wird verdeckt danach gefragt.
 *
 * seed.plain.json bleibt lokal und wird NICHT committet (.gitignore).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAIN = join(root, 'seed.plain.json');
const OUT   = join(root, 'seed.enc.js');
const ITER  = 250000;

async function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r' || char === '') process.stdout.write('\n');
      else process.stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(question, (value) => { process.stdin.removeListener('data', onData); rl.close(); resolve(value); });
  });
}

const passphrase =
  process.env.PASSPHRASE ||
  (await askHidden('Passphrase für die Verschlüsselung: '));

if (!passphrase || passphrase.length < 10) {
  console.error('\nAbbruch: Passphrase fehlt oder ist kürzer als 10 Zeichen.');
  process.exit(1);
}

let plain;
try {
  plain = JSON.parse(readFileSync(PLAIN, 'utf8'));
} catch (e) {
  console.error(`\nKonnte ${PLAIN} nicht lesen: ${e.message}`);
  process.exit(1);
}

// nur die drei Journale übernehmen, in der Form, die die App erwartet
const payload = {
  wareneingang:    plain.wareneingang    || [],
  warenausgang:    plain.warenausgang    || [],
  laufende_kosten: plain.laufende_kosten || [],
  _encoded: new Date().toISOString(),
};

const subtle = globalThis.crypto.subtle;
const encU8 = new TextEncoder().encode(JSON.stringify(payload));

const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
const iv   = globalThis.crypto.getRandomValues(new Uint8Array(12));

const baseKey = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
const key = await subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
  baseKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt'],
);
const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, encU8));

const blob = new Uint8Array(salt.length + iv.length + ct.length);
blob.set(salt, 0);
blob.set(iv, salt.length);
blob.set(ct, salt.length + iv.length);
const b64 = Buffer.from(blob).toString('base64');

writeFileSync(OUT,
  `/* Automatisch erzeugt von tools/encrypt-seed.mjs am ${new Date().toISOString()}.\n` +
  `   AES-256-GCM, PBKDF2-SHA256 (${ITER} Runden). Entschlüsselung nur im Browser mit der Passphrase. */\n` +
  `window.__SEED__ = ${JSON.stringify(b64)};\n`);

const n = payload.wareneingang.length + payload.warenausgang.length + payload.laufende_kosten.length;
console.log(`\nOK  ->  seed.enc.js  (${n} Einträge, ${b64.length} Zeichen Base64)`);
console.log('Jetzt:  git add seed.enc.js && git commit -m "Daten aktualisiert" && git push');
