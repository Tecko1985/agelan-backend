// ===========================================================================
// agelan-backend – Konten, Tickets, Sitzplan, Reservierungsgruppen, Check-in.
//
// Cloudflare Worker + D1 (SQLite). Alles läuft über EINEN Endpunkt:
//   POST /api   { aktion: "...", ...daten }   Authorization: Bearer <token>
//
// Bindings / Secrets (im Cloudflare-Dashboard bei DIESEM Worker):
//   DB            (D1)     = die Datenbank. Das Schema legt der Worker beim
//                            ersten Aufruf selbst an (SCHEMA unten).
//   TOKEN_SECRET  (Secret) = Schlüssel für die Anmelde-Token. Lang + zufällig.
//   ADMIN_SETUP   (Secret) = Passwort, mit dem sich ein Konto einmalig zum
//                            Veranstalter macht (Konto → „Veranstalter werden“).
//   ORIGINS       (Var)    = erlaubte Browser-Herkünfte, kommagetrennt,
//                            z. B. "https://age-lan.de,https://tecko1985.github.io"
//
// Der Demo-Modus der Website (demo.js) lädt GENAU diese Datei im Browser und
// hängt sie an eine SQLite-Datenbank im Browser (sql.js). Deshalb: nur
// Web-Standards benutzen (fetch-API, crypto.subtle), nichts Worker-Spezifisches.
// ===========================================================================

const PW_MIN = 8;
const TOKEN_TAGE = 60;
const PBKDF2_RUNDEN = 100000; // Obergrenze in Workers
const ROLLEN = ["user", "orga", "admin"];
const ZAHLARTEN = { paypal: "PayPal (Freunde)", ueberweisung: "Überweisung", bar: "Bar" };

// ---------------------------------------------------------------------------
// Schema – jede Anweisung einzeln (D1 exec verträgt keine mehrzeiligen).
// ---------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nick TEXT NOT NULL, nick_key TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL, email_key TEXT NOT NULL UNIQUE,
    vorname TEXT NOT NULL DEFAULT '', nachname TEXT NOT NULL DEFAULT '',
    geburtsdatum TEXT NOT NULL DEFAULT '', discord TEXT NOT NULL DEFAULT '',
    pw TEXT NOT NULL, rolle TEXT NOT NULL DEFAULT 'user',
    gesperrt INTEGER NOT NULL DEFAULT 0, token_ver INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, start TEXT NOT NULL DEFAULT '', ende TEXT NOT NULL DEFAULT '',
    gaeste_limit INTEGER NOT NULL DEFAULT 120, verkauf_offen INTEGER NOT NULL DEFAULT 1,
    ort TEXT NOT NULL DEFAULT '', adresse TEXT NOT NULL DEFAULT '',
    beschreibung TEXT NOT NULL DEFAULT '', aktiv INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ticket_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lan_id INTEGER NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
    beschreibung TEXT NOT NULL DEFAULT '', features TEXT NOT NULL DEFAULT '[]',
    preis_cent INTEGER NOT NULL DEFAULT 0, extras TEXT NOT NULL DEFAULT '[]',
    mit_sitz INTEGER NOT NULL DEFAULT 1, aktiv INTEGER NOT NULL DEFAULT 1,
    kaufbar INTEGER NOT NULL DEFAULT 1, limit_anzahl INTEGER NOT NULL DEFAULT 0,
    von TEXT NOT NULL DEFAULT '', bis TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS seats (
    id TEXT PRIMARY KEY, lan_id INTEGER NOT NULL, label TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, gesperrt INTEGER NOT NULL DEFAULT 0,
    group_id INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS seats_label ON seats(lan_id, label)`,
  `CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lan_id INTEGER NOT NULL,
    name TEXT NOT NULL, name_key TEXT NOT NULL, owner_id INTEGER NOT NULL,
    code TEXT NOT NULL, ablauf INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS groups_name ON groups(lan_id, name_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS groups_code ON groups(code)`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, lan_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (group_id, user_id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS group_members_einmal ON group_members(lan_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lan_id INTEGER NOT NULL,
    code TEXT NOT NULL UNIQUE, typ TEXT NOT NULL, wert INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '', max_einloesungen INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lan_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL, type_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'offen', zahlart TEXT NOT NULL DEFAULT 'bar',
    preis_cent INTEGER NOT NULL DEFAULT 0, extras TEXT NOT NULL DEFAULT '[]',
    coupon_id INTEGER, rabatt_cent INTEGER NOT NULL DEFAULT 0,
    seat_id TEXT, notiz TEXT NOT NULL DEFAULT '', orga_notiz TEXT NOT NULL DEFAULT '',
    agb_at INTEGER, created_at INTEGER NOT NULL,
    bezahlt_at INTEGER, bezahlt_von TEXT NOT NULL DEFAULT '',
    checkin_at INTEGER, checkin_von TEXT NOT NULL DEFAULT '',
    otp TEXT NOT NULL DEFAULT '', freigeschaltet_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tickets_einmal ON tickets(lan_id, user_id) WHERE status != 'storniert'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tickets_sitz ON tickets(seat_id) WHERE seat_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT, titel TEXT NOT NULL,
    teaser TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
    datum TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
    user_id INTEGER, aktion TEXT NOT NULL, details TEXT NOT NULL DEFAULT '')`,
];

// Einstellungen mit Standardwerten. Gespeichert wird nur, was abweicht.
const STANDARD = {
  seite: {
    titel: "AGE-LAN",
    slogan: "Die Age of Empires 2 LAN in Nordhessen",
    headerInfo: "",
    socials: { discord: "", twitch: "", youtube: "", instagram: "", facebook: "" },
  },
  highlights: [
    { icon: "🖥️", titel: "120 PC-Plätze", text: "Doppeltische mit Strom und kabelgebundenem Netz" },
    { icon: "🏆", titel: "Turniere", text: "1v1 bis 4v4, mit Rating und Live-Bracket" },
    { icon: "⚔️", titel: "Matchmaking", text: "Lokales Ranking mit der LAN-Zone" },
    { icon: "🍕", titel: "Essen & Frühstück", text: "Bestellen direkt über die AgeLan-App" },
    { icon: "🚿", titel: "Duschen & WCs", text: "Alles vor Ort in der Halle" },
    { icon: "😴", titel: "Schlafbereich", text: "Abgetrennt und ruhig" },
  ],
  zahlung: {
    arten: { paypal: true, ueberweisung: true, bar: true },
    paypal: "", paypalMe: "", iban: "", kontoinhaber: "", bank: "",
    hinweis: "Bitte gib bei PayPal und Überweisung deinen Nickname und die ersten 8 Zeichen deines Ticket-Codes als Verwendungszweck an. Bei PayPal bitte „Freunde und Familie“ wählen.",
    fristTage: 14,
  },
  faq: [
    { f: "Wie läuft das mit dem Essen?", a: "Vor Ort gibt es Catering zu fairen Preisen. Bestellt wird bequem über die AgeLan-App, für die dein Konto beim Check-in freigeschaltet wird." },
    { f: "Und Getränke?", a: "Kalte Getränke werden vor Ort verkauft. Bier darf wegen des Brauerei-Vertrags der Halle nicht mitgebracht werden." },
    { f: "Wo schlafe ich?", a: "Es gibt einen abgetrennten Schlafbereich. Wer es ruhiger mag, findet Pensionen und Hotels in Volkmarsen." },
    { f: "Ab welchem Alter darf ich kommen?", a: "Ab 18 ohne Weiteres. Ab 16 mit einer volljährigen Aufsichtsperson, die selbst zur LAN kommt, und unterschriebenem Muttizettel." },
    { f: "Wie sicher ist mein Platz?", a: "Wer bezahlt hat, hat seinen Platz sicher. Offene Bestellungen halten den Platz bis zur Zahlungsfrist." },
    { f: "Gibt es Internet?", a: "Ja. Die Freischaltung bekommst du beim Check-in." },
  ],
  texte: { anfahrt: "", impressum: "", datenschutz: "", agb: "" },
  // Internet-Zugang: steht nach dem Check-in auf dem Handy des Gastes (Ticket-QR bzw. Konto).
  netz: { ssid: "", wlanPasswort: "", portal: "", benutzer: "nick", hinweis: "Verbinde dich mit dem Netz und melde dich im Portal mit diesen Daten an." },
  sponsoren: [],
  gaesteOeffentlich: true,
  sitzwahlOffen: true,
  gruppeHalteTage: 21,
  gruppeMaxSitze: 10,
};
const OEFFENTLICHE_EINSTELLUNGEN = ["seite", "highlights", "zahlung", "faq", "texte", "sponsoren", "gaesteOeffentlich", "sitzwahlOffen", "gruppeHalteTage", "gruppeMaxSitze"];

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const cors = corsKopf(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (!/\/api\/?$/.test(url.pathname)) return json({ error: "Nicht gefunden" }, 404, cors);
    if (request.method !== "POST") return json({ error: "Nur POST" }, 405, cors);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Ungültige Anfrage" }, 400, cors); }
    if (!body || typeof body !== "object") return json({ error: "Ungültige Anfrage" }, 400, cors);

    try {
      if (!env.DB) throw new F(500, "Datenbank-Binding DB fehlt.");
      if (!env.TOKEN_SECRET) throw new F(500, "Secret TOKEN_SECRET fehlt.");
      await bereitmachen(env);
      const fn = AKTIONEN[body.aktion];
      if (!fn) throw new F(400, "Unbekannte Aktion");
      const c = { env, request, body, ip: request.headers.get("CF-Connecting-IP") || "?" };
      c.ich = await nutzerAusToken(env, request);
      return json(await fn(c), 200, cors);
    } catch (e) {
      if (e instanceof F) return json({ error: e.message }, e.status, cors);
      if (String(e && e.message).includes("UNIQUE")) return json({ error: "Das ist gerade schon vergeben – bitte neu laden und nochmal versuchen." }, 409, cors);
      console.error(e);
      return json({ error: "Interner Fehler" }, 500, cors);
    }
  },
};

class F extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function corsKopf(request, env) {
  const origin = request.headers.get("Origin") || "";
  const erlaubt = String(env.ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && (erlaubt.includes(origin) || erlaubt.includes("*"))) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(daten, status, cors) {
  return new Response(JSON.stringify(daten), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });
}

