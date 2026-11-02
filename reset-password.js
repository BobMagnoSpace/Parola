// Reimposta la password di un familiare che l'ha dimenticata.
// Uso (dal computer):  fly ssh console -C "node reset-password.js 'Nome' 'nuovapassword'"
"use strict";
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const [name, pw] = process.argv.slice(2);
if (!name || !pw || pw.length < 6) { console.log("Uso: node reset-password.js 'Nome' 'nuovapassword' (almeno 6 caratteri)"); process.exit(1); }
const db = new DatabaseSync(process.env.DB_PATH || "/data/parola.db");
const u = db.prepare("SELECT id, name FROM users WHERE name = ? COLLATE NOCASE").get(name);
if (!u) {
  console.log("Nessun utente con questo nome. Utenti:", db.prepare("SELECT name FROM users ORDER BY name").all().map(r => r.name).join(", ") || "(nessuno)");
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
db.prepare("UPDATE users SET pass = ? WHERE id = ?").run("s1$" + salt.toString("hex") + "$" + hash.toString("hex"), u.id);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
console.log("Password aggiornata per " + u.name);
