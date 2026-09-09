/* Platzhalter.
 *
 * Dieser Wert wird von  tools/encrypt-seed.mjs  mit deinen
 * AES-GCM-verschluesselten Buchhaltungsdaten ueberschrieben.
 * Solange er null ist, startet die App im Ersteinrichtungs-Modus
 * (leere Buchhaltung, neue Passphrase festlegen).
 *
 * Ablauf:
 *   1.  seed.plain.json  liegt lokal (per .gitignore vom Repo ausgeschlossen)
 *   2.  PASSPHRASE="deine-passphrase" node tools/encrypt-seed.mjs
 *   3.  git add seed.enc.js && git commit -m "Daten" && git push
 */
window.__SEED__ = null;
