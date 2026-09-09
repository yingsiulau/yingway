/* Adresse des Sync-Workers.
 *
 * Solange leer, laeuft die App nur lokal (localStorage, pro Browser).
 * Nach dem Worker-Deploy hier die URL eintragen, committen, pushen –
 * dann synchronisieren alle Geraete mit derselben Passphrase.
 *
 * Beispiel:
 *   window.__SYNC_URL__ = "https://yingway-sync.deinname.workers.dev/vault";
 */
window.__SYNC_URL__ = "https://yingway-sync.ying-tgc.workers.dev/vault";