// ---------------------------------------------------------------------------
// DB-Helfer
// ---------------------------------------------------------------------------
const n = (v) => (v === undefined ? null : v);
async function alle(env, sql, ...p) { return (await env.DB.prepare(sql).bind(...p.map(n)).all()).results || []; }
async function eins(env, sql, ...p) { return (await env.DB.prepare(sql).bind(...p.map(n)).first()) || null; }
async function los(env, sql, ...p) { return await env.DB.prepare(sql).bind(...p.map(n)).run(); }
const st = (env, sql, ...p) => env.DB.prepare(sql).bind(...p.map(n));
const geaendert = (r) => (r && r.meta ? r.meta.changes : 0) || 0;

let istBereit = false;
async function bereitmachen(env) {
  if (istBereit) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const lan = await eins(env, "SELECT id FROM lans LIMIT 1");
  if (!lan) await grundausstattung(env);
  istBereit = true;
}

// Erste LAN, Ticketsorten und der Hallenplan der Nordhessenhalle (120 Plätze:
// Blöcke AB, CD, EF, GH mit Reihe 1–12, dahinter GH 13–24).
async function grundausstattung(env) {
  const jetzt = Date.now();
  const r = await los(env,
    "INSERT INTO lans (name, start, ende, gaeste_limit, verkauf_offen, ort, adresse, beschreibung, aktiv, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)",
    "AGE-LAN #4", "", "", 120, 1, "Nordhessenhalle Volkmarsen", "Schulstraße 11, 34471 Volkmarsen",
    "Vier Tage Age of Empires 2 mit Turnieren, Showmatches und jeder Menge Community.", jetzt);
  const lanId = r.meta.last_row_id;
  const voll = ["Sitzplatz an Doppeltischen", "Internetzugang", "Garantierter Einlass nach Zahlung", "Schlafbereich, Duschen und Gaming-Area"];
  const typen = [
    [1, "Sitzplatz-Ticket (First Ager)", "Das Early-Ticket – limitiert.", voll, 5000, 1, 1, 1, 30],
    [2, "Sitzplatz-Ticket", "Die volle LAN-Experience.", voll, 6000, 1, 1, 1, 0],
    [3, "Gäste-Ticket", "100 % LAN-Feeling – ohne eigenen PC-Platz.", ["Garantierter Einlass nach Zahlung", "Schlafbereich und Duschen", "Kein PC-Platz in der Gaming-Area"], 3000, 0, 1, 1, 0],
    [9, "Orga / Free", "Nur von der Orga vergeben.", voll, 0, 1, 1, 0, 0],
  ];
  const stmts = typen.map((t) => st(env,
    "INSERT INTO ticket_types (lan_id, sort, name, beschreibung, features, preis_cent, mit_sitz, aktiv, kaufbar, limit_anzahl) VALUES (?,?,?,?,?,?,?,?,?,?)",
    lanId, t[0], t[1], t[2], JSON.stringify(t[3]), t[4], t[5], t[6], t[7], t[8]));
  const spalten = { A: 1, B: 2, C: 4, D: 5, E: 7, F: 8, G: 10, H: 11 };
  for (const [buchstabe, x] of Object.entries(spalten)) {
    for (let reihe = 1; reihe <= 24; reihe++) {
      if (reihe > 12 && x < 10) continue;
      const y = reihe <= 12 ? reihe + 1 : reihe + 2;
      stmts.push(st(env, "INSERT INTO seats (id, lan_id, label, x, y) VALUES (?,?,?,?,?)", zufallsId(), lanId, buchstabe + reihe, x, y));
    }
  }
  stmts.push(st(env, "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", "plan:" + lanId, JSON.stringify({
    breite: 13, hoehe: 28,
    deko: [
      { id: zufallsId(), typ: "flaeche", x: 1, y: 0, w: 11, h: 0.8, text: "Bühne / Leinwand", farbe: "gold" },
      { id: zufallsId(), typ: "text", x: 1, y: 18, w: 7, h: 1, text: "Orga · Catering", farbe: "grau" },
      { id: zufallsId(), typ: "flaeche", x: 0, y: 27, w: 3, h: 1, text: "Eingang", farbe: "gruen" },
    ],
  })));
  await env.DB.batch(stmts);
}

async function einstellungen(env) {
  const zeilen = await alle(env, "SELECT key, value FROM settings WHERE key NOT LIKE 'plan:%'");
  const e = JSON.parse(JSON.stringify(STANDARD));
  for (const z of zeilen) {
    try { e[z.key] = JSON.parse(z.value); } catch (x) { /* kaputter Wert: Standard bleibt */ }
  }
  return e;
}

async function aktiveLan(env) {
  const lan = await eins(env, "SELECT * FROM lans WHERE aktiv = 1 ORDER BY id DESC LIMIT 1")
    || await eins(env, "SELECT * FROM lans ORDER BY id DESC LIMIT 1");
  if (!lan) throw new F(500, "Keine LAN angelegt.");
  return lan;
}

async function lanAusBody(c) {
  if (c.body.lanId) {
    const lan = await eins(c.env, "SELECT * FROM lans WHERE id = ?", Number(c.body.lanId));
    if (!lan) throw new F(404, "LAN nicht gefunden.");
    return lan;
  }
  return aktiveLan(c.env);
}

async function protokoll(c, aktion, details) {
  await los(c.env, "INSERT INTO log (at, user_id, aktion, details) VALUES (?,?,?,?)",
    Date.now(), c.ich ? c.ich.id : null, aktion, typeof details === "string" ? details : JSON.stringify(details || ""));
}

// ---------------------------------------------------------------------------
// Krypto: Passwörter (PBKDF2) und Token (HMAC)
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
function b64(bytes) { let s = ""; new Uint8Array(bytes).forEach((b) => (s += String.fromCharCode(b))); return btoa(s); }
function unb64(s) { return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0)); }
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

function zufallsBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function zufallsId() { return b64url(zufallsBytes(9)); }
function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function zufallsCode(laenge) {
  const zeichen = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...zufallsBytes(laenge)].map((b) => zeichen[b % zeichen.length]).join("");
}

