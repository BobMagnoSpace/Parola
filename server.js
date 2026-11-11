// Parola — server: login, partite e statistiche per la famiglia.
// Nessuna dipendenza esterna: usa solo Node (>= 22.13) e il suo SQLite integrato.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "parola.db");
const INVITE_CODE = (process.env.INVITE_CODE || "").trim();
const SESSION_DAYS = 365;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day INTEGER NOT NULL,
    guesses TEXT NOT NULL,
    done INTEGER NOT NULL,
    won INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  );
  CREATE TABLE IF NOT EXISTS base (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

// Rinumerazione una tantum: si toglie la partita N° 1 (1° novembre) e tutte le altre scalano di uno,
// così il 2 novembre diventa la N° 1.
if (!db.prepare("SELECT v FROM meta WHERE k = 'days2'").get()) {
  db.exec("BEGIN");
  try {
    const del = db.prepare("DELETE FROM games WHERE day = 1").run().changes;
    db.exec("UPDATE games SET day = -day");
    db.exec("UPDATE games SET day = -day - 1");
    db.prepare("INSERT INTO meta (k, v) VALUES ('days2', ?)").run(new Date().toISOString());
    db.exec("COMMIT");
    console.log(`Rinumerazione fatta: tolte ${del} partite del giorno 1, le altre scalate di uno`);
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

const q = {
  userByName: db.prepare("SELECT * FROM users WHERE name = ?"),
  addUser: db.prepare("INSERT INTO users (name, pass, created) VALUES (?, ?, ?)"),
  setPass: db.prepare("UPDATE users SET pass = ? WHERE id = ?"),
  addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created) VALUES (?, ?, ?)"),
  session: db.prepare("SELECT u.id, u.name, u.pass, s.created FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"),
  delSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  oldSessions: db.prepare("DELETE FROM sessions WHERE created < ?"),
  games: db.prepare("SELECT day, guesses, done, won FROM games WHERE user_id = ?"),
  game: db.prepare("SELECT guesses, done FROM games WHERE user_id = ? AND day = ?"),
  putGame: db.prepare(`INSERT INTO games (user_id, day, guesses, done, won, updated) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET guesses = excluded.guesses, done = excluded.done, won = excluded.won, updated = excluded.updated`),
  base: db.prepare("SELECT data FROM base WHERE user_id = ?"),
  group: db.prepare("SELECT u.id, u.name, g.day, g.guesses, g.done, g.won FROM users u LEFT JOIN games g ON g.user_id = u.id ORDER BY u.id, g.day"),
  putBase: db.prepare("INSERT INTO base (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data"),
  delBase: db.prepare("DELETE FROM base WHERE user_id = ?"),
};

// ---- password ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return "s1$" + salt.toString("hex") + "$" + hash.toString("hex");
}
function checkPassword(pw, stored) {
  const [v, saltHex, hashHex] = String(stored).split("$");
  if (v !== "s1" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- tentativi di accesso: massimo 20 ogni 15 minuti per indirizzo ----
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { n: 0, reset: now + 15 * 60e3 }; attempts.set(ip, a); }
  a.n++;
  return a.n > 20;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip);
  q.oldSessions.run(now - SESSION_DAYS * 864e5);
}, 60 * 60e3).unref();

