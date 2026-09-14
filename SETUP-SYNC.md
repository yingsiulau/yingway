# Geräteübergreifende Synchronisation einrichten

Ziel: du und dein Bruder seht denselben Datenstand. Dein Bruder braucht dafür
**nur die Adresse der Seite und die gemeinsame Passphrase** – keinen Account,
keine Zugangsdaten von dir.

Dazu läuft ein winziger **Cloudflare Worker** (Gratis-Tarif), der genau einen
verschlüsselten Datenblock speichert. Der Worker sieht nie Klartext.

Einmalig einzurichten – nur von dir, ~10 Minuten:

## 1. Cloudflare-Konto

Kostenloses Konto auf https://dash.cloudflare.com/sign-up anlegen (keine
Kreditkarte nötig).

## 2. Worker deployen

```bash
cd /Users/ylau/Yingway/worker

# Wrangler (Cloudflare-CLI) – einmalig
npm install -g wrangler        # oder jeden Befehl unten mit  npx  davor

wrangler login                 # öffnet den Browser, einmal bestätigen

# KV-Speicher anlegen – gibt eine id aus:
wrangler kv namespace create DB
# (ältere Wrangler-Versionen:  wrangler kv:namespace create DB )
```

Die ausgegebene `id` in `worker/wrangler.toml` bei `HIER_KV_NAMESPACE_ID_EINTRAGEN`
eintragen. Dann:

```bash
wrangler deploy
```

Am Ende steht eine URL, z. B.
`https://yingway-sync.deinname.workers.dev`

## 3. App auf den Worker zeigen

In `sync.config.js` (Repo-Wurzel) die URL eintragen – **mit `/vault` am Ende**:

```js
window.__SYNC_URL__ = "https://yingway-sync.deinname.workers.dev/vault";
```

Committen und pushen:

```bash
cd /Users/ylau/Yingway
git add sync.config.js && git commit -m "Sync aktivieren" && git push
```

## 4. Daten das erste Mal hochladen

1. https://yingsiulau.github.io/yingway/ öffnen
2. Passphrase festlegen (mind. 10 Zeichen – **diese** bekommt dein Bruder)
3. Übersicht → **Daten & Sicherung** → **Backup einspielen** → `seed.plain.json`
4. Bestätigen. Die Daten werden verschlüsselt in die Cloud geschoben
   (Statusanzeige „Sync ✓" unten links).

## 5. Bruder

Er öffnet dieselbe Adresse, gibt die Passphrase ein – fertig. Ab jetzt sehen
beide Geräte denselben Stand; Änderungen werden nach ~1 s abgeglichen und beim
Öffnen / Tab-Wechsel neu geladen.

---

## PDF-Belege aktivieren (optional)

Damit du bei Ein-/Ausgängen und laufenden Kosten einen PDF-Beleg anhängen und
sie gesammelt als ZIP herunterladen kannst, braucht der Worker zusätzlich
einen **R2-Bucket** (Cloudflare-Objektspeicher, Gratis-Tarif: 10 GB, keine
Transfergebühren). Belege werden – wie der Vault – im Browser AES-256-GCM
verschlüsselt hochgeladen; der Worker/R2 sieht nur Chiffretext.

Einmalig, nur von dir:

```bash
cd /Users/ylau/Yingway/worker
wrangler r2 bucket create yingway-files
wrangler deploy
```

`worker/wrangler.toml` hat den nötigen `[[r2_buckets]]`-Block schon (Binding
`FILES`, Bucket-Name `yingway-files`) – `wrangler deploy` reicht danach aus.
Kein Eintrag in `sync.config.js` nötig, die App erkennt R2 automatisch, sobald
`wrangler deploy` durch ist (Seite einmal neu laden).

In den Formularen erscheint dann bei Eingängen/Ausgängen/laufenden Kosten ein
Feld „Beleg (PDF)" (max. 15 MB), in der Tabelle ein kleines PDF-Symbol bei
Einträgen mit Anhang, und in der Übersicht die Karte **„Belege"** zum
gesammelten ZIP-Export nach Journal + Zeitraum.

---

## Sicherheit & Grenzen

- **Ende-zu-Ende verschlüsselt**: der Worker speichert nur AES-256-GCM-Chiffretext.
  Ohne Passphrase ist nichts lesbar. Jede Anfrage muss ein aus der Passphrase
  abgeleitetes Token (SHA-256) mitschicken – der Worker kennt davon nur den Hash.
- **Kein echtes 2FA** – bei statischem Hosting technisch nicht möglich. Sicherheit
  = Stärke der Passphrase. Nimm eine lange (4–5 Wörter).
- **Konflikt**: ändern beide *gleichzeitig* auf verschiedenen Geräten, gewinnt der
  erste Schreibvorgang; das andere Gerät zeigt „Konflikt" + „Neu laden". Bei
  abwechselnder Nutzung passiert das praktisch nie.
- **KV ist eventual consistent**: nach einer Änderung kann es bis ~60 s dauern,
  bis ein anderes Gerät sie sieht.
- Kosten: Cloudflare-Gratis-Tarif (100 000 Anfragen/Tag) reicht um Grössenordnungen.
- Passphrase wechseln: geht in der App, aber der andere muss die neue dann auch
  eingeben (steht als Warnung dabei).