async function pbkdf2(passwort, salt, runden) {
  const key = await crypto.subtle.importKey("raw", enc.encode(passwort), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: runden }, key, 256));
}
async function passwortHashen(passwort) {
  const salt = zufallsBytes(16);
  return "pbkdf2$" + PBKDF2_RUNDEN + "$" + b64(salt) + "$" + b64(await pbkdf2(passwort, salt, PBKDF2_RUNDEN));
}
async function passwortStimmt(passwort, gespeichert) {
  const teile = String(gespeichert || "").split("$");
  if (teile.length !== 4) return false;
  const soll = unb64(teile[3]);
  const ist = await pbkdf2(passwort, unb64(teile[2]), Number(teile[1]));
  let diff = soll.length ^ ist.length;
  for (let i = 0; i < Math.min(soll.length, ist.length); i++) diff |= soll[i] ^ ist[i];
  return diff === 0;
}
async function gleich(a, b) {
  // Zeitkonstanter Vergleich über HMAC beider Werte.
  const k = await crypto.subtle.importKey("raw", zufallsBytes(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const x = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(String(a))));
  const y = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(String(b))));
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function hmacSchluessel(env) {
  return crypto.subtle.importKey("raw", enc.encode(env.TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function tokenBauen(env, user) {
  const nutzlast = b64url(enc.encode(JSON.stringify({ u: user.id, v: user.token_ver, e: Date.now() + TOKEN_TAGE * 864e5 })));
  const sig = await crypto.subtle.sign("HMAC", await hmacSchluessel(env), enc.encode(nutzlast));
  return nutzlast + "." + b64url(sig);
}
async function nutzerAusToken(env, request) {
  const kopf = request.headers.get("Authorization") || "";
  const token = kopf.startsWith("Bearer ") ? kopf.slice(7).trim() : "";
  if (!token || !token.includes(".")) return null;
  const [nutzlast, sig] = token.split(".");
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacSchluessel(env), unb64url(sig), enc.encode(nutzlast)); } catch (e) { ok = false; }
  if (!ok) return null;
  let d;
  try { d = JSON.parse(new TextDecoder().decode(unb64url(nutzlast))); } catch (e) { return null; }
  if (!d || d.e < Date.now()) return null;
  const u = await eins(env, "SELECT * FROM users WHERE id = ?", d.u);
  if (!u || u.token_ver !== d.v || u.gesperrt) return null;
  return u;
}

// Bremse gegen Passwort-Raten: je IP höchstens 10 Fehlversuche in 15 Minuten.
const fehlversuche = new Map();
function bremseOffen(ip) {
  const e = fehlversuche.get(ip);
  return !e || e.bis < Date.now() || e.anzahl < 10;
}
function bremseFehlschlag(ip) {
  const e = fehlversuche.get(ip);
  if (!e || e.bis < Date.now()) fehlversuche.set(ip, { anzahl: 1, bis: Date.now() + 15 * 60e3 });
  else e.anzahl++;
}

// ---------------------------------------------------------------------------
// Prüfer
// ---------------------------------------------------------------------------
function brauchtLogin(c) { if (!c.ich) throw new F(401, "Bitte melde dich an."); return c.ich; }
function brauchtOrga(c) { const u = brauchtLogin(c); if (u.rolle !== "orga" && u.rolle !== "admin") throw new F(403, "Nur für die Orga."); return u; }
function brauchtAdmin(c) { const u = brauchtLogin(c); if (u.rolle !== "admin") throw new F(403, "Nur für Veranstalter."); return u; }

function text(v, max, feld, pflicht) {
  const s = String(v == null ? "" : v).trim();
  if (pflicht && !s) throw new F(400, feld + " fehlt.");
  if (s.length > max) throw new F(400, feld + " ist zu lang (max. " + max + " Zeichen).");
  return s;
}
function nickPruefen(v) {
  const s = text(v, 24, "Nickname", true);
  if (s.length < 2) throw new F(400, "Der Nickname braucht mindestens 2 Zeichen.");
  if (!/^[\p{L}\p{N}_\-. ]+$/u.test(s)) throw new F(400, "Im Nickname sind nur Buchstaben, Ziffern, Leerzeichen und _ - . erlaubt.");
  return s;
}
function mailPruefen(v) {
  const s = text(v, 120, "E-Mail", true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new F(400, "Die E-Mail-Adresse sieht nicht gültig aus.");
  return s;
}
function datumPruefen(v, feld) {
  const s = String(v || "").trim();
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new F(400, feld + ": Datum im Format JJJJ-MM-TT.");
  return s;
}
function ganz(v, feld, min, max) {
  const x = Number(v);
  if (!Number.isFinite(x) || Math.round(x) !== x) throw new F(400, feld + " muss eine ganze Zahl sein.");
  if (min != null && x < min) throw new F(400, feld + " ist zu klein.");
  if (max != null && x > max) throw new F(400, feld + " ist zu groß.");
  return x;
}
function heute() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function alterAm(geburtsdatum, stichtag) {
  if (!geburtsdatum) return null;
  const [gj, gm, gt] = geburtsdatum.split("-").map(Number);
  const [sj, sm, stt] = stichtag.split("-").map(Number);
  let a = sj - gj;
  if (sm < gm || (sm === gm && stt < gt)) a--;
  return a;
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------
function nutzerOeffentlich(u) {
  return {
    id: u.id, nick: u.nick, email: u.email, vorname: u.vorname, nachname: u.nachname,
    geburtsdatum: u.geburtsdatum, discord: u.discord, rolle: u.rolle, gesperrt: !!u.gesperrt, createdAt: u.created_at,
  };
}
function typAus(t) {
  return {
    id: t.id, lanId: t.lan_id, sort: t.sort, name: t.name, beschreibung: t.beschreibung,
    features: parse(t.features, []), preisCent: t.preis_cent, extras: parse(t.extras, []),
    mitSitz: !!t.mit_sitz, aktiv: !!t.aktiv, kaufbar: !!t.kaufbar, limit: t.limit_anzahl, von: t.von, bis: t.bis,
  };
}
function parse(s, ersatz) { try { return JSON.parse(s); } catch (e) { return ersatz; } }

// Volles Ticket-Bild (für Konto, Check-in, Admin).
async function ticketDetail(env, ticketId) {
  const t = await eins(env, `SELECT t.*, u.nick, u.vorname, u.nachname, u.email, u.geburtsdatum, u.discord,
      tt.name AS typ_name, tt.features AS typ_features, tt.mit_sitz, tt.beschreibung AS typ_beschreibung,
      s.label AS sitz_label, l.name AS lan_name, l.start AS lan_start, l.ende AS lan_ende, l.ort AS lan_ort, l.adresse AS lan_adresse,
      g.name AS gruppe_name, c.code AS coupon_code
    FROM tickets t JOIN users u ON u.id = t.user_id JOIN ticket_types tt ON tt.id = t.type_id
    JOIN lans l ON l.id = t.lan_id LEFT JOIN seats s ON s.id = t.seat_id
    LEFT JOIN group_members gm ON gm.user_id = t.user_id AND gm.lan_id = t.lan_id
    LEFT JOIN groups g ON g.id = gm.group_id LEFT JOIN coupons c ON c.id = t.coupon_id
    WHERE t.id = ?`, ticketId);
  return t ? ticketAus(t) : null;
}
function ticketAus(t) {
  return {
    id: t.id, lanId: t.lan_id, code: t.code, status: t.status, zahlart: t.zahlart, zahlartText: ZAHLARTEN[t.zahlart] || t.zahlart,
    preisCent: t.preis_cent, rabattCent: t.rabatt_cent, extras: parse(t.extras, []), couponCode: t.coupon_code || "",
    notiz: t.notiz, orgaNotiz: t.orga_notiz, createdAt: t.created_at,
    bezahltAt: t.bezahlt_at, bezahltVon: t.bezahlt_von, checkinAt: t.checkin_at, checkinVon: t.checkin_von,
    otp: t.otp, freigeschaltetAt: t.freigeschaltet_at,
    sitzId: t.seat_id, sitz: t.sitz_label || "", gruppe: t.gruppe_name || "",
    typ: { id: t.type_id, name: t.typ_name, features: parse(t.typ_features, []), mitSitz: !!t.mit_sitz, beschreibung: t.typ_beschreibung },
    nutzer: { id: t.user_id, nick: t.nick, vorname: t.vorname, nachname: t.nachname, email: t.email, geburtsdatum: t.geburtsdatum, discord: t.discord },
    lan: { name: t.lan_name, start: t.lan_start, ende: t.lan_ende, ort: t.lan_ort, adresse: t.lan_adresse },
  };
}

// Belegungszahlen einer LAN
async function zahlen(env, lan) {
  const sitze = await eins(env, "SELECT COUNT(*) AS n FROM seats WHERE lan_id = ? AND gesperrt = 0", lan.id);
  const mitSitz = await eins(env, `SELECT COUNT(*) AS n FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id
    WHERE t.lan_id = ? AND t.status != 'storniert' AND tt.mit_sitz = 1`, lan.id);
  const gaeste = await eins(env, "SELECT COUNT(*) AS n, SUM(status = 'bezahlt') AS bezahlt FROM tickets WHERE lan_id = ? AND status != 'storniert'", lan.id);
  const kapazitaet = Math.min(sitze.n, lan.gaeste_limit || sitze.n);
  return {
    sitzplaetze: kapazitaet, sitzTickets: mitSitz.n, sitzFrei: Math.max(0, kapazitaet - mitSitz.n),
    gaeste: gaeste.n, bezahlt: gaeste.bezahlt || 0,
  };
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------
const AKTIONEN = {
  // ---------- öffentlich ----------
  async oeffentlich(c) {
    const { env } = c;
    const lan = await aktiveLan(env);
    const e = await einstellungen(env);
    const typen = await alle(env, "SELECT * FROM ticket_types WHERE lan_id = ? AND aktiv = 1 ORDER BY sort, id", lan.id);
    const verkauft = await alle(env, "SELECT type_id, COUNT(*) AS n FROM tickets WHERE lan_id = ? AND status != 'storniert' GROUP BY type_id", lan.id);
    const z = await zahlen(env, lan);
    const tag = heute();
    const news = await alle(env, "SELECT id, titel, teaser, datum FROM news ORDER BY datum DESC, id DESC LIMIT 30");
    const einst = {};
    for (const k of OEFFENTLICHE_EINSTELLUNGEN) einst[k] = e[k];
    return {
      lan: lanAus(lan), zahlen: z, einstellungen: einst, news,
      tickettypen: typen.map((t) => {
        const x = typAus(t);
        const n = (verkauft.find((v) => v.type_id === t.id) || {}).n || 0;
        x.verkauft = n;
        x.rest = x.limit > 0 ? Math.max(0, x.limit - n) : null;
        let grund = "";
        if (!x.kaufbar) grund = "Nicht im Verkauf";
        else if (!lan.verkauf_offen) grund = "Ticketverkauf geschlossen";
        else if (x.von && tag < x.von) grund = "Ab " + x.von;
        else if (x.bis && tag > x.bis) grund = "Nicht mehr verfügbar";
        else if (x.rest === 0) grund = "Ausverkauft";
        else if (x.mitSitz && z.sitzFrei <= 0) grund = "Alle Sitzplätze vergeben";
        x.verfuegbar = !grund;
        x.grund = grund;
        return x;
      }).filter((x) => x.kaufbar || x.verkauft > 0),
    };
  },

  // Ticket-Seite hinter dem QR-Code (#/t/<code>). Der 128-Bit-Code IST die
  // Berechtigung – wer ihn hat, hat das Ticket in der Hand. Die Zugangsdaten
  // gibt es erst nach dem Check-in.
  async ticketSeite(c) {
    const { env } = c;
    const code = codeAus(String(c.body.code || ""));
    const r = code ? await eins(env, "SELECT id FROM tickets WHERE code = ?", code) : null;
    if (!r) throw new F(404, "Dieses Ticket gibt es nicht.");
    const t = await ticketDetail(env, r.id);
    const aus = {
      nick: t.nutzer.nick, typ: t.typ.name, mitSitz: t.typ.mitSitz, status: t.status, sitz: t.sitz, gruppe: t.gruppe,
      lan: t.lan, eingecheckt: !!t.checkinAt, checkinAt: t.checkinAt, zugang: null,
    };
    if (t.checkinAt && t.status !== "storniert") aus.zugang = await zugangsdaten(env, t);
    return { ticket: aus };
  },

  async news(c) {
    const x = await eins(c.env, "SELECT * FROM news WHERE id = ?", Number(c.body.id));
    if (!x) throw new F(404, "Diese Neuigkeit gibt es nicht.");
    return { news: x };
  },

  async sitzplan(c) {
    const { env } = c;
    const lan = await lanAusBody(c);
    const e = await einstellungen(env);
    const istOrga = c.ich && (c.ich.rolle === "orga" || c.ich.rolle === "admin");
    const namenZeigen = e.gaesteOeffentlich || istOrga;
    const plan = parse((await eins(env, "SELECT value FROM settings WHERE key = ?", "plan:" + lan.id) || {}).value, null) || { breite: 20, hoehe: 20, deko: [] };
    const jetzt = Date.now();
    const sitze = await alle(env, `SELECT s.*, t.status AS t_status, t.user_id AS t_user, u.nick AS t_nick,
        g.name AS g_name, g.ablauf AS g_ablauf, tg.name AS tg_name, tgm.group_id AS t_group
      FROM seats s
      LEFT JOIN tickets t ON t.seat_id = s.id
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN groups g ON g.id = s.group_id
      LEFT JOIN group_members tgm ON tgm.user_id = t.user_id AND tgm.lan_id = s.lan_id
      LEFT JOIN groups tg ON tg.id = tgm.group_id
      WHERE s.lan_id = ? ORDER BY s.y, s.x`, lan.id);
    let meineGruppe = null;
    if (c.ich) {
      const m = await eins(env, "SELECT group_id FROM group_members WHERE user_id = ? AND lan_id = ?", c.ich.id, lan.id);
      meineGruppe = m ? m.group_id : null;
    }
    return {
      lan: lanAus(lan), plan,
      sitze: sitze.map((s) => {
        const gruppeAktiv = s.group_id && s.g_ablauf > jetzt;
        let status = "frei";
        if (s.gesperrt) status = "gesperrt";
        else if (s.t_status) status = s.t_status === "bezahlt" ? "belegt" : "reserviert";
        else if (gruppeAktiv) status = "gruppe";
        const gruppeId = s.t_status ? s.t_group : (gruppeAktiv ? s.group_id : null);
        return {
          id: s.id, label: s.label, x: s.x, y: s.y, status,
          nick: s.t_status && namenZeigen ? s.t_nick : "",
          gruppe: s.t_status ? (namenZeigen ? s.tg_name || "" : "") : (gruppeAktiv ? s.g_name : ""),
          gruppenSitz: !!gruppeAktiv,
          meins: !!(c.ich && s.t_user === c.ich.id),
          meineGruppe: !!(meineGruppe && (gruppeId === meineGruppe || (gruppeAktiv && s.group_id === meineGruppe))),
        };
      }),
    };
  },

  async gaeste(c) {
    const { env } = c;
    const e = await einstellungen(env);
    const istOrga = c.ich && (c.ich.rolle === "orga" || c.ich.rolle === "admin");
    if (!e.gaesteOeffentlich && !istOrga) return { oeffentlich: false, gaeste: [] };
    const lan = await lanAusBody(c);
    const z = await zahlen(env, lan);
    const zeilen = await alle(env, `SELECT u.nick, s.label AS sitz, g.name AS gruppe, tt.name AS typ, t.status
      FROM tickets t JOIN users u ON u.id = t.user_id JOIN ticket_types tt ON tt.id = t.type_id
      LEFT JOIN seats s ON s.id = t.seat_id
      LEFT JOIN group_members gm ON gm.user_id = t.user_id AND gm.lan_id = t.lan_id
      LEFT JOIN groups g ON g.id = gm.group_id
      WHERE t.lan_id = ? AND t.status != 'storniert' ORDER BY t.created_at`, lan.id);
    return { oeffentlich: true, zahlen: z, gaeste: zeilen.map((r) => ({ nick: r.nick, sitz: r.sitz || "", gruppe: r.gruppe || "", typ: r.typ, bezahlt: r.status === "bezahlt" })) };
  },

  // ---------- Konto ----------
  async registrieren(c) {
    const { env, body } = c;
    if (!bremseOffen(c.ip)) throw new F(429, "Zu viele Versuche. Bitte später nochmal.");
    const nick = nickPruefen(body.nick);
    const email = mailPruefen(body.email);
    const pw = String(body.passwort || "");
    if (pw.length < PW_MIN) throw new F(400, "Das Passwort braucht mindestens " + PW_MIN + " Zeichen.");
    if (!body.datenschutz) throw new F(400, "Bitte bestätige die Datenschutzerklärung.");
    const u = {
      vorname: text(body.vorname, 60, "Vorname", true), nachname: text(body.nachname, 60, "Nachname", true),
      geburtsdatum: datumPruefen(body.geburtsdatum, "Geburtsdatum"), discord: text(body.discord, 60, "Discord", false),
    };
    if (!u.geburtsdatum) throw new F(400, "Geburtsdatum fehlt (wir brauchen es wegen der Altersgrenze).");
    if (await eins(env, "SELECT id FROM users WHERE nick_key = ?", nick.toLowerCase())) throw new F(409, "Diesen Nickname gibt es schon.");
    if (await eins(env, "SELECT id FROM users WHERE email_key = ?", email.toLowerCase())) throw new F(409, "Mit dieser E-Mail gibt es schon ein Konto.");
    const r = await los(env, `INSERT INTO users (nick, nick_key, email, email_key, vorname, nachname, geburtsdatum, discord, pw, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, nick, nick.toLowerCase(), email, email.toLowerCase(), u.vorname, u.nachname, u.geburtsdatum, u.discord, await passwortHashen(pw), Date.now());
    const neu = await eins(env, "SELECT * FROM users WHERE id = ?", r.meta.last_row_id);
    c.ich = neu;
    await protokoll(c, "registriert", nick);
    return { token: await tokenBauen(env, neu), nutzer: nutzerOeffentlich(neu) };
  },

  async login(c) {
    const { env, body } = c;
    if (!bremseOffen(c.ip)) throw new F(429, "Zu viele Fehlversuche. Bitte in 15 Minuten nochmal.");
    const kennung = String(body.kennung || "").trim().toLowerCase();
    const u = await eins(env, "SELECT * FROM users WHERE nick_key = ? OR email_key = ?", kennung, kennung);
    if (!u || !(await passwortStimmt(String(body.passwort || ""), u.pw))) {
      bremseFehlschlag(c.ip);
      throw new F(403, "Name/E-Mail oder Passwort stimmt nicht.");
    }
    if (u.gesperrt) throw new F(403, "Dieses Konto ist gesperrt. Bitte melde dich bei der Orga.");
    return { token: await tokenBauen(env, u), nutzer: nutzerOeffentlich(u) };
  },

  async ich(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const t = await eins(env, "SELECT id FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert'", u.id, lan.id);
    const gm = await eins(env, "SELECT group_id FROM group_members WHERE user_id = ? AND lan_id = ?", u.id, lan.id);
    return {
      nutzer: nutzerOeffentlich(u),
      ticket: t ? await mitZugang(env, await ticketDetail(env, t.id)) : null,
      gruppe: gm ? await gruppeDetail(env, gm.group_id, u.id) : null,
      alter: alterAm(u.geburtsdatum, lan.start || heute()),
    };
  },

  async kontoAendern(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    const email = mailPruefen(body.email);
    if (email.toLowerCase() !== u.email_key && await eins(env, "SELECT id FROM users WHERE email_key = ?", email.toLowerCase())) throw new F(409, "Mit dieser E-Mail gibt es schon ein Konto.");
    await los(env, "UPDATE users SET email = ?, email_key = ?, vorname = ?, nachname = ?, geburtsdatum = ?, discord = ? WHERE id = ?",
      email, email.toLowerCase(), text(body.vorname, 60, "Vorname", true), text(body.nachname, 60, "Nachname", true),
      datumPruefen(body.geburtsdatum, "Geburtsdatum"), text(body.discord, 60, "Discord", false), u.id);
    let token = null;
    if (body.passwortNeu) {
      if (!(await passwortStimmt(String(body.passwortAlt || ""), u.pw))) throw new F(403, "Das bisherige Passwort stimmt nicht.");
      if (String(body.passwortNeu).length < PW_MIN) throw new F(400, "Das neue Passwort braucht mindestens " + PW_MIN + " Zeichen.");
      await los(env, "UPDATE users SET pw = ?, token_ver = token_ver + 1 WHERE id = ?", await passwortHashen(String(body.passwortNeu)), u.id);
      token = await tokenBauen(env, await eins(env, "SELECT * FROM users WHERE id = ?", u.id));
    }
    return { ok: true, token, nutzer: nutzerOeffentlich(await eins(env, "SELECT * FROM users WHERE id = ?", u.id)) };
  },

  async veranstalterWerden(c) {
    const u = brauchtLogin(c);
    if (!c.env.ADMIN_SETUP) throw new F(500, "Secret ADMIN_SETUP fehlt.");
    if (!bremseOffen(c.ip)) throw new F(429, "Zu viele Fehlversuche.");
    if (!(await gleich(String(c.body.passwort || ""), c.env.ADMIN_SETUP))) { bremseFehlschlag(c.ip); throw new F(403, "Falsches Passwort."); }
    await los(c.env, "UPDATE users SET rolle = 'admin' WHERE id = ?", u.id);
    await protokoll(c, "veranstalter", u.nick);
    return { ok: true };
  },

  // ---------- Tickets ----------
  async preisVorschau(c) {
    const lan = await aktiveLan(c.env);
    return preisBerechnen(c, lan);
  },

  async ticketKaufen(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    if (!lan.verkauf_offen) throw new F(409, "Der Ticketverkauf ist gerade geschlossen.");
    if (!body.agb) throw new F(400, "Bitte akzeptiere die Teilnahmebedingungen.");
    const e = await einstellungen(env);
    const zahlart = String(body.zahlart || "");
    if (!ZAHLARTEN[zahlart] || !e.zahlung.arten[zahlart]) throw new F(400, "Bitte wähle eine Zahlart.");
    const alter = alterAm(u.geburtsdatum, lan.start || heute());
    if (alter !== null && alter < 16) throw new F(403, "Die Teilnahme ist leider erst ab 16 Jahren möglich.");
    if (await eins(env, "SELECT id FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert'", u.id, lan.id)) throw new F(409, "Du hast für diese LAN schon ein Ticket.");

    const p = await preisBerechnen(c, lan);
    const typ = p.typRoh;
    const tag = heute();
    if (!typ.kaufbar || !typ.aktiv) throw new F(409, "Dieses Ticket ist nicht im Verkauf.");
    if (typ.von && tag < typ.von) throw new F(409, "Dieses Ticket gibt es erst ab " + typ.von + ".");
    if (typ.bis && tag > typ.bis) throw new F(409, "Dieses Ticket ist nicht mehr verfügbar.");

    const code = hex(zufallsBytes(16));
    const jetzt = Date.now();
    const gratis = p.endCent === 0;
    // Kontingent, Sitzplätze und Gutschein in EINER Anweisung prüfen und
    // schreiben – sonst verkaufen zwei gleichzeitige Käufe den letzten Platz doppelt.
    const r = await los(env, `INSERT INTO tickets (lan_id, user_id, type_id, code, status, zahlart, preis_cent, extras, coupon_id, rabatt_cent, notiz, agb_at, created_at, bezahlt_at, bezahlt_von)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE (? = 0 OR (SELECT COUNT(*) FROM tickets WHERE type_id = ? AND status != 'storniert') < ?)
        AND (? = 0 OR (SELECT COUNT(*) FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id WHERE t.lan_id = ? AND tt.mit_sitz = 1 AND t.status != 'storniert')
                      < MIN((SELECT COUNT(*) FROM seats WHERE lan_id = ? AND gesperrt = 0), ?))
        AND (? IS NULL OR (SELECT COUNT(*) FROM tickets WHERE coupon_id = ? AND status != 'storniert') < (SELECT max_einloesungen FROM coupons WHERE id = ?))`,
      lan.id, u.id, typ.id, code, gratis ? "bezahlt" : "offen", zahlart, p.endCent, JSON.stringify(p.extras), p.couponId, p.rabattCent,
      text(body.notiz, 300, "Hinweis", false), jetzt, jetzt, gratis ? jetzt : null, gratis ? "gratis" : "",
      typ.limit_anzahl, typ.id, typ.limit_anzahl,
      typ.mit_sitz, lan.id, lan.id, lan.gaeste_limit || 100000,
      p.couponId, p.couponId, p.couponId);
    if (!geaendert(r)) throw new F(409, "Leider ausverkauft – oder der Gutschein ist schon aufgebraucht.");
    await protokoll(c, "ticket-gekauft", { typ: typ.name, zahlart, preis: p.endCent });
    return { ticket: await ticketDetail(env, r.meta.last_row_id) };
  },

  async ticketStornieren(c) {
    const u = brauchtLogin(c);
    const lan = await aktiveLan(c.env);
    const r = await los(c.env, "UPDATE tickets SET status = 'storniert', seat_id = NULL WHERE user_id = ? AND lan_id = ? AND status = 'offen'", u.id, lan.id);
    if (!geaendert(r)) throw new F(409, "Nur offene (noch nicht bezahlte) Tickets kannst du selbst stornieren.");
    await protokoll(c, "ticket-storniert", u.nick);
    return { ok: true };
  },

  async zahlartAendern(c) {
    const u = brauchtLogin(c);
    const lan = await aktiveLan(c.env);
    const e = await einstellungen(c.env);
    const z = String(c.body.zahlart || "");
    if (!ZAHLARTEN[z] || !e.zahlung.arten[z]) throw new F(400, "Unbekannte Zahlart.");
    const r = await los(c.env, "UPDATE tickets SET zahlart = ? WHERE user_id = ? AND lan_id = ? AND status = 'offen'", z, u.id, lan.id);
    if (!geaendert(r)) throw new F(409, "Kein offenes Ticket.");
    return { ok: true };
  },

  // ---------- Sitzplatz ----------
  async sitzWaehlen(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const e = await einstellungen(env);
    if (!e.sitzwahlOffen && u.rolle === "user") throw new F(409, "Die Sitzplatzwahl ist gerade geschlossen.");
    const t = await eins(env, `SELECT t.*, tt.mit_sitz FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id
      WHERE t.user_id = ? AND t.lan_id = ? AND t.status != 'storniert'`, u.id, lan.id);
    if (!t) throw new F(409, "Du brauchst zuerst ein Ticket.");
    if (!t.mit_sitz) throw new F(409, "Dein Ticket enthält keinen Sitzplatz.");
    if (t.checkin_at && u.rolle === "user") throw new F(409, "Nach dem Check-in kann nur die Orga deinen Platz ändern.");
    await sitzSetzen(env, t.id, u.id, lan.id, String(c.body.sitzId || ""), false);
    await protokoll(c, "sitz", { sitz: c.body.sitzId });
    return { ok: true };
  },

  async sitzFreigeben(c) {
    const u = brauchtLogin(c);
    const lan = await aktiveLan(c.env);
    await los(c.env, "UPDATE tickets SET seat_id = NULL WHERE user_id = ? AND lan_id = ? AND status != 'storniert' AND checkin_at IS NULL", u.id, lan.id);
    return { ok: true };
  },

  // ---------- Reservierungsgruppen ----------
  async gruppeErstellen(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const e = await einstellungen(env);
    const name = text(body.name, 30, "Gruppenname", true);
    if (name.length < 2) throw new F(400, "Der Gruppenname ist zu kurz.");
    if (await eins(env, "SELECT 1 FROM group_members WHERE user_id = ? AND lan_id = ?", u.id, lan.id)) throw new F(409, "Du bist schon in einer Gruppe.");
    if (await eins(env, "SELECT 1 FROM groups WHERE lan_id = ? AND name_key = ?", lan.id, name.toLowerCase())) throw new F(409, "Diesen Gruppennamen gibt es schon.");
    const jetzt = Date.now();
    const r = await los(env, "INSERT INTO groups (lan_id, name, name_key, owner_id, code, ablauf, created_at) VALUES (?,?,?,?,?,?,?)",
      lan.id, name, name.toLowerCase(), u.id, zufallsCode(6), jetzt + e.gruppeHalteTage * 864e5, jetzt);
    const gid = r.meta.last_row_id;
    await los(env, "INSERT INTO group_members (group_id, user_id, lan_id, created_at) VALUES (?,?,?,?)", gid, u.id, lan.id, jetzt);
    await protokoll(c, "gruppe-erstellt", name);
    return { gruppe: await gruppeDetail(env, gid, u.id) };
  },

  async gruppeBeitreten(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const g = await eins(env, "SELECT * FROM groups WHERE code = ? AND lan_id = ?", String(c.body.code || "").trim().toUpperCase(), lan.id);
    if (!g) throw new F(404, "Zu diesem Code gibt es keine Gruppe.");
    if (await eins(env, "SELECT 1 FROM group_members WHERE user_id = ? AND lan_id = ?", u.id, lan.id)) throw new F(409, "Du bist schon in einer Gruppe – verlasse sie zuerst.");
    await los(env, "INSERT INTO group_members (group_id, user_id, lan_id, created_at) VALUES (?,?,?,?)", g.id, u.id, lan.id, Date.now());
    await protokoll(c, "gruppe-beigetreten", g.name);
    return { gruppe: await gruppeDetail(env, g.id, u.id) };
  },

  async gruppeVerlassen(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const m = await eins(env, "SELECT g.* FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.lan_id = ?", u.id, lan.id);
    if (!m) return { ok: true };
    await mitgliedEntfernen(env, m, u.id);
    await protokoll(c, "gruppe-verlassen", m.name);
    return { ok: true };
  },

  async gruppeEntfernen(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const g = await eigeneGruppe(c, u);
    const ziel = Number(c.body.userId);
    if (ziel === u.id) throw new F(400, "Zum Austreten bitte „Gruppe verlassen“ nehmen.");
    if (!await eins(env, "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", g.id, ziel)) throw new F(404, "Nicht in deiner Gruppe.");
    await mitgliedEntfernen(env, g, ziel);
    return { gruppe: await gruppeDetail(env, g.id, u.id) };
  },

  async gruppeNeuerCode(c) {
    const u = brauchtLogin(c);
    const g = await eigeneGruppe(c, u);
    await los(c.env, "UPDATE groups SET code = ? WHERE id = ?", zufallsCode(6), g.id);
    return { gruppe: await gruppeDetail(c.env, g.id, u.id) };
  },

  // Die Gruppe hält einen Block Sitze frei. Übergeben wird die KOMPLETTE neue Liste.
  async gruppeSitze(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const g = await eigeneGruppe(c, u);
    const e = await einstellungen(env);
    const ids = [...new Set((Array.isArray(c.body.sitzIds) ? c.body.sitzIds : []).map(String))];
    const max = u.rolle === "admin" ? 500 : e.gruppeMaxSitze;
    if (ids.length > max) throw new F(400, "Eine Gruppe darf höchstens " + max + " Plätze vormerken.");
    const mitglieder = (await alle(env, "SELECT user_id FROM group_members WHERE group_id = ?", g.id)).map((m) => m.user_id);
    const jetzt = Date.now();
    for (const id of ids) {
      const s = await eins(env, `SELECT s.*, t.user_id AS t_user, g2.ablauf AS g_ablauf FROM seats s
        LEFT JOIN tickets t ON t.seat_id = s.id LEFT JOIN groups g2 ON g2.id = s.group_id WHERE s.id = ? AND s.lan_id = ?`, id, g.lan_id);
      if (!s) throw new F(404, "Einen der Plätze gibt es nicht.");
      if (s.gesperrt) throw new F(409, "Platz " + s.label + " ist gesperrt.");
      if (s.t_user && !mitglieder.includes(s.t_user)) throw new F(409, "Platz " + s.label + " ist schon belegt.");
      if (s.group_id && s.group_id !== g.id && s.g_ablauf > jetzt) throw new F(409, "Platz " + s.label + " ist von einer anderen Gruppe vorgemerkt.");
    }
    const stmts = [st(env, "UPDATE seats SET group_id = NULL WHERE group_id = ?", g.id)];
    for (const id of ids) stmts.push(st(env, "UPDATE seats SET group_id = ? WHERE id = ?", g.id, id));
    // Wer neu vormerkt, verlängert die Haltefrist.
    stmts.push(st(env, "UPDATE groups SET ablauf = MAX(ablauf, ?) WHERE id = ?", jetzt + e.gruppeHalteTage * 864e5, g.id));
    await env.DB.batch(stmts);
    await protokoll(c, "gruppe-sitze", { gruppe: g.name, anzahl: ids.length });
    return { gruppe: await gruppeDetail(env, g.id, u.id) };
  },

  // ---------- Check-in (Orga) ----------
  async checkinSuchen(c) {
    const { env } = c;
    brauchtOrga(c);
    const lan = await lanAusBody(c);
    const roh = String(c.body.code || "");
    // QR enthält "AGELAN:<32 hex>", abgetippt wird "fccf / ac6e / …"
    const code = codeAus(roh);
    if (code) {
      const t = await eins(env, "SELECT id, lan_id FROM tickets WHERE code = ?", code);
      if (!t) throw new F(404, "Kein Ticket mit diesem Code gefunden.");
      const d = await ticketDetail(env, t.id);
      return { treffer: [d], andereLan: t.lan_id !== lan.id };
    }
    const q = "%" + String(c.body.q || roh).trim().toLowerCase() + "%";
    if (q.length < 4) return { treffer: [] };
    const ids = await alle(env, `SELECT t.id FROM tickets t JOIN users u ON u.id = t.user_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE t.lan_id = ? AND t.status != 'storniert' AND (u.nick_key LIKE ? OR LOWER(u.vorname || ' ' || u.nachname) LIKE ? OR u.email_key LIKE ? OR LOWER(s.label) LIKE ?)
      ORDER BY u.nick_key LIMIT 15`, lan.id, q, q, q, q);
    const out = [];
    for (const r of ids) out.push(await ticketDetail(env, r.id));
    return { treffer: out };
  },

  async checkin(c) {
    const { env, body } = c;
    const u = brauchtOrga(c);
    const t = await eins(env, "SELECT * FROM tickets WHERE id = ?", Number(body.ticketId));
    if (!t || t.status === "storniert") throw new F(404, "Ticket nicht gefunden oder storniert.");
    const jetzt = Date.now();
    if (t.status !== "bezahlt") {
      if (!body.jetztBezahlt) throw new F(409, "Das Ticket ist noch nicht bezahlt.");
      await los(env, "UPDATE tickets SET status = 'bezahlt', bezahlt_at = ?, bezahlt_von = ?, zahlart = ? WHERE id = ?",
        jetzt, u.nick, ZAHLARTEN[body.zahlart] ? body.zahlart : t.zahlart, t.id);
    }
    const schonDa = !!t.checkin_at;
    if (!schonDa) await los(env, "UPDATE tickets SET checkin_at = ?, checkin_von = ? WHERE id = ?", jetzt, u.nick, t.id);
    if (body.orgaNotiz != null) await los(env, "UPDATE tickets SET orga_notiz = ? WHERE id = ?", text(body.orgaNotiz, 500, "Notiz", false), t.id);
    if (!t.otp) await los(env, "UPDATE tickets SET otp = ? WHERE id = ?", otpErzeugen(), t.id);
    await protokoll(c, "checkin", { ticket: t.id });
    return { ticket: await ticketDetail(env, t.id), schonEingecheckt: schonDa };
  },

  async checkinZuruecknehmen(c) {
    brauchtAdmin(c);
    await los(c.env, "UPDATE tickets SET checkin_at = NULL, checkin_von = '' WHERE id = ?", Number(c.body.ticketId));
    await protokoll(c, "checkin-zurueck", { ticket: c.body.ticketId });
    return { ticket: await ticketDetail(c.env, Number(c.body.ticketId)) };
  },

  // ---------- Verwaltung: Tickets/Gäste ----------
  async adminTickets(c) {
    brauchtOrga(c);
    const lan = await lanAusBody(c);
    const zeilen = await alle(c.env, "SELECT id FROM tickets WHERE lan_id = ? ORDER BY created_at DESC", lan.id);
    const tickets = [];
    for (const z of zeilen) tickets.push(await ticketDetail(c.env, z.id));
    return { lan: lanAus(lan), zahlen: await zahlen(c.env, lan), tickets };
  },

  async adminBezahlt(c) {
    const u = brauchtOrga(c);
    const id = Number(c.body.ticketId);
    if (c.body.bezahlt) {
      await los(c.env, "UPDATE tickets SET status = 'bezahlt', bezahlt_at = ?, bezahlt_von = ?, zahlart = COALESCE(?, zahlart) WHERE id = ? AND status = 'offen'",
        Date.now(), u.nick, ZAHLARTEN[c.body.zahlart] ? c.body.zahlart : null, id);
    } else {
      await los(c.env, "UPDATE tickets SET status = 'offen', bezahlt_at = NULL, bezahlt_von = '' WHERE id = ? AND status = 'bezahlt'", id);
    }
    await protokoll(c, c.body.bezahlt ? "bezahlt" : "unbezahlt", { ticket: id });
    return { ticket: await ticketDetail(c.env, id) };
  },

  async adminTicketAendern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const t = await eins(env, "SELECT * FROM tickets WHERE id = ?", Number(body.ticketId));
    if (!t) throw new F(404, "Ticket nicht gefunden.");
    if (body.status === "storniert") {
      await los(env, "UPDATE tickets SET status = 'storniert', seat_id = NULL WHERE id = ?", t.id);
    }
    if (body.typId != null) {
      const typ = await eins(env, "SELECT * FROM ticket_types WHERE id = ? AND lan_id = ?", Number(body.typId), t.lan_id);
      if (!typ) throw new F(404, "Ticketsorte nicht gefunden.");
      await los(env, "UPDATE tickets SET type_id = ?, seat_id = CASE WHEN ? = 1 THEN seat_id ELSE NULL END WHERE id = ?", typ.id, typ.mit_sitz, t.id);
    }
    if (body.preisCent != null) await los(env, "UPDATE tickets SET preis_cent = ? WHERE id = ?", ganz(body.preisCent, "Preis", 0, 1e6), t.id);
    if (body.orgaNotiz != null) await los(env, "UPDATE tickets SET orga_notiz = ? WHERE id = ?", text(body.orgaNotiz, 500, "Notiz", false), t.id);
    if (body.sitzId !== undefined) {
      if (!body.sitzId) await los(env, "UPDATE tickets SET seat_id = NULL WHERE id = ?", t.id);
      else await sitzSetzen(env, t.id, t.user_id, t.lan_id, String(body.sitzId), true);
    }
    if (body.otpNeu) await los(env, "UPDATE tickets SET otp = ? WHERE id = ?", otpErzeugen(), t.id);
    await protokoll(c, "ticket-geaendert", { ticket: t.id, ...body, aktion: undefined });
    return { ticket: await ticketDetail(env, t.id) };
  },

  async adminTicketAnlegen(c) {
    const { env, body } = c;
    const ich = brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const u = await eins(env, "SELECT * FROM users WHERE id = ?", Number(body.userId));
    if (!u) throw new F(404, "Konto nicht gefunden.");
    const typ = await eins(env, "SELECT * FROM ticket_types WHERE id = ? AND lan_id = ?", Number(body.typId), lan.id);
    if (!typ) throw new F(404, "Ticketsorte nicht gefunden.");
    const zahlart = ZAHLARTEN[body.zahlart] ? body.zahlart : "bar";
    const preis = body.preisCent != null ? ganz(body.preisCent, "Preis", 0, 1e6) : typ.preis_cent;
    const bezahlt = !!body.bezahlt || preis === 0;
    const jetzt = Date.now();
    const r = await los(env, `INSERT INTO tickets (lan_id, user_id, type_id, code, status, zahlart, preis_cent, created_at, bezahlt_at, bezahlt_von, orga_notiz)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, lan.id, u.id, typ.id, hex(zufallsBytes(16)), bezahlt ? "bezahlt" : "offen", zahlart, preis, jetzt,
      bezahlt ? jetzt : null, bezahlt ? ich.nick : "", "Angelegt von " + ich.nick);
    await protokoll(c, "ticket-angelegt", { fuer: u.nick, typ: typ.name });
    return { ticket: await ticketDetail(env, r.meta.last_row_id) };
  },

  // ---------- Verwaltung: Gruppen ----------
  async adminGruppen(c) {
    brauchtOrga(c);
    const lan = await lanAusBody(c);
    const gs = await alle(c.env, "SELECT id FROM groups WHERE lan_id = ? ORDER BY created_at", lan.id);
    const out = [];
    for (const g of gs) out.push(await gruppeDetail(c.env, g.id, null, true));
    return { gruppen: out };
  },

  async adminGruppeAendern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const g = await eins(env, "SELECT * FROM groups WHERE id = ?", Number(body.gruppeId));
    if (!g) throw new F(404, "Gruppe nicht gefunden.");
    if (body.loeschen) {
      await env.DB.batch([
        st(env, "UPDATE seats SET group_id = NULL WHERE group_id = ?", g.id),
        st(env, "DELETE FROM group_members WHERE group_id = ?", g.id),
        st(env, "DELETE FROM groups WHERE id = ?", g.id),
      ]);
      await protokoll(c, "gruppe-geloescht", g.name);
      return { ok: true };
    }
    if (body.ablauf) {
      const ms = Date.parse(datumPruefen(body.ablauf, "Ablauf") + "T23:59:59");
      await los(env, "UPDATE groups SET ablauf = ? WHERE id = ?", ms, g.id);
    }
    if (body.name) await los(env, "UPDATE groups SET name = ?, name_key = ? WHERE id = ?", text(body.name, 30, "Name", true), String(body.name).trim().toLowerCase(), g.id);
    if (Array.isArray(body.sitzIds)) {
      const stmts = [st(env, "UPDATE seats SET group_id = NULL WHERE group_id = ?", g.id)];
      for (const id of body.sitzIds) stmts.push(st(env, "UPDATE seats SET group_id = ? WHERE id = ? AND lan_id = ? AND gesperrt = 0", g.id, String(id), g.lan_id));
      await env.DB.batch(stmts);
    }
    return { gruppe: await gruppeDetail(env, g.id, null, true) };
  },

  // ---------- Verwaltung: Ticketsorten ----------
  async adminTickettypen(c) {
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const typen = await alle(c.env, "SELECT * FROM ticket_types WHERE lan_id = ? ORDER BY sort, id", lan.id);
    const verkauft = await alle(c.env, "SELECT type_id, COUNT(*) AS n FROM tickets WHERE lan_id = ? AND status != 'storniert' GROUP BY type_id", lan.id);
    return { tickettypen: typen.map((t) => ({ ...typAus(t), verkauft: (verkauft.find((v) => v.type_id === t.id) || {}).n || 0 })) };
  },

  async adminTickettypSpeichern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const t = body.typ || {};
    const extras = (Array.isArray(t.extras) ? t.extras : []).slice(0, 5).map((x) => ({ name: text(x.name, 60, "Extra", true), preisCent: ganz(x.preisCent, "Extra-Preis", 0, 1e6) }));
    const features = (Array.isArray(t.features) ? t.features : []).map((f) => text(f, 120, "Leistung", false)).filter(Boolean).slice(0, 12);
    const werte = [
      ganz(t.sort || 0, "Sortierung", 0, 999), text(t.name, 80, "Name", true), text(t.beschreibung, 1000, "Beschreibung", false),
      JSON.stringify(features), ganz(t.preisCent, "Preis", 0, 1e6), JSON.stringify(extras),
      t.mitSitz ? 1 : 0, t.aktiv ? 1 : 0, t.kaufbar ? 1 : 0, ganz(t.limit || 0, "Limit", 0, 100000),
      datumPruefen(t.von, "Verfügbar von"), datumPruefen(t.bis, "Verfügbar bis"),
    ];
    if (t.id) {
      await los(env, `UPDATE ticket_types SET sort=?, name=?, beschreibung=?, features=?, preis_cent=?, extras=?, mit_sitz=?, aktiv=?, kaufbar=?, limit_anzahl=?, von=?, bis=? WHERE id = ? AND lan_id = ?`, ...werte, Number(t.id), lan.id);
    } else {
      await los(env, `INSERT INTO ticket_types (sort, name, beschreibung, features, preis_cent, extras, mit_sitz, aktiv, kaufbar, limit_anzahl, von, bis, lan_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...werte, lan.id);
    }
    await protokoll(c, "tickettyp", t.name);
    return AKTIONEN.adminTickettypen(c);
  },

  async adminTickettypLoeschen(c) {
    brauchtAdmin(c);
    const id = Number(c.body.id);
    if (await eins(c.env, "SELECT 1 FROM tickets WHERE type_id = ? LIMIT 1", id)) throw new F(409, "Für diese Sorte gibt es schon Tickets – stattdessen „aktiv“ und „kaufbar“ ausschalten.");
    await los(c.env, "DELETE FROM ticket_types WHERE id = ?", id);
    return AKTIONEN.adminTickettypen(c);
  },

  // ---------- Verwaltung: Gutscheine ----------
  async adminGutscheine(c) {
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const zeilen = await alle(c.env, `SELECT c.*, (SELECT COUNT(*) FROM tickets t WHERE t.coupon_id = c.id AND t.status != 'storniert') AS eingeloest,
      (SELECT GROUP_CONCAT(u.nick, ', ') FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.coupon_id = c.id AND t.status != 'storniert') AS nutzer
      FROM coupons c WHERE c.lan_id = ? ORDER BY c.created_at DESC`, lan.id);
    return { gutscheine: zeilen.map((z) => ({ id: z.id, code: z.code, typ: z.typ, wert: z.wert, name: z.name, max: z.max_einloesungen, eingeloest: z.eingeloest, nutzer: z.nutzer || "" })) };
  },

  async adminGutscheinSpeichern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const g = body.gutschein || {};
    const typ = g.typ === "prozent" ? "prozent" : "betrag";
    const wert = ganz(g.wert, "Wert", 1, typ === "prozent" ? 100 : 1e6);
    const code = text(g.code || zufallsCode(8), 30, "Code", true).toUpperCase().replace(/\s+/g, "");
    if (g.id) await los(env, "UPDATE coupons SET code=?, typ=?, wert=?, name=?, max_einloesungen=? WHERE id = ?", code, typ, wert, text(g.name, 80, "Name", false), ganz(g.max || 1, "Max", 1, 10000), Number(g.id));
    else await los(env, "INSERT INTO coupons (lan_id, code, typ, wert, name, max_einloesungen, created_at) VALUES (?,?,?,?,?,?,?)", lan.id, code, typ, wert, text(g.name, 80, "Name", false), ganz(g.max || 1, "Max", 1, 10000), Date.now());
    return AKTIONEN.adminGutscheine(c);
  },

  async adminGutscheinLoeschen(c) {
    brauchtAdmin(c);
    if (await eins(c.env, "SELECT 1 FROM tickets WHERE coupon_id = ? AND status != 'storniert'", Number(c.body.id))) throw new F(409, "Der Gutschein wurde schon eingelöst.");
    await los(c.env, "DELETE FROM coupons WHERE id = ?", Number(c.body.id));
    return AKTIONEN.adminGutscheine(c);
  },

  // ---------- Verwaltung: Sitzplan ----------
  async adminPlanSpeichern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const plan = body.plan || {};
    const breite = ganz(plan.breite, "Breite", 4, 200), hoehe = ganz(plan.hoehe, "Höhe", 4, 200);
    const sitze = Array.isArray(body.sitze) ? body.sitze : [];
    if (sitze.length > 2000) throw new F(400, "Zu viele Plätze.");
    const labels = new Set();
    const neu = sitze.map((s) => {
      const label = text(s.label, 12, "Platzname", true);
      if (labels.has(label.toLowerCase())) throw new F(400, "Der Platzname „" + label + "“ kommt doppelt vor.");
      labels.add(label.toLowerCase());
      const x = Number(s.x), y = Number(s.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new F(400, "Ungültige Position bei " + label);
      return { id: String(s.id || zufallsId()).slice(0, 32), label, x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2, gesperrt: s.gesperrt ? 1 : 0 };
    });
    const deko = (Array.isArray(plan.deko) ? plan.deko : []).slice(0, 300).map((d) => ({
      id: String(d.id || zufallsId()).slice(0, 32), typ: ["flaeche", "text", "wand"].includes(d.typ) ? d.typ : "flaeche",
      x: Number(d.x) || 0, y: Number(d.y) || 0, w: Math.max(0.2, Number(d.w) || 1), h: Math.max(0.2, Number(d.h) || 1),
      text: text(d.text, 60, "Beschriftung", false), farbe: text(d.farbe, 12, "Farbe", false) || "grau",
    }));
    const alt = await alle(env, "SELECT s.id, s.label, t.id AS t_id FROM seats s LEFT JOIN tickets t ON t.seat_id = s.id WHERE s.lan_id = ?", lan.id);
    const neueIds = new Set(neu.map((s) => s.id));
    const besetzt = alt.filter((s) => s.t_id && !neueIds.has(s.id));
    if (besetzt.length) throw new F(409, "Diese Plätze sind vergeben und können nicht gelöscht werden: " + besetzt.map((s) => s.label).join(", ") + ". Erst die Gäste umsetzen.");
    const altIds = new Set(alt.map((s) => s.id));
    const stmts = [];
    for (const s of alt) if (!neueIds.has(s.id)) stmts.push(st(env, "DELETE FROM seats WHERE id = ?", s.id));
    // Labels erst freiräumen, damit Umbenennungen (A1 <-> A2) nicht am UNIQUE-Index scheitern.
    for (const s of neu) if (altIds.has(s.id)) stmts.push(st(env, "UPDATE seats SET label = ? WHERE id = ?", "~" + s.id, s.id));
    for (const s of neu) {
      if (altIds.has(s.id)) stmts.push(st(env, "UPDATE seats SET label = ?, x = ?, y = ?, gesperrt = ? WHERE id = ?", s.label, s.x, s.y, s.gesperrt, s.id));
      else stmts.push(st(env, "INSERT INTO seats (id, lan_id, label, x, y, gesperrt) VALUES (?,?,?,?,?,?)", s.id, lan.id, s.label, s.x, s.y, s.gesperrt));
    }
    stmts.push(st(env, "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", "plan:" + lan.id, JSON.stringify({ breite, hoehe, deko })));
    await env.DB.batch(stmts);
    await protokoll(c, "plan", { sitze: neu.length });
    return { ok: true, sitze: neu.length };
  },

  // ---------- Verwaltung: LANs ----------
  async adminLans(c) {
    brauchtOrga(c);
    const lans = await alle(c.env, "SELECT * FROM lans ORDER BY id DESC");
    const out = [];
    for (const l of lans) out.push({ ...lanAus(l), zahlen: await zahlen(c.env, l) });
    return { lans: out };
  },

  async adminLanSpeichern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const l = body.lan || {};
    const werte = [
      text(l.name, 80, "Name", true), datumPruefen(l.start, "Start"), datumPruefen(l.ende, "Ende"),
      ganz(l.gaesteLimit || 0, "Gäste-Limit", 0, 100000), l.verkaufOffen ? 1 : 0,
      text(l.ort, 120, "Ort", false), text(l.adresse, 200, "Adresse", false), text(l.beschreibung, 4000, "Beschreibung", false),
    ];
    let id = Number(l.id) || 0;
    if (id) {
      await los(env, "UPDATE lans SET name=?, start=?, ende=?, gaeste_limit=?, verkauf_offen=?, ort=?, adresse=?, beschreibung=? WHERE id = ?", ...werte, id);
    } else {
      const r = await los(env, "INSERT INTO lans (name, start, ende, gaeste_limit, verkauf_offen, ort, adresse, beschreibung, aktiv, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)", ...werte, Date.now());
      id = r.meta.last_row_id;
      // Neue LAN übernimmt Sitzplan und Ticketsorten der bisher aktiven.
      const vorlage = await aktiveLan(env);
      const stmts = [];
      for (const s of await alle(env, "SELECT * FROM seats WHERE lan_id = ?", vorlage.id)) {
        stmts.push(st(env, "INSERT INTO seats (id, lan_id, label, x, y, gesperrt) VALUES (?,?,?,?,?,?)", zufallsId(), id, s.label, s.x, s.y, s.gesperrt));
      }
      for (const t of await alle(env, "SELECT * FROM ticket_types WHERE lan_id = ?", vorlage.id)) {
        stmts.push(st(env, "INSERT INTO ticket_types (lan_id, sort, name, beschreibung, features, preis_cent, extras, mit_sitz, aktiv, kaufbar, limit_anzahl) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          id, t.sort, t.name, t.beschreibung, t.features, t.preis_cent, t.extras, t.mit_sitz, t.aktiv, t.kaufbar, t.limit_anzahl));
      }
      const plan = await eins(env, "SELECT value FROM settings WHERE key = ?", "plan:" + vorlage.id);
      if (plan) stmts.push(st(env, "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", "plan:" + id, plan.value));
      if (stmts.length) await env.DB.batch(stmts);
    }
    if (l.aktiv) await env.DB.batch([st(env, "UPDATE lans SET aktiv = 0"), st(env, "UPDATE lans SET aktiv = 1 WHERE id = ?", id)]);
    await protokoll(c, "lan", l.name);
    return AKTIONEN.adminLans(c);
  },

  // ---------- Verwaltung: News ----------
  async adminNewsSpeichern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const x = body.news || {};
    const werte = [text(x.titel, 150, "Titel", true), text(x.teaser, 400, "Teaser", false), text(x.text, 20000, "Text", false), datumPruefen(x.datum, "Datum") || heute()];
    if (x.id) await los(env, "UPDATE news SET titel=?, teaser=?, text=?, datum=? WHERE id = ?", ...werte, Number(x.id));
    else await los(env, "INSERT INTO news (titel, teaser, text, datum, created_at) VALUES (?,?,?,?,?)", ...werte, Date.now());
    return { ok: true };
  },

  async adminNewsLoeschen(c) {
    brauchtAdmin(c);
    await los(c.env, "DELETE FROM news WHERE id = ?", Number(c.body.id));
    return { ok: true };
  },

  // ---------- Verwaltung: Einstellungen ----------
  async adminEinstellungen(c) {
    brauchtAdmin(c);
    return { einstellungen: await einstellungen(c.env) };
  },

  async adminEinstellungSpeichern(c) {
    brauchtAdmin(c);
    const key = String(c.body.key || "");
    if (!(key in STANDARD)) throw new F(400, "Unbekannte Einstellung.");
    const wert = JSON.stringify(c.body.wert);
    if (wert.length > 100000) throw new F(400, "Zu groß.");
    await los(c.env, "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", key, wert);
    await protokoll(c, "einstellung", key);
    return { einstellungen: await einstellungen(c.env) };
  },

  // ---------- Verwaltung: Benutzer ----------
  async adminBenutzer(c) {
    brauchtAdmin(c);
    const lan = await aktiveLan(c.env);
    const zeilen = await alle(c.env, `SELECT u.*, t.status AS t_status FROM users u
      LEFT JOIN tickets t ON t.user_id = u.id AND t.lan_id = ? AND t.status != 'storniert' ORDER BY u.created_at DESC`, lan.id);
    return { benutzer: zeilen.map((u) => ({ ...nutzerOeffentlich(u), ticket: u.t_status || "" })) };
  },

  async adminBenutzerAendern(c) {
    const { env, body } = c;
    const ich = brauchtAdmin(c);
    const u = await eins(env, "SELECT * FROM users WHERE id = ?", Number(body.userId));
    if (!u) throw new F(404, "Konto nicht gefunden.");
    if (body.rolle) {
      if (!ROLLEN.includes(body.rolle)) throw new F(400, "Unbekannte Rolle.");
      if (u.id === ich.id && body.rolle !== "admin") throw new F(400, "Du kannst dir die Veranstalter-Rolle nicht selbst nehmen.");
      await los(env, "UPDATE users SET rolle = ? WHERE id = ?", body.rolle, u.id);
    }
    if (body.gesperrt != null) {
      if (u.id === ich.id) throw new F(400, "Du kannst dich nicht selbst sperren.");
      await los(env, "UPDATE users SET gesperrt = ?, token_ver = token_ver + 1 WHERE id = ?", body.gesperrt ? 1 : 0, u.id);
    }
    let neuesPasswort = null;
    if (body.passwortZuruecksetzen) {
      neuesPasswort = zufallsCode(10);
      await los(env, "UPDATE users SET pw = ?, token_ver = token_ver + 1 WHERE id = ?", await passwortHashen(neuesPasswort), u.id);
    }
    await protokoll(c, "benutzer", { nutzer: u.nick, rolle: body.rolle, gesperrt: body.gesperrt, pw: !!neuesPasswort });
    return { ok: true, neuesPasswort };
  },

  async adminProtokoll(c) {
    brauchtAdmin(c);
    const zeilen = await alle(c.env, "SELECT l.*, u.nick FROM log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 300");
    return { eintraege: zeilen };
  },
};

// ---------------------------------------------------------------------------
// Bausteine für die Aktionen
// ---------------------------------------------------------------------------
function lanAus(l) {
  return { id: l.id, name: l.name, start: l.start, ende: l.ende, gaesteLimit: l.gaeste_limit, verkaufOffen: !!l.verkauf_offen, ort: l.ort, adresse: l.adresse, beschreibung: l.beschreibung, aktiv: !!l.aktiv };
}

function otpErzeugen() {
  return zufallsCode(6);
}

// "AGELAN:<hex>", ".../#/t/<hex>", "fccf / ac6e / …" oder nackter Code -> 32 hex
function codeAus(roh) {
  const s = String(roh || "").toLowerCase().trim();
  const m = s.match(/(?:\/t\/|agelan:)([0-9a-f]{32})(?![0-9a-f])/);
  if (m) return m[1];
  const kompakt = s.replace(/[\s/\-]/g, "");
  return /^[0-9a-f]{32}$/.test(kompakt) ? kompakt : null;
}

async function mitZugang(env, t) {
  if (t && t.checkinAt && t.status !== "storniert") t.zugang = await zugangsdaten(env, t);
  return t;
}

async function zugangsdaten(env, t) {
  const n = (await einstellungen(env)).netz;
  return {
    benutzer: n.benutzer === "code" ? t.code.slice(0, 8) : t.nutzer.nick,
    passwort: t.otp, ssid: n.ssid, wlanPasswort: n.wlanPasswort, portal: n.portal, hinweis: n.hinweis,
  };
}

async function preisBerechnen(c, lan) {
  const { env, body } = c;
  const typ = await eins(env, "SELECT * FROM ticket_types WHERE id = ? AND lan_id = ?", Number(body.typId), lan.id);
  if (!typ) throw new F(404, "Diese Ticketsorte gibt es nicht.");
  const angebot = parse(typ.extras, []);
  const gewaehlt = Array.isArray(body.extras) ? body.extras.map(String) : [];
  const extras = angebot.filter((x) => gewaehlt.includes(x.name));
  let summe = typ.preis_cent + extras.reduce((s, x) => s + x.preisCent, 0);
  let rabatt = 0, couponId = null, couponText = "";
  const code = String(body.gutschein || "").trim().toUpperCase();
  if (code) {
    const cp = await eins(env, "SELECT * FROM coupons WHERE code = ? AND lan_id = ?", code, lan.id);
    if (!cp) throw new F(404, "Diesen Gutschein-Code gibt es nicht.");
    const benutzt = await eins(env, "SELECT COUNT(*) AS n FROM tickets WHERE coupon_id = ? AND status != 'storniert'", cp.id);
    if (benutzt.n >= cp.max_einloesungen) throw new F(409, "Dieser Gutschein ist schon eingelöst.");
    rabatt = cp.typ === "prozent" ? Math.round(summe * cp.wert / 100) : Math.min(summe, cp.wert);
    couponId = cp.id;
    couponText = cp.name || (cp.typ === "prozent" ? cp.wert + " %" : (cp.wert / 100).toFixed(2) + " €");
  }
  return { typRoh: typ, extras, summeCent: summe, rabattCent: rabatt, endCent: summe - rabatt, couponId, couponText };
}

async function sitzSetzen(env, ticketId, userId, lanId, sitzId, durchOrga) {
  const s = await eins(env, `SELECT s.*, g.ablauf AS g_ablauf, g.name AS g_name FROM seats s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = ? AND s.lan_id = ?`, sitzId, lanId);
  if (!s) throw new F(404, "Diesen Platz gibt es nicht.");
  if (s.gesperrt && !durchOrga) throw new F(409, "Dieser Platz ist gesperrt.");
  const belegt = await eins(env, "SELECT id FROM tickets WHERE seat_id = ?", sitzId);
  if (belegt && belegt.id !== ticketId) throw new F(409, "Platz " + s.label + " ist schon vergeben.");
  if (!durchOrga && s.group_id && s.g_ablauf > Date.now()) {
    const m = await eins(env, "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", s.group_id, userId);
    if (!m) throw new F(409, "Platz " + s.label + " ist für die Gruppe „" + s.g_name + "“ vorgemerkt.");
  }
  // Der UNIQUE-Index auf seat_id fängt den Fall ab, dass jemand in derselben Millisekunde zugreift.
  await los(env, "UPDATE tickets SET seat_id = ? WHERE id = ?", sitzId, ticketId);
}

async function eigeneGruppe(c, u) {
  const lan = await aktiveLan(c.env);
  const g = await eins(c.env, "SELECT g.* FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.lan_id = ?", u.id, lan.id);
  if (!g) throw new F(404, "Du bist in keiner Gruppe.");
  if (g.owner_id !== u.id && u.rolle !== "admin") throw new F(403, "Das darf nur die Gruppenleitung.");
  return g;
}

async function mitgliedEntfernen(env, g, userId) {
  await los(env, "DELETE FROM group_members WHERE group_id = ? AND user_id = ?", g.id, userId);
  const rest = await alle(env, "SELECT user_id FROM group_members WHERE group_id = ? ORDER BY created_at", g.id);
  if (!rest.length) {
    await env.DB.batch([st(env, "UPDATE seats SET group_id = NULL WHERE group_id = ?", g.id), st(env, "DELETE FROM groups WHERE id = ?", g.id)]);
  } else if (g.owner_id === userId) {
    await los(env, "UPDATE groups SET owner_id = ? WHERE id = ?", rest[0].user_id, g.id);
  }
}

async function gruppeDetail(env, gid, fuerUser, alsOrga) {
  const g = await eins(env, "SELECT g.*, u.nick AS owner_nick FROM groups g JOIN users u ON u.id = g.owner_id WHERE g.id = ?", gid);
  if (!g) return null;
  const mitglieder = await alle(env, `SELECT u.id, u.nick, t.status AS t_status, s.label AS sitz, s.group_id AS sitz_gruppe
    FROM group_members gm JOIN users u ON u.id = gm.user_id
    LEFT JOIN tickets t ON t.user_id = u.id AND t.lan_id = gm.lan_id AND t.status != 'storniert'
    LEFT JOIN seats s ON s.id = t.seat_id WHERE gm.group_id = ? ORDER BY gm.created_at`, gid);
  const sitze = await alle(env, "SELECT s.id, s.label, t.user_id AS t_user FROM seats s LEFT JOIN tickets t ON t.seat_id = s.id WHERE s.group_id = ? ORDER BY s.y, s.x", gid);
  const aktiv = g.ablauf > Date.now();
  const besetzt = sitze.filter((s) => s.t_user).length;
  const darfCode = alsOrga || (fuerUser && mitglieder.some((m) => m.id === fuerUser));
  return {
    id: g.id, name: g.name, leitung: g.owner_nick, leitungId: g.owner_id, istLeitung: fuerUser === g.owner_id,
    code: darfCode ? g.code : "", ablauf: g.ablauf, aktiv,
    mitglieder: mitglieder.map((m) => ({ id: m.id, nick: m.nick, ticket: m.t_status || "", sitz: m.sitz || "" })),
    sitze: sitze.map((s) => ({ id: s.id, label: s.label, besetzt: !!s.t_user })),
    fuellung: sitze.length ? besetzt + "/" + sitze.length : "0/0",
  };
}
