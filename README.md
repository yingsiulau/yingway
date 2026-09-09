# Yingway Buchhaltung

Einseitige Web-App zur Verwaltung von Ein- und Ausgängen im Sammelkarten-Handel
(Wareneingang, Warenausgang, laufende Kosten, Lager & Marge).

- **Statische Seite**, lauffähig auf GitHub Pages – ohne Backend nutzbar.
- **Daten bleiben verschlüsselt.** Alle Einträge werden AES-256-GCM-verschlüsselt in
  `localStorage` gespeichert und beim Öffnen mit deiner Passphrase entschlüsselt.
- **Optionaler Geräte-Sync** über einen kleinen Cloudflare Worker (Ende-zu-Ende
  verschlüsselt): mehrere Personen sehen denselben Stand, ganz ohne Account –
  nur Adresse + gemeinsame Passphrase. Einrichtung: **[SETUP-SYNC.md](SETUP-SYNC.md)**.
- **Die Echtdaten im Repo sind verschlüsselt** (`seed.enc.js`, Platzhalter bis du
  ihn füllst). Ohne Passphrase ist daraus nichts lesbar.

> ⚠️ Das ist Passwortschutz, **kein echtes 2FA**. Auf statischem Hosting gibt es
> keinen Server, der einen zweiten Faktor prüfen könnte. Die Sicherheit hängt an
> der Stärke der Passphrase (mind. 10 Zeichen, besser eine lange Passphrase).
> Wer die Seite öffnet, sieht ohne Passphrase nur einen verschlüsselten Datenblock.

## Live

https://yingsiulau.github.io/yingway/ (Settings → Pages → Source: **GitHub Actions**)

## Geräteübergreifend nutzen

Standardmässig liegen die Daten pro Browser. Für einen gemeinsamen Stand über
mehrere Geräte / Personen: **[SETUP-SYNC.md](SETUP-SYNC.md)** (Cloudflare Worker,
Gratis, ~10 Min). Danach genügt anderen Personen die Adresse + die Passphrase.

## Eigene Daten einspielen

Es gibt zwei Wege:

### A) In der App (empfohlen für laufenden Betrieb)
Übersicht → **Daten & Sicherung**:
- **Verschlüsseltes Backup** – lädt eine `.vault`-Datei herunter
- **Backup einspielen** – liest eine `.vault`- oder `.json`-Datei wieder ein
- **JSON-Export (offen)** – unverschlüsselt, für Excel/Treuhand
- **Passphrase ändern** / **Gerät zurücksetzen**

### B) Ins Bundle (damit die Daten von jedem Gerät aus verfügbar sind)
1. Klartextdaten als `seed.plain.json` ablegen (Format siehe unten). Diese Datei
   ist per `.gitignore` vom Repo ausgeschlossen und darf nie gepusht werden.
2. Verschlüsseln:
   ```bash
   PASSPHRASE="deine-lange-passphrase" node tools/encrypt-seed.mjs
   ```
   Das schreibt `seed.enc.js`.
3. Committen und pushen:
   ```bash
   git add seed.enc.js && git commit -m "Daten aktualisiert" && git push
   ```

Beim ersten Öffnen fragt die App nach der Passphrase, entschlüsselt `seed.enc.js`
und legt eine lokale verschlüsselte Kopie an. Danach läuft alles offline weiter.

## Datenformat (`seed.plain.json`)

```json
{
  "wareneingang":    [ { "id":"…","d":"2026-01-05","sku":"OP-16","cat":"One Piece","form":"Display","set":"OP-16","qty":2,"ek":127.9,"ship":0,"gross":255.8,"shop":"manashop.ch","person":"" } ],
  "warenausgang":    [ { "id":"…","d":"2026-01-18","sku":"OP-Bulk","cat":"One Piece","form":"Einzelkarten","set":"OP-Bulk","qty":57,"price":61,"cust":3.4,"fees":6.1,"porto":3.4,"net":54.9,"shop":"ricardo.ch","person":"Uglybuddha" } ],
  "laufende_kosten": [ { "id":"…","d":"2026-01-13","cat":"Verpackung","desc":"Luftpolsterumschläge","qty":1,"total":15.9,"shop":"","receipt":"RE-2026-004" } ]
}
```

`d` = Datum `YYYY-MM-DD`. Beträge in CHF. `id` = beliebige eindeutige Zeichenkette.

## Kennzahlen

- **Saldo** = Umsatz − Wareneinkauf − laufende Kosten (Kassensicht)
- **Ø EK/Stk** je SKU = gesamte Einkaufskosten brutto ÷ gesamte eingekaufte Menge
- **Realisierte Marge** = Nettoeinnahmen − (verkaufte Menge × Ø EK/Stk)
- **Warenwert Lager** = Restbestand × Ø EK/Stk

## Technik

Vanilla HTML/CSS/JS, eine Datei (`index.html`). Web Crypto API für die
Verschlüsselung. Schriften von Google Fonts. Keine Build-Tools nötig – das
Node-Skript dient nur zum Verschlüsseln des Seeds.