// ---- helpers ----
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const fail = (res, code, msg) => json(res, code, { error: msg });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 16384) { reject(new Error("big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("json")); } });
    req.on("error", reject);
  });
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const isProd = process.env.NODE_ENV === "production";
function sessionCookie(token, maxAgeSec) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isProd ? "; Secure" : ""}`;
}
function currentUser(req) {
  const t = cookies(req).sid;
  if (!t) return null;
  const row = q.session.get(sha(t));
  if (!row || row.created < Date.now() - SESSION_DAYS * 864e5) return null;
  return row;
}
function startSession(res, userId, name) {
  const token = crypto.randomBytes(32).toString("base64url");
  q.addSession.run(sha(token), userId, Date.now());
  json(res, 200, { name }, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{1,19}$/u;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// ---- pagina ----
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const INDEX_ETAG = '"' + sha(INDEX).slice(0, 16) + '"';
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// ---- routes ----
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname, m = req.method;
  const ip = req.headers["fly-client-ip"] || req.socket.remoteAddress || "?";

  if (m === "GET" && (p === "/" || p === "/index.html")) {
    if (req.headers["if-none-match"] === INDEX_ETAG) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: INDEX_ETAG, ...SEC_HEADERS });
    return res.end(INDEX);
  }
  if (m === "GET" && p === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (!p.startsWith("/api/")) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Pagina non trovata"); }

  // Le richieste che modificano dati devono arrivare da questa stessa pagina.
  if (m !== "GET") {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, "Richiesta non permessa");
  }

  let body = {};
  if (m === "POST" || m === "PUT") {
    try { body = await readBody(req); } catch { return fail(res, 400, "Richiesta non valida"); }
  }

  if (m === "POST" && p === "/api/register") {
    if (limited(ip)) return fail(res, 429, "Troppi tentativi. Riprova tra un quarto d'ora.");
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    const pw = String(body.password || "");
    if (INVITE_CODE && String(body.invite || "").trim().toLowerCase() !== INVITE_CODE.toLowerCase()) return fail(res, 403, "Il codice famiglia non è giusto.");
    if (!NAME_RE.test(name)) return fail(res, 400, "Il nome deve avere da 2 a 20 caratteri: lettere, numeri e spazi.");
    if (pw.length < 6 || pw.length > 100) return fail(res, 400, "La password deve avere almeno 6 caratteri.");
    if (q.userByName.get(name)) return fail(res, 409, "Questo nome è già usato. Scegline un altro.");
    const r = q.addUser.run(name, hashPassword(pw), Date.now());
    return startSession(res, Number(r.lastInsertRowid), name);
  }
  if (m === "POST" && p === "/api/login") {
    if (limited(ip)) return fail(res, 429, "Troppi tentativi. Riprova tra un quarto d'ora.");
    const u = q.userByName.get(String(body.name || "").trim().replace(/\s+/g, " "));
    if (!u || !checkPassword(String(body.password || ""), u.pass)) return fail(res, 401, "Nome o password sbagliati.");
    return startSession(res, u.id, u.name);
  }
  if (m === "POST" && p === "/api/logout") {
    const t = cookies(req).sid; if (t) q.delSession.run(sha(t));
    return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  const user = currentUser(req);
  if (!user) return fail(res, 401, "Accedi per continuare.");

  if (m === "GET" && p === "/api/me") {
    const games = q.games.all(user.id).map((g) => ({ day: g.day, guesses: JSON.parse(g.guesses), done: !!g.done, won: !!g.won }));
    const b = q.base.get(user.id);
    return json(res, 200, { name: user.name, games, base: b ? JSON.parse(b.data) : null });
  }
  // Classifica di famiglia: solo numeri, mai le parole scritte.
  if (m === "GET" && p === "/api/group") {
    const people = new Map();
    for (const r of q.group.all()) {
      if (!people.has(r.id)) people.set(r.id, { name: r.name, me: r.id === user.id, games: [] });
      if (r.day != null) people.get(r.id).games.push({ day: r.day, done: !!r.done, won: !!r.won, n: JSON.parse(r.guesses).length });
    }
    return json(res, 200, { people: [...people.values()] });
  }
  let mm;
  // Una pagina aperta prima della rinumerazione userebbe i numeri vecchi: le chiediamo di ricaricarsi.
  if (m !== "GET" && req.headers["x-parola-days"] !== "2") return fail(res, 426, "Il gioco è stato aggiornato: ricarica la pagina.");
  if (m === "PUT" && (mm = p.match(/^\/api\/game\/(\d{1,6})$/))) {
    const day = Number(mm[1]);
    const g = body.guesses;
    if (!int(day, 1, 999999) || !Array.isArray(g) || g.length > 6 || !g.every((w) => typeof w === "string" && /^[a-z]{5}$/.test(w))) return fail(res, 400, "Partita non valida.");
    const done = !!body.done, won = !!body.won;
    const prev = q.game.get(user.id, day);
    if (prev) {
      const pg = JSON.parse(prev.guesses);
      // Una partita finita non si cambia, e i tentativi già fatti non si cancellano.
      if (prev.done || g.length < pg.length || pg.some((w, i) => g[i] !== w)) return fail(res, 409, "Questa partita è già stata salvata.");
    }
    q.putGame.run(user.id, day, JSON.stringify(g), done ? 1 : 0, won ? 1 : 0, Date.now());
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, "Non trovato.");
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) fail(res, 500, "Errore del server. Riprova."); else res.end(); });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Parola in ascolto sulla porta ${PORT}` + (INVITE_CODE ? "" : " — ATTENZIONE: nessun INVITE_CODE, chiunque può registrarsi"));
});
