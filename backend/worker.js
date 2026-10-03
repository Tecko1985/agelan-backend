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
//   PORTAL_SECRET (Secret) = gemeinsames Geheimnis mit dem Anmeldeportal der
//                            Halle (portal.lan). Ohne Secret ist die Aktion
//                            portalAnmeldung gesperrt. Siehe pflege/portal-anbindung.md.
//   PAYPAL_CLIENT_ID, PAYPAL_SECRET (Secrets) = REST-App aus developer.paypal.com.
//   PAYPAL_MODE   (Var/Secret) = "sandbox" (Testgeld) oder "live". Fehlt einer
//                            der Schlüssel, ist „PayPal direkt“ abgeschaltet.
//
// Der Demo-Modus der Website (demo.js) lädt GENAU diese Datei im Browser und
// hängt sie an eine SQLite-Datenbank im Browser (sql.js). Deshalb: nur
// Web-Standards benutzen (fetch-API, crypto.subtle), nichts Worker-Spezifisches.
// ===========================================================================

const PW_MIN = 8;
const TOKEN_TAGE = 60;
const PBKDF2_RUNDEN = 100000; // Obergrenze in Workers
const ROLLEN = ["user", "orga", "admin"];
const ZAHLARTEN = { paypal_direkt: "PayPal", paypal: "PayPal (Freunde)", ueberweisung: "Überweisung", bar: "Bar" };

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
  // Sitzplan-Vorlagen: Plan (Fläche, Deko) + Plätze inkl. Sperren/Orga, für neue LANs abrufbar.
  `CREATE TABLE IF NOT EXISTS plan_vorlagen (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, daten TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // Anmeldungen am Hallen-Portal: welches Gerät (MAC/IP) mit welchem Ticket online ging.
  `CREATE TABLE IF NOT EXISTS netz_logins (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lan_id INTEGER,
    ticket_id INTEGER, mac TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
    nutzer TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 0, grund TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS netz_logins_mac ON netz_logins(mac, at)`,
  `CREATE INDEX IF NOT EXISTS netz_logins_ticket ON netz_logins(ticket_id)`,
  // Ticket-Übergabe zwischen zwei Konten: an_id bittet, von_id bestätigt (offene Anfragen; erledigte werden gelöscht).
  `CREATE TABLE IF NOT EXISTS uebergaben (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lan_id INTEGER NOT NULL,
    von_id INTEGER NOT NULL, an_id INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uebergaben_an ON uebergaben(lan_id, an_id)`,
  `CREATE TABLE IF NOT EXISTS log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
    user_id INTEGER, aktion TEXT NOT NULL, details TEXT NOT NULL DEFAULT '')`,
];

// Spalten, die nach dem ersten Livegang dazukamen. ALTER TABLE scheitert, wenn
// es die Spalte schon gibt – das ist hier der Normalfall und wird geschluckt.
const MIGRATIONEN = [
  "ALTER TABLE users ADD COLUMN discord_id TEXT NOT NULL DEFAULT ''",   // für die AgeLan-App (Discord-DMs)
  "ALTER TABLE users ADD COLUMN streamer INTEGER NOT NULL DEFAULT 0",   // darf sich im Streamplan eintragen
  "ALTER TABLE seats ADD COLUMN orga INTEGER NOT NULL DEFAULT 0",       // früher „für die Orga reserviert“ – abgeschafft
  "UPDATE seats SET gesperrt = 1, orga = 0 WHERE orga = 1",             // alte Orga-Plätze bleiben für Gäste zu (jetzt gesperrt)
  "ALTER TABLE seats ADD COLUMN stufe INTEGER NOT NULL DEFAULT 1",      // Ausbaustufe des Platzes (1 = immer da)
  "ALTER TABLE lans ADD COLUMN stufe_aktiv INTEGER NOT NULL DEFAULT 1", // bis zu dieser Ausbaustufe sind Plätze buchbar
  "ALTER TABLE lans ADD COLUMN stufe_auto INTEGER NOT NULL DEFAULT 1",  // nächste Stufe automatisch, wenn die aktive ausverkauft ist
  "ALTER TABLE users ADD COLUMN vorort_lan INTEGER",                    // vor Ort von der Orga angelegt (für diese LAN)
  "ALTER TABLE netz_logins ADD COLUMN quelle TEXT NOT NULL DEFAULT ''", // IP des Absenders (Portal-Server bzw. Angreifer)
  "ALTER TABLE tickets ADD COLUMN paypal_order TEXT NOT NULL DEFAULT ''",   // PayPal-Bestellung (Checkout) zum Ticket
  "ALTER TABLE tickets ADD COLUMN paypal_capture TEXT NOT NULL DEFAULT ''", // PayPal-Transaktions-ID nach erfolgreicher Zahlung
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
    arten: { paypal_direkt: true, paypal: false, ueberweisung: true, bar: true },
    paypal: "", paypalMe: "", iban: "", kontoinhaber: "", bank: "",
    hinweis: "Bitte gib bei Überweisung deinen Nickname und die ersten 8 Zeichen deines Ticket-Codes als Verwendungszweck an.",
    fristTage: 14,
  },
  faq: [
    { f: "Wie läuft das mit dem Essen?", a: "Vor Ort gibt es Catering zu fairen Preisen. Bestellt wird bequem über die AgeLan-App, für die dein Konto beim Check-in freigeschaltet wird." },
    { f: "Und Getränke?", a: "Kalte Getränke werden vor Ort verkauft. Bier darf wegen des Brauerei-Vertrags der Halle nicht mitgebracht werden." },
    { f: "Wo schlafe ich?", a: "Es gibt einen abgetrennten Schlafbereich. Wer es ruhiger mag, findet Pensionen und Hotels in Volkmarsen." },
    { f: "Ab welchem Alter darf ich kommen?", a: "Ab 18 ohne Weiteres. Ab 16 mit einer volljährigen Aufsichtsperson, die selbst zur LAN kommt, und unterschriebenem Muttizettel." },
    { f: "Wann kann ich meinen Platz wählen?", a: "Sobald die Orga deine Zahlung bestätigt hat, suchst du dir deinen Platz im Sitzplan aus. Wer zusammen sitzen will, merkt vorher mit einer Reservierungsgruppe einen Block vor." },
    { f: "Gibt es Internet?", a: "Ja. Die Freischaltung bekommst du beim Check-in." },
  ],
  texte: { anfahrt: "", impressum: "", datenschutz: "", agb: "" },
  // Internet-Zugang: steht nach dem Check-in auf dem Handy des Gastes (Ticket-QR bzw. Konto).
  netz: { ssid: "", wlanPasswort: "", portal: "", benutzer: "nick", hinweis: "Verbinde dich mit dem Netz und melde dich im Portal mit diesen Daten an.", maxGeraete: 3, aufbewahrungTage: 30 },
  sponsoren: [],
  gaesteOeffentlich: true,
  sitzwahlOffen: true,
  gruppeHalteTage: 21,
  gruppeMaxSitze: 10,
  // Zeitliche Grenzen für Reservierungsgruppen (siehe gruppeGrenze)
  gruppenErlaubt: true,       // Gäste dürfen Gruppen gründen
  gruppeVerlaengern: true,    // erneutes Vormerken verlängert die Haltefrist
  gruppeMaxTage: 60,          // höchstens so lange ab Gründung (0 = ohne Grenze)
  gruppeStichtagTage: 7,      // spätestens so viele Tage vor LAN-Beginn (-1 = aus)
};
const OEFFENTLICHE_EINSTELLUNGEN = ["seite", "highlights", "zahlung", "faq", "texte", "sponsoren", "gaesteOeffentlich", "sitzwahlOffen", "gruppeHalteTage", "gruppeMaxSitze", "gruppenErlaubt", "gruppeVerlaengern", "gruppeMaxTage", "gruppeStichtagTage"];

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const cors = corsKopf(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (/\/check_otp\/?$/.test(url.pathname)) return checkOtp(request, env, cors);
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
// Mehrere SELECTs in EINER Runde zur Datenbank (D1-Batch). Jede einzelne Abfrage kostet
// sonst eine eigene Netzrunde (~20–30 ms) – das war der größte Bremser der Seite.
async function lesen(env, ...abfragen) {
  const r = await env.DB.batch(abfragen.map(([sql, ...p]) => st(env, sql, ...p)));
  return r.map((x) => (x && x.results) || []);
}
// Die aktive LAN als SQL-Ausdruck – damit sie im selben Batch wie die übrigen Abfragen steht.
const AKTIVE_LAN = "COALESCE((SELECT id FROM lans WHERE aktiv = 1 ORDER BY id DESC LIMIT 1), (SELECT id FROM lans ORDER BY id DESC LIMIT 1))";
// lanId: Zahl → Platzhalter, sonst der Ausdruck oben.
const lanBed = (lanId) => (typeof lanId === "number" && lanId > 0 ? ["?", [lanId]] : [AKTIVE_LAN, []]);
const EINSTELLUNGEN_SQL = "SELECT key, value FROM settings WHERE key NOT LIKE 'plan:%' AND key NOT LIKE 'klon:%'";

let istBereit = false;
async function bereitmachen(env) {
  if (istBereit) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  // Parallel statt nacheinander: schlägt fast immer fehl („gibt es schon“), kostet aber je eine Runde.
  await Promise.all(MIGRATIONEN.map((m) => env.DB.prepare(m).run().catch(() => { /* gibt es schon */ })));
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
    "Vier Tage Age of Empires 2 mit der geilsten Community.", jetzt);
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
  return einstellungenAus(await alle(env, EINSTELLUNGEN_SQL));
}
function einstellungenAus(zeilen) {
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
// Gegen Massen-Registrierungen: je IP höchstens 5 neue Konten pro Stunde.
const anmeldungen = new Map();
function registrierungZaehlen(ip) {
  const e = anmeldungen.get(ip);
  if (!e || e.bis < Date.now()) { anmeldungen.set(ip, { anzahl: 1, bis: Date.now() + 60 * 60e3 }); return; }
  if (e.anzahl >= 5) throw new F(429, "Zu viele neue Konten von diesem Anschluss. Bitte später nochmal.");
  e.anzahl++;
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
// "JJJJ-MM-TT" + "hh:mm:ss" als Berliner Ortszeit -> Millisekunden (Sommer-/Winterzeit beachtet).
function berlinMs(datum, zeit) {
  const utc = Date.parse(datum + "T" + zeit + "Z");
  const t = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utc)).map((p) => [p.type, p.value]));
  const versatz = Date.parse(`${t.year}-${t.month}-${t.day}T${t.hour}:${t.minute}:${t.second}Z`) - utc;
  return utc - versatz;
}
function sichereUrl(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  // Relative Logo-Pfade wie "img/x.png" erlauben, sonst nur http(s) und mailto.
  if (/^(https?:|mailto:)/i.test(s) || /^[\w./-]+$/.test(s) && !s.includes(":")) return s;
  return "";
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
    streamer: !!u.streamer, vorOrt: u.vorort_lan || null,
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
const TICKET_SQL = `SELECT t.*, u.nick, u.vorname, u.nachname, u.email, u.geburtsdatum, u.discord,
      tt.name AS typ_name, tt.features AS typ_features, tt.mit_sitz, tt.beschreibung AS typ_beschreibung,
      s.label AS sitz_label, l.name AS lan_name, l.start AS lan_start, l.ende AS lan_ende, l.ort AS lan_ort, l.adresse AS lan_adresse,
      g.name AS gruppe_name, c.code AS coupon_code
    FROM tickets t JOIN users u ON u.id = t.user_id JOIN ticket_types tt ON tt.id = t.type_id
    JOIN lans l ON l.id = t.lan_id LEFT JOIN seats s ON s.id = t.seat_id
    LEFT JOIN group_members gm ON gm.user_id = t.user_id AND gm.lan_id = t.lan_id
    LEFT JOIN groups g ON g.id = gm.group_id LEFT JOIN coupons c ON c.id = t.coupon_id`;
async function ticketDetail(env, ticketId) {
  const t = await eins(env, TICKET_SQL + " WHERE t.id = ?", ticketId);
  return t ? ticketAus(t) : null;
}
// Für den Gast selbst: ohne interne Orga-Felder.
function gastTicket(t) {
  if (!t) return t;
  const { orgaNotiz, bezahltVon, checkinVon, ...rest } = t;
  return rest;
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
  return zahlenAus(lan, await lesen(env, ...zahlenAbfragen(lan.id)));
}
// Gesperrte Plätze zählen nicht als buchbar.
function zahlenAbfragen(lanId) {
  const [w, p] = lanBed(lanId);
  return [
    [`SELECT COUNT(*) AS n FROM seats WHERE lan_id = ${w} AND gesperrt = 0 AND stufe <= (SELECT stufe_aktiv FROM lans WHERE id = ${w})`, ...p, ...p],
    [`SELECT COUNT(*) AS n FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE t.lan_id = ${w} AND t.status != 'storniert' AND tt.mit_sitz = 1 AND COALESCE(s.gesperrt, 0) = 0`, ...p],
    [`SELECT COUNT(*) AS n, SUM(status = 'bezahlt') AS bezahlt FROM tickets WHERE lan_id = ${w} AND status != 'storniert'`, ...p],
  ];
}
function zahlenAus(lan, [[sitze], [mitSitz], [gaeste]]) {
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
    const [[lan], einstZeilen, typen, verkauft, ...rest] = await lesen(env,
      [`SELECT * FROM lans WHERE id = ${AKTIVE_LAN}`],
      [EINSTELLUNGEN_SQL],
      [`SELECT * FROM ticket_types WHERE lan_id = ${AKTIVE_LAN} AND aktiv = 1 ORDER BY sort, id`],
      [`SELECT type_id, COUNT(*) AS n FROM tickets WHERE lan_id = ${AKTIVE_LAN} AND status != 'storniert' GROUP BY type_id`],
      ...zahlenAbfragen(null),
      ["SELECT id, titel, teaser, datum FROM news ORDER BY datum DESC, id DESC LIMIT 30"]);
    if (!lan) throw new F(500, "Keine LAN angelegt.");
    const e = einstellungenAus(einstZeilen);
    const z = zahlenAus(lan, rest.slice(0, 3));
    const news = rest[3];
    const tag = heute();
    const einst = {};
    for (const k of OEFFENTLICHE_EINSTELLUNGEN) einst[k] = e[k];
    einst.zahlung = { ...e.zahlung, arten: { ...e.zahlung.arten, paypal_direkt: !!e.zahlung.arten.paypal_direkt && paypalBereit(env) } };
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
    const [w, p] = lanBed(Number(c.body.lanId) || null);
    const [[lan], einstZeilen, [planZeile], sitze, [mg]] = await lesen(env,
      [`SELECT * FROM lans WHERE id = ${w}`, ...p],
      [EINSTELLUNGEN_SQL],
      [`SELECT value FROM settings WHERE key = 'plan:' || (${w})`, ...p],
      [`SELECT s.*, t.status AS t_status, t.user_id AS t_user, u.nick AS t_nick,
        g.name AS g_name, g.ablauf AS g_ablauf, tg.name AS tg_name, tgm.group_id AS t_group
      FROM seats s
      LEFT JOIN tickets t ON t.seat_id = s.id
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN groups g ON g.id = s.group_id
      LEFT JOIN group_members tgm ON tgm.user_id = t.user_id AND tgm.lan_id = s.lan_id
      LEFT JOIN groups tg ON tg.id = tgm.group_id
      WHERE s.lan_id = ${w} ORDER BY s.y, s.x`, ...p],
      [`SELECT group_id FROM group_members WHERE user_id = ? AND lan_id = ${w}`, c.ich ? c.ich.id : -1, ...p]);
    if (!lan) throw new F(404, "LAN nicht gefunden.");
    const e = einstellungenAus(einstZeilen);
    const istOrga = c.ich && (c.ich.rolle === "orga" || c.ich.rolle === "admin");
    const namenZeigen = e.gaesteOeffentlich || istOrga;
    const plan = parse((planZeile || {}).value, null) || { breite: 20, hoehe: 20, deko: [] };
    const jetzt = Date.now();
    const meineGruppe = mg ? mg.group_id : null;
    return {
      lan: lanAus(lan), plan,
      sitze: sitze.map((s) => {
        const gruppeAktiv = s.group_id && s.g_ablauf > jetzt;
        let status = "frei";
        // Ein Gast auf einem gesperrten Platz bleibt sichtbar; die Sperre steht extra dabei.
        // Plätze gibt es erst nach der Zahlung – setzt die Orga einen Unbezahlten, ist der Platz trotzdem „belegt“.
        if (s.t_status) status = "belegt";
        else if (s.gesperrt) status = "gesperrt";
        else if ((s.stufe || 1) > (lan.stufe_aktiv || 1)) status = "ausbau";
        else if (gruppeAktiv) status = "gruppe";
        const gruppeId = s.t_status ? s.t_group : (gruppeAktiv ? s.group_id : null);
        return {
          id: s.id, label: s.label, x: s.x, y: s.y, status,
          nick: s.t_status && namenZeigen ? s.t_nick : "",
          gruppe: s.t_status ? (namenZeigen ? s.tg_name || "" : "") : (gruppeAktiv ? s.g_name : ""),
          gruppenSitz: !!gruppeAktiv,
          gesperrt: !!s.gesperrt,
          stufe: s.stufe || 1,
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
    const [zeilen, ...zz] = await lesen(env, [`SELECT u.nick, s.label AS sitz, g.name AS gruppe, tt.name AS typ, t.status
      FROM tickets t JOIN users u ON u.id = t.user_id JOIN ticket_types tt ON tt.id = t.type_id
      LEFT JOIN seats s ON s.id = t.seat_id
      LEFT JOIN group_members gm ON gm.user_id = t.user_id AND gm.lan_id = t.lan_id
      LEFT JOIN groups g ON g.id = gm.group_id
      WHERE t.lan_id = ? AND t.status != 'storniert' ORDER BY t.created_at`, lan.id], ...zahlenAbfragen(lan.id));
    const z = zahlenAus(lan, zz);
    return { oeffentlich: true, zahlen: z, gaeste: zeilen.map((r) => ({ nick: r.nick, sitz: r.sitz || "", gruppe: r.gruppe || "", typ: r.typ, ...(istOrga ? { bezahlt: r.status === "bezahlt" } : {}) })) };
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
    if (await eins(env, "SELECT id FROM users WHERE nick_key = ?", nick.toLowerCase())) { bremseFehlschlag(c.ip); throw new F(409, "Diesen Nickname gibt es schon."); }
    if (await eins(env, "SELECT id FROM users WHERE email_key = ?", email.toLowerCase())) { bremseFehlschlag(c.ip); throw new F(409, "Mit dieser E-Mail gibt es schon ein Konto."); }
    registrierungZaehlen(c.ip);
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
    const [[lan], [tz], [gm], einstZeilen, ueb] = await lesen(env,
      [`SELECT * FROM lans WHERE id = ${AKTIVE_LAN}`],
      [TICKET_SQL + ` WHERE t.user_id = ? AND t.lan_id = ${AKTIVE_LAN} AND t.status != 'storniert' LIMIT 1`, u.id],
      [`SELECT group_id FROM group_members WHERE user_id = ? AND lan_id = ${AKTIVE_LAN}`, u.id],
      [EINSTELLUNGEN_SQL],
      [`SELECT ue.id, ue.von_id, ue.an_id, uv.nick AS von_nick, ua.nick AS an_nick, ue.created_at FROM uebergaben ue
        JOIN users uv ON uv.id = ue.von_id JOIN users ua ON ua.id = ue.an_id
        WHERE ue.lan_id = ${AKTIVE_LAN} AND (ue.von_id = ? OR ue.an_id = ?) ORDER BY ue.id`, u.id, u.id]);
    if (!lan) throw new F(500, "Keine LAN angelegt.");
    const ticket = tz ? gastTicket(ticketAus(tz)) : null;
    if (ticket && ticket.checkinAt) ticket.zugang = zugangAus(einstellungenAus(einstZeilen), ticket);
    return {
      nutzer: nutzerOeffentlich(u),
      ticket,
      gruppe: gm ? await gruppeDetail(env, gm.group_id, u.id) : null,
      alter: alterAm(u.geburtsdatum, lan.start || heute()),
      // anfragen: wer mein Ticket übernehmen möchte; meineAnfrage: von wem ich ein Ticket übernehmen möchte
      uebergabe: {
        anfragen: ueb.filter((x) => x.von_id === u.id).map((x) => ({ id: x.id, nick: x.an_nick, at: x.created_at })),
        meineAnfrage: (ueb.filter((x) => x.an_id === u.id).map((x) => ({ id: x.id, nick: x.von_nick, at: x.created_at })))[0] || null,
      },
    };
  },

  // ---------- Ticket-Übergabe ----------
  // 1. Wer das Ticket bekommen soll (eingeloggt, ohne eigenes Ticket), gibt den Nickname des Weitergebers an.
  // 2. Der Weitergeber sieht die Anfrage in seinem Konto und bestätigt oder lehnt ab.
  // Das Ticket wandert samt Platz und Zahlungsstatus; eingecheckte Tickets lassen sich nicht mehr übergeben.
  async uebergabeAnfragen(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const nick = String(body.nick || "").trim().toLowerCase();
    if (!nick) throw new F(400, "Bitte gib den Nickname an, von dem du das Ticket bekommst.");
    if (await eins(env, "SELECT id FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert'", u.id, lan.id)) throw new F(409, "Du hast für diese LAN schon ein Ticket.");
    const alter = alterAm(u.geburtsdatum, lan.start || heute());
    if (alter !== null && alter < 16) throw new F(403, "Die Teilnahme ist leider erst ab 16 Jahren möglich.");
    const von = await eins(env, "SELECT id, nick FROM users WHERE nick_key = ?", nick);
    if (!von) throw new F(404, "Diesen Nickname gibt es nicht.");
    if (von.id === u.id) throw new F(400, "Das bist du selbst.");
    const t = await eins(env, "SELECT id, checkin_at FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert'", von.id, lan.id);
    if (!t) throw new F(409, von.nick + " hat für diese LAN kein Ticket.");
    if (t.checkin_at) throw new F(409, "Dieses Ticket ist schon eingecheckt und kann nicht mehr weitergegeben werden.");
    await env.DB.batch([
      st(env, "DELETE FROM uebergaben WHERE lan_id = ? AND an_id = ?", lan.id, u.id),
      st(env, "INSERT INTO uebergaben (lan_id, von_id, an_id, created_at) VALUES (?,?,?,?)", lan.id, von.id, u.id, Date.now()),
    ]);
    await protokoll(c, "uebergabe-angefragt", { von: von.nick, an: u.nick });
    return { ok: true, nick: von.nick };
  },

  async uebergabeZurueckziehen(c) {
    const u = brauchtLogin(c);
    const lan = await aktiveLan(c.env);
    await los(c.env, "DELETE FROM uebergaben WHERE lan_id = ? AND an_id = ?", lan.id, u.id);
    return { ok: true };
  },

  async uebergabeAntworten(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const a = await eins(env, "SELECT ue.*, ua.nick AS an_nick, ua.geburtsdatum AS an_geb FROM uebergaben ue JOIN users ua ON ua.id = ue.an_id WHERE ue.id = ? AND ue.von_id = ? AND ue.lan_id = ?",
      Number(body.id) || 0, u.id, lan.id);
    if (!a) throw new F(404, "Diese Anfrage gibt es nicht mehr.");
    if (!body.annehmen) {
      await los(env, "DELETE FROM uebergaben WHERE id = ?", a.id);
      await protokoll(c, "uebergabe-abgelehnt", { von: u.nick, an: a.an_nick });
      return { ok: true };
    }
    const t = await eins(env, "SELECT id, checkin_at, status, paypal_capture FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert'", u.id, lan.id);
    if (!t) throw new F(409, "Du hast kein Ticket für diese LAN.");
    if (t.status === "offen" && t.paypal_capture) throw new F(409, "Deine PayPal-Zahlung ist noch in Prüfung – die Übergabe geht erst danach.");
    if (t.checkin_at) throw new F(409, "Dein Ticket ist schon eingecheckt und kann nicht mehr weitergegeben werden.");
    const alter = alterAm(a.an_geb, lan.start || heute());
    if (alter !== null && alter < 16) throw new F(403, a.an_nick + " ist zur LAN jünger als 16 und darf leider nicht teilnehmen.");
    const notiz = "Übergeben von " + u.nick + " an " + a.an_nick + " am " + new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
    // In EINER Anweisung: nur wenn der Empfänger weiterhin kein Ticket hat und noch nicht eingecheckt ist.
    const r = await los(env, `UPDATE tickets SET user_id = ?, otp = '', freigeschaltet_at = NULL, paypal_order = '',
        orga_notiz = TRIM(COALESCE(orga_notiz, '') || char(10) || ?, char(10) || ' ')
      WHERE id = ? AND user_id = ? AND checkin_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert')`,
      a.an_id, notiz, t.id, u.id, a.an_id, lan.id);
    if (!geaendert(r)) throw new F(409, a.an_nick + " hat inzwischen selbst ein Ticket – die Übergabe ist nicht mehr möglich.");
    await env.DB.batch([
      st(env, "DELETE FROM uebergaben WHERE lan_id = ? AND (von_id = ? OR an_id = ?)", lan.id, u.id, a.an_id),
    ]);
    await protokoll(c, "ticket-uebergeben", { ticket: t.id, von: u.nick, an: a.an_nick });
    return { ok: true, nick: a.an_nick };
  },

  async kontoAendern(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    const email = mailPruefen(body.email);
    const vorname = text(body.vorname, 60, "Vorname", true), nachname = text(body.nachname, 60, "Nachname", true);
    const geburtsdatum = datumPruefen(body.geburtsdatum, "Geburtsdatum");
    if (!geburtsdatum) throw new F(400, "Geburtsdatum fehlt (wir brauchen es wegen der Altersgrenze).");
    const discord = text(body.discord, 60, "Discord", false);
    if (email.toLowerCase() !== u.email_key && await eins(env, "SELECT id FROM users WHERE email_key = ?", email.toLowerCase())) throw new F(409, "Mit dieser E-Mail gibt es schon ein Konto.");
    // Erst alles prüfen, dann schreiben – sonst bleibt bei falschem Passwort die Hälfte gespeichert.
    if (body.passwortNeu) {
      if (!bremseOffen(c.ip)) throw new F(429, "Zu viele Fehlversuche. Bitte in 15 Minuten nochmal.");
      if (!(await passwortStimmt(String(body.passwortAlt || ""), u.pw))) { bremseFehlschlag(c.ip); throw new F(403, "Das bisherige Passwort stimmt nicht."); }
      if (String(body.passwortNeu).length < PW_MIN) throw new F(400, "Das neue Passwort braucht mindestens " + PW_MIN + " Zeichen.");
    }
    await los(env, "UPDATE users SET email = ?, email_key = ?, vorname = ?, nachname = ?, geburtsdatum = ?, discord = ? WHERE id = ?",
      email, email.toLowerCase(), vorname, nachname, geburtsdatum, discord, u.id);
    let token = null;
    if (body.passwortNeu) {
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

  // ---------- AgeLan-App (Klon) ----------
  // Liefert ein Anmelde-Token für die AgeLan-App, damit sie ohne zweite
  // Anmeldung in der Website laufen kann (gleiche Herkunft → gleicher
  // localStorage). Format und Schlüssel sind die des Klon-Workers: Nutzlast
  // {n,e,t,a,s,o} base64url + "." + HMAC-SHA256, Schlüssel in settings
  // 'klon:tokenSecret' (legt der Klon-Worker sonst beim ersten Login selbst an).
  async appToken(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const eingecheckt = await eins(env, "SELECT 1 AS x FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert' AND checkin_at IS NOT NULL", u.id, lan.id);
    const admin = u.rolle === "admin", orga = admin || u.rolle === "orga", streamer = !!u.streamer;
    if (!eingecheckt && !orga && !streamer) throw new F(403, "Die AgeLan-App wird beim Check-in freigeschaltet.");
    await los(env, "INSERT OR IGNORE INTO settings (key, value) VALUES ('klon:tokenSecret', ?)", b64(zufallsBytes(32)));
    const roh = (await eins(env, "SELECT value FROM settings WHERE key = 'klon:tokenSecret'")).value;
    const key = await crypto.subtle.importKey("raw", unb64(roh), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    // v = token_ver: Passwortwechsel oder -reset macht auch das App-Token ungültig.
    const nutzlast = { n: u.nick, e: Date.now() + 120 * 864e5, t: Number(u.created_at) || 0, v: u.token_ver };
    if (admin) nutzlast.a = 1;
    if (streamer) nutzlast.s = 1;
    if (orga) nutzlast.o = 1;
    const teil = b64url(enc.encode(JSON.stringify(nutzlast)));
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(teil));
    return { konto: { nickname: u.nick, token: teil + "." + b64url(sig), admin, streamer, orga, discordId: u.discord_id || "" } };
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
    if (zahlart === "paypal_direkt" && !paypalBereit(env)) throw new F(409, "PayPal ist gerade nicht verfügbar – bitte wähle eine andere Zahlart.");
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
        AND (? = 0 OR (SELECT COUNT(*) FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id LEFT JOIN seats s ON s.id = t.seat_id
                       WHERE t.lan_id = ? AND tt.mit_sitz = 1 AND t.status != 'storniert' AND COALESCE(s.gesperrt, 0) = 0)
                      < MIN((SELECT COUNT(*) FROM seats WHERE lan_id = ? AND gesperrt = 0
                               AND stufe <= (SELECT CASE WHEN stufe_auto = 1 THEN 99 ELSE stufe_aktiv END FROM lans WHERE id = ?)), ?))
        AND (? IS NULL OR (SELECT COUNT(*) FROM tickets WHERE coupon_id = ? AND status != 'storniert') < (SELECT max_einloesungen FROM coupons WHERE id = ?))`,
      lan.id, u.id, typ.id, code, gratis ? "bezahlt" : "offen", zahlart, p.endCent, JSON.stringify(p.extras), p.couponId, p.rabattCent,
      text(body.notiz, 300, "Hinweis", false), jetzt, jetzt, gratis ? jetzt : null, gratis ? "gratis" : "",
      typ.limit_anzahl, typ.id, typ.limit_anzahl,
      typ.mit_sitz, lan.id, lan.id, lan.id, lan.gaeste_limit || 100000,
      p.couponId, p.couponId, p.couponId);
    if (!geaendert(r)) throw new F(409, "Leider ausverkauft – oder der Gutschein ist schon aufgebraucht.");
    await protokoll(c, "ticket-gekauft", { typ: typ.name, zahlart, preis: p.endCent });
    await stufeNachziehen(c, lan.id);
    return { ticket: gastTicket(await ticketDetail(env, r.meta.last_row_id)) };
  },

  async ticketStornieren(c) {
    const u = brauchtLogin(c);
    const lan = await aktiveLan(c.env);
    const offen = await eins(c.env, "SELECT paypal_capture FROM tickets WHERE user_id = ? AND lan_id = ? AND status = 'offen'", u.id, lan.id);
    if (offen && offen.paypal_capture) throw new F(409, "Für dein Ticket ist eine PayPal-Zahlung eingegangen bzw. in Prüfung. Zum Stornieren melde dich bitte bei der Orga.");
    const r = await los(c.env, "UPDATE tickets SET status = 'storniert', seat_id = NULL WHERE user_id = ? AND lan_id = ? AND status = 'offen' AND paypal_capture = ''", u.id, lan.id);
    if (!geaendert(r)) throw new F(409, "Nur offene (noch nicht bezahlte) Tickets kannst du selbst stornieren.");
    await los(c.env, "DELETE FROM uebergaben WHERE lan_id = ? AND von_id = ?", lan.id, u.id);
    await protokoll(c, "ticket-storniert", u.nick);
    return { ok: true };
  },

  async zahlartAendern(c) {
    const u = brauchtLogin(c);
    const lan = await aktiveLan(c.env);
    const e = await einstellungen(c.env);
    const z = String(c.body.zahlart || "");
    if (!ZAHLARTEN[z] || !e.zahlung.arten[z]) throw new F(400, "Unbekannte Zahlart.");
    if (z === "paypal_direkt" && !paypalBereit(c.env)) throw new F(409, "PayPal ist gerade nicht verfügbar.");
    const r = await los(c.env, "UPDATE tickets SET zahlart = ? WHERE user_id = ? AND lan_id = ? AND status = 'offen'", z, u.id, lan.id);
    if (!geaendert(r)) throw new F(409, "Kein offenes Ticket.");
    return { ok: true };
  },

  // ---------- PayPal direkt (Checkout) ----------
  // 1. paypalStarten: legt bei PayPal eine Bestellung über den offenen Ticketbetrag an
  //    und liefert die Adresse, auf die der Browser weiterleitet.
  // 2. PayPal schickt den Gast zurück auf  <Website>?paypal=zurueck&token=<Bestellung>.
  // 3. paypalAbschliessen: zieht das Geld ein, prüft Betrag + Ticket und setzt „bezahlt“.
  async paypalStarten(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    if (!paypalBereit(env)) throw new F(409, "PayPal ist gerade nicht verfügbar.");
    const lan = await aktiveLan(env);
    const e = await einstellungen(env);
    if (!e.zahlung.arten.paypal_direkt) throw new F(409, "Zahlung über PayPal ist gerade nicht freigeschaltet.");
    const t = await eins(env, "SELECT * FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert'", u.id, lan.id);
    if (!t) throw new F(404, "Kein Ticket gefunden.");
    if (t.status === "bezahlt") return { bezahlt: true };
    if (!(t.preis_cent > 0)) throw new F(409, "Für dieses Ticket ist nichts zu zahlen.");
    if (t.paypal_capture) throw new F(409, "Für dein Ticket ist schon eine PayPal-Zahlung eingegangen bzw. in Prüfung. Die Orga bestätigt dein Ticket.");
    // Gibt es schon eine bestätigte Bestellung (z. B. Rückkehr von PayPal abgebrochen)? Dann die einziehen statt neu kassieren.
    if (t.paypal_order) {
      let alt = null;
      try { alt = await paypalAnfrage(env, "GET", "/v2/checkout/orders/" + encodeURIComponent(t.paypal_order)); } catch (err) { alt = null; }
      if (alt && (alt.status === "APPROVED" || alt.status === "COMPLETED")) {
        await paypalEinziehen(c, t, t.paypal_order);
        return { bezahlt: true };
      }
    }
    // Rücksprung nur auf eine der erlaubten Website-Adressen (ORIGINS)
    const ziel = String(body.zurueck || "");
    let basis;
    try { basis = new URL(ziel); } catch (e) { throw new F(400, "Ungültige Rücksprung-Adresse."); }
    const erlaubt = String(env.ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!erlaubt.includes(basis.origin)) throw new F(400, "Rücksprung-Adresse nicht erlaubt.");
    basis.hash = ""; basis.search = "";
    const typ = await eins(env, "SELECT name FROM ticket_types WHERE id = ?", t.type_id);
    const bestellung = await paypalAnfrage(env, "POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: "ticket-" + t.id, custom_id: String(t.id),
        description: (lan.name + " – " + ((typ && typ.name) || "Ticket") + " – " + u.nick).slice(0, 127),
        amount: { currency_code: "EUR", value: (t.preis_cent / 100).toFixed(2) },
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: "AGE-LAN", locale: "de-DE", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING",
        return_url: basis.href + "?paypal=zurueck", cancel_url: basis.href + "?paypal=abbruch",
      } } },
    }, "start-" + t.id + "-" + Date.now());
    const link = (bestellung.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!bestellung.id || !link) throw new F(502, "PayPal hat keine Zahlungsseite geliefert.");
    await los(env, "UPDATE tickets SET paypal_order = ?, zahlart = 'paypal_direkt' WHERE id = ? AND status = 'offen'", bestellung.id, t.id);
    return { url: link.href };
  },

  async paypalAbschliessen(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    if (!paypalBereit(env)) throw new F(409, "PayPal ist gerade nicht verfügbar.");
    const orderId = String(body.orderId || "").slice(0, 64);
    const t = orderId && await eins(env, "SELECT * FROM tickets WHERE paypal_order = ? AND user_id = ?", orderId, u.id);
    if (!t) throw new F(404, "Zu dieser PayPal-Zahlung gibt es kein Ticket.");
    if (t.status === "bezahlt") return { ticket: await ticketDetail(env, t.id) };
    if (t.status !== "offen") throw new F(409, "Das Ticket ist storniert – es wurde nichts abgebucht.");
    await paypalEinziehen(c, t, orderId);
    return { ticket: gastTicket(await ticketDetail(env, t.id)) };
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
    if (t.status !== "bezahlt") throw new F(409, "Deinen Platz suchst du dir aus, sobald die Orga deine Zahlung bestätigt hat.");
    await sitzSetzen(env, t.id, u.id, lan.id, String(c.body.sitzId || ""), false);
    await protokoll(c, "sitz", { sitz: c.body.sitzId });
    return { ok: true };
  },

  async sitzFreigeben(c) {
    const u = brauchtLogin(c);
    const lan = await aktiveLan(c.env);
    const e = await einstellungen(c.env);
    if (!e.sitzwahlOffen && u.rolle === "user") throw new F(409, "Die Sitzplatzwahl ist gerade geschlossen.");
    await los(c.env, "UPDATE tickets SET seat_id = NULL WHERE user_id = ? AND lan_id = ? AND status != 'storniert' AND checkin_at IS NULL", u.id, lan.id);
    return { ok: true };
  },

  // ---------- Reservierungsgruppen ----------
  async gruppeErstellen(c) {
    const { env, body } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const e = await einstellungen(env);
    if (e.gruppenErlaubt === false && u.rolle === "user") throw new F(409, "Reservierungsgruppen sind gerade nicht möglich.");
    const name = text(body.name, 30, "Gruppenname", true);
    if (name.length < 2) throw new F(400, "Der Gruppenname ist zu kurz.");
    if (await eins(env, "SELECT 1 FROM group_members WHERE user_id = ? AND lan_id = ?", u.id, lan.id)) throw new F(409, "Du bist schon in einer Gruppe.");
    if (await eins(env, "SELECT 1 FROM groups WHERE lan_id = ? AND name_key = ?", lan.id, name.toLowerCase())) throw new F(409, "Diesen Gruppennamen gibt es schon.");
    const jetzt = Date.now();
    const ablauf = Math.min(jetzt + e.gruppeHalteTage * 864e5, gruppeGrenze(e, lan, jetzt));
    if (ablauf <= jetzt) throw new F(409, "Für diese LAN können keine Reservierungsgruppen mehr gegründet werden – der Stichtag ist vorbei.");
    const r = await los(env, "INSERT INTO groups (lan_id, name, name_key, owner_id, code, ablauf, created_at) VALUES (?,?,?,?,?,?,?)",
      lan.id, name, name.toLowerCase(), u.id, zufallsCode(6), ablauf, jetzt);
    const gid = r.meta.last_row_id;
    try {
      await los(env, "INSERT INTO group_members (group_id, user_id, lan_id, created_at) VALUES (?,?,?,?)", gid, u.id, lan.id, jetzt);
    } catch (e) {
      // Doppelklick: zweite Gruppe ohne Mitglied wieder wegräumen.
      await los(env, "DELETE FROM groups WHERE id = ?", gid);
      throw e;
    }
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
    const r = await los(env, "INSERT INTO group_members (group_id, user_id, lan_id, created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM groups WHERE id = ?)",
      g.id, u.id, lan.id, Date.now(), g.id);
    if (!geaendert(r)) throw new F(404, "Diese Gruppe gibt es nicht mehr.");
    await protokoll(c, "gruppe-beigetreten", g.name);
    return { gruppe: await gruppeDetail(env, g.id, u.id) };
  },

  async gruppeVerlassen(c) {
    const { env } = c;
    const u = brauchtLogin(c);
    const lan = await aktiveLan(env);
    const m = await eins(env, "SELECT g.* FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.lan_id = ?", u.id, lan.id);
    if (!m) {
      // Verwaister Eintrag (Gruppe gelöscht) – aufräumen, sonst bleibt man „schon in einer Gruppe“.
      await los(env, "DELETE FROM group_members WHERE user_id = ? AND lan_id = ?", u.id, lan.id);
      return { ok: true };
    }
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
    const glan = await eins(env, "SELECT * FROM lans WHERE id = ?", g.lan_id);
    if (g.ablauf <= Date.now() && (e.gruppeVerlaengern === false || gruppeGrenze(e, glan, g.created_at) <= Date.now()))
      throw new F(409, "Die Haltefrist eurer Gruppe ist abgelaufen. Plätze könnt ihr jetzt nur noch einzeln mit Ticket wählen.");
    const max = u.rolle === "admin" ? 500 : e.gruppeMaxSitze;
    if (ids.length > max) throw new F(400, "Eine Gruppe darf höchstens " + max + " Plätze vormerken.");
    const mitglieder = (await alle(env, "SELECT user_id FROM group_members WHERE group_id = ?", g.id)).map((m) => m.user_id);
    const jetzt = Date.now();
    for (const id of ids) {
      const s = await eins(env, `SELECT s.*, t.user_id AS t_user, g2.ablauf AS g_ablauf FROM seats s
        LEFT JOIN tickets t ON t.seat_id = s.id LEFT JOIN groups g2 ON g2.id = s.group_id WHERE s.id = ? AND s.lan_id = ?`, id, g.lan_id);
      if (!s) throw new F(404, "Einen der Plätze gibt es nicht.");
      if (s.gesperrt) throw new F(409, "Platz " + s.label + " ist gesperrt.");
      if ((s.stufe || 1) > ((glan && glan.stufe_aktiv) || 1)) throw new F(409, "Platz " + s.label + " wird erst mit Stage " + s.stufe + " freigeschaltet.");
      if (s.t_user && !mitglieder.includes(s.t_user)) throw new F(409, "Platz " + s.label + " ist schon belegt.");
      if (s.group_id && s.group_id !== g.id && s.g_ablauf > jetzt) throw new F(409, "Platz " + s.label + " ist von einer anderen Gruppe vorgemerkt.");
    }
    const stmts = [st(env, "UPDATE seats SET group_id = NULL WHERE group_id = ?", g.id)];
    // Nur freie oder abgelaufene Plätze übernehmen – sonst hätte eine gleichzeitige andere Gruppe Pech.
    for (const id of ids) stmts.push(st(env, "UPDATE seats SET group_id = ? WHERE id = ? AND (group_id IS NULL OR group_id = ? OR group_id IN (SELECT id FROM groups WHERE ablauf <= ?))", g.id, id, g.id, jetzt));
    // Wer neu vormerkt, verlängert die Haltefrist – sofern erlaubt und nur bis zur Grenze.
    if (e.gruppeVerlaengern !== false) {
      const neu = Math.min(Math.max(g.ablauf, jetzt + e.gruppeHalteTage * 864e5), gruppeGrenze(e, glan, g.created_at));
      if (neu > g.ablauf) stmts.push(st(env, "UPDATE groups SET ablauf = ? WHERE id = ?", neu, g.id));
    }
    const erg = await env.DB.batch(stmts);
    const gesetzt = erg.slice(1, 1 + ids.length).reduce((n, x) => n + ((x.meta && x.meta.changes) || 0), 0);
    if (gesetzt < ids.length) throw new F(409, "Ein Platz wurde gerade von einer anderen Gruppe vorgemerkt – bitte neu laden und nochmal auswählen.");
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
    const [zeilen, ...z] = await lesen(c.env, [TICKET_SQL + " WHERE t.lan_id = ? ORDER BY t.created_at DESC", lan.id], ...zahlenAbfragen(lan.id));
    return { lan: lanAus(lan), zahlen: zahlenAus(lan, z), tickets: zeilen.map(ticketAus) };
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
    // Orga darf Notiz und Zahlart ändern, alles andere nur Veranstalter.
    const ich = brauchtOrga(c);
    const nurOrgaFelder = ["typId", "preisCent", "sitzId", "status", "otpNeu"].every((k) => body[k] === undefined);
    if (ich.rolle !== "admin" && !nurOrgaFelder) throw new F(403, "Nur für Veranstalter.");
    const t = await eins(env, "SELECT * FROM tickets WHERE id = ?", Number(body.ticketId));
    if (!t) throw new F(404, "Ticket nicht gefunden.");
    if (body.zahlart !== undefined) {
      if (!ZAHLARTEN[body.zahlart]) throw new F(400, "Unbekannte Zahlart.");
      await los(env, "UPDATE tickets SET zahlart = ? WHERE id = ?", body.zahlart, t.id);
    }
    if (t.status === "storniert" && (body.sitzId || body.typId != null)) throw new F(409, "Das Ticket ist storniert.");
    if (body.status === "storniert") {
      await los(env, "UPDATE tickets SET status = 'storniert', seat_id = NULL WHERE id = ?", t.id);
      await los(env, "DELETE FROM uebergaben WHERE lan_id = ? AND von_id = ?", t.lan_id, t.user_id);
    }
    if (body.typId != null) {
      const typ = await eins(env, "SELECT * FROM ticket_types WHERE id = ? AND lan_id = ?", Number(body.typId), t.lan_id);
      if (!typ) throw new F(404, "Ticketsorte nicht gefunden.");
      await los(env, "UPDATE tickets SET type_id = ?, seat_id = CASE WHEN ? = 1 THEN seat_id ELSE NULL END WHERE id = ?", typ.id, typ.mit_sitz, t.id);
    }
    if (body.preisCent != null) await los(env, "UPDATE tickets SET preis_cent = ? WHERE id = ?", ganz(body.preisCent, "Preis", 0, 1e6), t.id);
    if (body.orgaNotiz != null) await los(env, "UPDATE tickets SET orga_notiz = ? WHERE id = ?", text(body.orgaNotiz, 500, "Notiz", false), t.id);
    if (body.sitzId !== undefined && body.status !== "storniert") {
      if (!body.sitzId) await los(env, "UPDATE tickets SET seat_id = NULL WHERE id = ?", t.id);
      else {
        const art = await eins(env, "SELECT tt.mit_sitz FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id WHERE t.id = ?", t.id);
        if (!art || !art.mit_sitz) throw new F(400, "Diese Ticketsorte hat keinen Sitzplatz.");
        await sitzSetzen(env, t.id, t.user_id, t.lan_id, String(body.sitzId), true);
      }
    }
    if (body.otpNeu) await los(env, "UPDATE tickets SET otp = ? WHERE id = ?", otpErzeugen(), t.id);
    await protokoll(c, "ticket-geaendert", { ticket: t.id, ...body, aktion: undefined });
    if (body.typId != null || body.status !== undefined || body.sitzId !== undefined) await stufeNachziehen(c, t.lan_id);
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
    if (await eins(env, "SELECT 1 FROM tickets WHERE user_id = ? AND lan_id = ? AND status != 'storniert'", u.id, lan.id)) throw new F(409, u.nick + " hat für diese LAN schon ein Ticket.");
    const zahlart = ZAHLARTEN[body.zahlart] ? body.zahlart : "bar";
    const preis = body.preisCent != null ? ganz(body.preisCent, "Preis", 0, 1e6) : typ.preis_cent;
    const bezahlt = !!body.bezahlt || preis === 0;
    const jetzt = Date.now();
    const r = await los(env, `INSERT INTO tickets (lan_id, user_id, type_id, code, status, zahlart, preis_cent, created_at, bezahlt_at, bezahlt_von, orga_notiz)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, lan.id, u.id, typ.id, hex(zufallsBytes(16)), bezahlt ? "bezahlt" : "offen", zahlart, preis, jetzt,
      bezahlt ? jetzt : null, bezahlt ? ich.nick : "", "Angelegt von " + ich.nick);
    await protokoll(c, "ticket-angelegt", { fuer: u.nick, typ: typ.name });
    await stufeNachziehen(c, lan.id);
    return { ticket: await ticketDetail(env, r.meta.last_row_id) };
  },

  // Gast ohne Konto direkt an der Tür: Konto + Ticket (+ Platz, + Check-in) in einem Schritt.
  // Das Konto bekommt ein Zufallspasswort, das die Orga dem Gast einmalig nennt (Konto/App).
  async adminGastAnlegen(c) {
    const { env, body } = c;
    const ich = brauchtOrga(c);
    const lan = await lanAusBody(c);
    const nick = nickPruefen(body.nick);
    const vorname = text(body.vorname, 60, "Vorname", true), nachname = text(body.nachname, 60, "Nachname", true);
    const geburtsdatum = datumPruefen(body.geburtsdatum, "Geburtsdatum");
    if (!geburtsdatum) throw new F(400, "Geburtsdatum fehlt (wegen der Altersgrenze).");
    if (await eins(env, "SELECT id FROM users WHERE nick_key = ?", nick.toLowerCase())) throw new F(409, "Den Nickname „" + nick + "“ gibt es schon. Hat der Gast schon ein Konto? Dann in der Benutzerliste ein Ticket anlegen.");
    let email = String(body.email || "").trim();
    if (email) {
      email = mailPruefen(email);
      if (await eins(env, "SELECT id FROM users WHERE email_key = ?", email.toLowerCase())) throw new F(409, "Mit dieser E-Mail gibt es schon ein Konto.");
    } else email = nick.toLowerCase().replace(/[^a-z0-9]+/g, "") + "-" + hex(zufallsBytes(3)) + "@vor-ort.invalid"; // Platzhalter, eindeutig
    const typ = await eins(env, "SELECT * FROM ticket_types WHERE id = ? AND lan_id = ?", Number(body.typId), lan.id);
    if (!typ) throw new F(404, "Ticketsorte nicht gefunden.");
    // Freiticket darf auch die Orga vergeben; einen anderen Preis nur der Veranstalter.
    const preis = body.frei ? 0 : ich.rolle === "admin" && body.preisCent != null ? ganz(body.preisCent, "Preis", 0, 1e6) : typ.preis_cent;
    const bezahlt = !!body.bezahlt || preis === 0;
    const zahlart = ZAHLARTEN[body.zahlart] ? body.zahlart : "bar";
    const sitzId = body.sitzId ? String(body.sitzId) : "";
    if (sitzId && !typ.mit_sitz) throw new F(400, "Diese Ticketsorte hat keinen Sitzplatz.");
    if (body.einchecken && !bezahlt) throw new F(409, "Einchecken geht erst, wenn bezahlt ist.");
    const passwort = zufallsCode(10);
    const jetzt = Date.now();
    const u = await los(env, `INSERT INTO users (nick, nick_key, email, email_key, vorname, nachname, geburtsdatum, pw, vorort_lan, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, nick, nick.toLowerCase(), email, email.toLowerCase(), vorname, nachname, geburtsdatum, await passwortHashen(passwort), lan.id, jetzt);
    const userId = u.meta.last_row_id;
    const t = await los(env, `INSERT INTO tickets (lan_id, user_id, type_id, code, status, zahlart, preis_cent, created_at, bezahlt_at, bezahlt_von, orga_notiz)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, lan.id, userId, typ.id, hex(zufallsBytes(16)), bezahlt ? "bezahlt" : "offen", zahlart, preis, jetzt,
      bezahlt ? jetzt : null, bezahlt ? ich.nick : "", [body.frei ? "Freiticket" : "", text(body.orgaNotiz, 500, "Notiz", false) || "Vor Ort angelegt von " + ich.nick].filter(Boolean).join(" · "));
    const ticketId = t.meta.last_row_id;
    let hinweis = "";
    try {
      if (sitzId) await sitzSetzen(env, ticketId, userId, lan.id, sitzId, true);
    } catch (e) {
      // Platz inzwischen weg: Konto, Ticket und Check-in bleiben, die Orga setzt den Platz nach.
      hinweis = e.message + " Konto und Ticket sind angelegt – bitte den Platz im Ticket nachtragen.";
    }
    if (body.einchecken) await los(env, "UPDATE tickets SET checkin_at = ?, checkin_von = ?, otp = ? WHERE id = ?", jetzt, ich.nick, otpErzeugen(), ticketId);
    await protokoll(c, "gast-vor-ort", { nick, typ: typ.name, platz: hinweis ? "" : sitzId || "", platzFehler: hinweis || undefined, eingecheckt: !!body.einchecken });
    await stufeNachziehen(c, lan.id);
    return { ticket: await ticketDetail(env, ticketId), passwort, ...(hinweis ? { hinweis } : {}) };
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
      const ms = berlinMs(datumPruefen(body.ablauf, "Ablauf"), "23:59:59");
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

  // Regeln auf bestehende Gruppen anwenden: Fristen nur kürzen, nie verlängern.
  async adminGruppenFristen(c) {
    const { env } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const e = await einstellungen(env);
    const stmts = [];
    for (const g of await alle(env, "SELECT id, ablauf, created_at FROM groups WHERE lan_id = ?", lan.id)) {
      const neu = Math.min(g.ablauf, gruppeGrenze(e, lan, g.created_at));
      if (neu < g.ablauf) stmts.push(st(env, "UPDATE groups SET ablauf = ? WHERE id = ?", neu, g.id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    await protokoll(c, "gruppen-fristen", { lan: lan.id, gekuerzt: stmts.length });
    return { gekuerzt: stmts.length };
  },

  // ---------- Verwaltung: Ticketsorten ----------
  async adminTickettypen(c) {
    brauchtOrga(c); // nur lesen – die Orga braucht die Liste für „Gast vor Ort“
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
      return { id: String(s.id || zufallsId()).slice(0, 32), label, x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2, gesperrt: s.gesperrt ? 1 : 0,
        // Ältere Editor-Fassungen schicken keine Stage mit – dann bleibt die gespeicherte.
        stufe: s.stufe == null ? null : Math.max(1, Math.min(9, Math.round(Number(s.stufe)) || 1)) };
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
    for (const s of alt) if (!neueIds.has(s.id)) stmts.push(st(env, "DELETE FROM seats WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tickets WHERE seat_id = seats.id)", s.id));
    // Labels erst freiräumen, damit Umbenennungen (A1 <-> A2) nicht am UNIQUE-Index scheitern.
    for (const s of neu) if (altIds.has(s.id)) stmts.push(st(env, "UPDATE seats SET label = ? WHERE id = ?", "~" + s.id, s.id));
    for (const s of neu) {
      if (altIds.has(s.id)) stmts.push(st(env, "UPDATE seats SET label = ?, x = ?, y = ?, gesperrt = ?, stufe = COALESCE(?, stufe) WHERE id = ?", s.label, s.x, s.y, s.gesperrt, s.stufe, s.id));
      else stmts.push(st(env, "INSERT INTO seats (id, lan_id, label, x, y, gesperrt, stufe) VALUES (?,?,?,?,?,?,?)", s.id, lan.id, s.label, s.x, s.y, s.gesperrt, s.stufe || 1));
    }
    stmts.push(st(env, "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", "plan:" + lan.id, JSON.stringify({ breite, hoehe, deko })));
    await env.DB.batch(stmts);
    await protokoll(c, "plan", { sitze: neu.length });
    await stufeNachziehen(c, lan.id);
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
    const planQuelle = String(l.planVorlage || "aktiv");
    if (!id && planQuelle !== "aktiv") await vorlageDaten(env, planQuelle); // wirft 404, bevor etwas angelegt ist
    if (id) {
      await los(env, "UPDATE lans SET name=?, start=?, ende=?, gaeste_limit=?, verkauf_offen=?, ort=?, adresse=?, beschreibung=? WHERE id = ?", ...werte, id);
    } else {
      const r = await los(env, "INSERT INTO lans (name, start, ende, gaeste_limit, verkauf_offen, ort, adresse, beschreibung, aktiv, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)", ...werte, Date.now());
      id = r.meta.last_row_id;
      // Neue LAN übernimmt die Ticketsorten der bisher aktiven. Sitzplan: gewählte
      // Vorlage, sonst „leer“, sonst wie die aktive LAN.
      const vorlage = await aktiveLan(env);
      const stmts = [];
      if (planQuelle !== "aktiv") stmts.push(...(await vorlageStatements(env, id, planQuelle)));
      else for (const s of await alle(env, "SELECT * FROM seats WHERE lan_id = ?", vorlage.id)) {
        stmts.push(st(env, "INSERT INTO seats (id, lan_id, label, x, y, gesperrt, stufe) VALUES (?,?,?,?,?,?,?)", zufallsId(), id, s.label, s.x, s.y, s.gesperrt || s.orga ? 1 : 0, s.stufe || 1));
      }
      for (const t of await alle(env, "SELECT * FROM ticket_types WHERE lan_id = ?", vorlage.id)) {
        stmts.push(st(env, "INSERT INTO ticket_types (lan_id, sort, name, beschreibung, features, preis_cent, extras, mit_sitz, aktiv, kaufbar, limit_anzahl) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          id, t.sort, t.name, t.beschreibung, t.features, t.preis_cent, t.extras, t.mit_sitz, t.aktiv, t.kaufbar, t.limit_anzahl));
      }
      const plan = planQuelle === "aktiv" ? await eins(env, "SELECT value FROM settings WHERE key = ?", "plan:" + vorlage.id) : null;
      if (plan) stmts.push(st(env, "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", "plan:" + id, plan.value));
      if (stmts.length) await env.DB.batch(stmts);
    }
    if (l.aktiv) await env.DB.batch([st(env, "UPDATE lans SET aktiv = 0"), st(env, "UPDATE lans SET aktiv = 1 WHERE id = ?", id)]);
    await protokoll(c, "lan", l.name);
    return AKTIONEN.adminLans(c);
  },

  // LAN löschen – nur wenn sie nicht aktiv ist und nie ein Ticket hatte
  // (Tickets sind Zahlungsbelege und bleiben erhalten, auch stornierte).
  async adminLanLoeschen(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await eins(env, "SELECT * FROM lans WHERE id = ?", Number(body.lanId));
    if (!lan) throw new F(404, "LAN nicht gefunden.");
    if (lan.aktiv) throw new F(409, "Die aktive LAN kann nicht gelöscht werden. Erst eine andere LAN aktiv schalten.");
    const t = await eins(env, "SELECT COUNT(*) AS n FROM tickets WHERE lan_id = ?", lan.id);
    if (t.n) throw new F(409, `„${lan.name}“ hat ${t.n} Ticket${t.n === 1 ? "" : "s"} (auch stornierte zählen) und kann deshalb nicht gelöscht werden.`);
    const anzahl = await eins(env, "SELECT COUNT(*) AS n FROM lans");
    if (anzahl.n <= 1) throw new F(409, "Die letzte LAN kann nicht gelöscht werden.");
    await env.DB.batch([
      st(env, "DELETE FROM group_members WHERE lan_id = ?", lan.id),
      st(env, "DELETE FROM groups WHERE lan_id = ?", lan.id),
      st(env, "DELETE FROM seats WHERE lan_id = ?", lan.id),
      st(env, "DELETE FROM coupons WHERE lan_id = ?", lan.id),
      st(env, "DELETE FROM ticket_types WHERE lan_id = ?", lan.id),
      st(env, "DELETE FROM netz_logins WHERE lan_id = ?", lan.id),
      st(env, "DELETE FROM settings WHERE key = ?", "plan:" + lan.id),
      st(env, "DELETE FROM lans WHERE id = ?", lan.id),
    ]);
    await protokoll(c, "lan-geloescht", lan.name);
    return AKTIONEN.adminLans(c);
  },

  // ---------- Verwaltung: Sitzplätze sperren ----------
  // status: "frei" | "gesperrt". Belegte Plätze bleiben belegt – nur ihr Merkmal ändert sich.
  async adminSitzStatus(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const aenderungen = Array.isArray(body.aenderungen) ? body.aenderungen.slice(0, 3000) : [];
    const stmts = [];
    for (const a of aenderungen) {
      if (!["frei", "gesperrt"].includes(a.status)) throw new F(400, "Unbekannter Platzstatus.");
      stmts.push(st(env, "UPDATE seats SET gesperrt = ?, orga = 0 WHERE id = ? AND lan_id = ?",
        a.status === "gesperrt" ? 1 : 0, String(a.id), lan.id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    await protokoll(c, "sitz-status", { lan: lan.id, anzahl: stmts.length });
    await stufeNachziehen(c, lan.id);
    return { ok: true, geaendert: stmts.length };
  },

  // ---------- Verwaltung: Ausbaustufen ----------
  // sitze: [{id, stufe}] (1–9), aktiv: bis zu welcher Stufe Plätze buchbar sind.
  async adminStufenSpeichern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const stmts = [];
    for (const z of (Array.isArray(body.sitze) ? body.sitze : []).slice(0, 3000)) {
      const stufe = Math.round(Number(z.stufe));
      if (!(stufe >= 1 && stufe <= 9)) throw new F(400, "Stage muss zwischen 1 und 9 liegen.");
      stmts.push(st(env, "UPDATE seats SET stufe = ? WHERE id = ? AND lan_id = ?", stufe, String(z.id), lan.id));
    }
    if (body.aktiv != null) {
      const aktiv = Math.round(Number(body.aktiv));
      if (!(aktiv >= 1 && aktiv <= 9)) throw new F(400, "Aktive Stage muss zwischen 1 und 9 liegen.");
      stmts.push(st(env, "UPDATE lans SET stufe_aktiv = ? WHERE id = ?", aktiv, lan.id));
    }
    if (body.auto != null) stmts.push(st(env, "UPDATE lans SET stufe_auto = ? WHERE id = ?", body.auto ? 1 : 0, lan.id));
    if (stmts.length) await env.DB.batch(stmts);
    await protokoll(c, "ausbaustufen", { lan: lan.id, plaetze: stmts.length, aktiv: body.aktiv, auto: body.auto });
    const neu = await stufeNachziehen(c, lan.id);
    return { ok: true, stufeAktiv: neu };
  },

  // ---------- Verwaltung: Sitzplan-Vorlagen ----------
  async adminVorlagen(c) {
    brauchtAdmin(c);
    const zeilen = await alle(c.env, "SELECT id, name, daten, created_at FROM plan_vorlagen ORDER BY name COLLATE NOCASE");
    return { vorlagen: zeilen.map((v) => {
      const d = parse(v.daten, { sitze: [] });
      return { id: v.id, name: v.name, sitze: d.sitze.length, gesperrt: d.sitze.filter((s) => s.gesperrt || s.orga).length, erstellt: v.created_at };
    }) };
  },

  // Aktuellen Plan einer LAN als Vorlage speichern (gleicher Name = überschreiben).
  async adminVorlageSpeichern(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const name = text(body.name, 60, "Name der Vorlage", true);
    const plan = parse((await eins(env, "SELECT value FROM settings WHERE key = ?", "plan:" + lan.id) || {}).value, null) || { breite: 20, hoehe: 20, deko: [] };
    const sitze = (await alle(env, "SELECT label, x, y, gesperrt, orga, stufe FROM seats WHERE lan_id = ? ORDER BY y, x", lan.id))
      .map((s) => ({ label: s.label, x: s.x, y: s.y, gesperrt: s.gesperrt || s.orga ? 1 : 0, stufe: s.stufe || 1 }));
    if (!sitze.length) throw new F(409, "Diese LAN hat noch keine Plätze.");
    const daten = JSON.stringify({ plan, sitze });
    const alt = await eins(env, "SELECT id FROM plan_vorlagen WHERE lower(name) = lower(?)", name);
    if (alt) await los(env, "UPDATE plan_vorlagen SET daten = ?, created_at = ? WHERE id = ?", daten, Date.now(), alt.id);
    else await los(env, "INSERT INTO plan_vorlagen (name, daten, created_at) VALUES (?,?,?)", name, daten, Date.now());
    await protokoll(c, "vorlage-speichern", name);
    return { ...(await AKTIONEN.adminVorlagen(c)), ueberschrieben: !!alt };
  },

  async adminVorlageLoeschen(c) {
    brauchtAdmin(c);
    await los(c.env, "DELETE FROM plan_vorlagen WHERE id = ?", Number(c.body.vorlageId));
    await protokoll(c, "vorlage-loeschen", { id: c.body.vorlageId });
    return AKTIONEN.adminVorlagen(c);
  },

  // Vorlage auf eine bestehende LAN anwenden – nur solange dort kein Gast einen Platz hat.
  async adminVorlageAnwenden(c) {
    const { env, body } = c;
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const besetzt = await alle(env, "SELECT s.label FROM seats s JOIN tickets t ON t.seat_id = s.id WHERE s.lan_id = ?", lan.id);
    if (besetzt.length) throw new F(409, `In dieser LAN haben schon ${besetzt.length} Gäste einen Platz (${besetzt.slice(0, 8).map((s) => s.label).join(", ")}${besetzt.length > 8 ? " …" : ""}). Eine Vorlage geht nur bei einem Plan ohne vergebene Plätze – sonst im Sitzplan-Editor ändern.`);
    const stmts = [st(env, "DELETE FROM seats WHERE lan_id = ? AND id NOT IN (SELECT seat_id FROM tickets WHERE seat_id IS NOT NULL)", lan.id), ...(await vorlageStatements(env, lan.id, body.vorlageId))];
    await env.DB.batch(stmts);
    await protokoll(c, "vorlage-anwenden", { lan: lan.id, vorlage: body.vorlageId });
    await stufeNachziehen(c, lan.id);
    return { ok: true };
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
    return { einstellungen: await einstellungen(c.env), paypal: { bereit: paypalBereit(c.env), modus: paypalModus(c.env) } };
  },

  async adminEinstellungSpeichern(c) {
    brauchtAdmin(c);
    const key = String(c.body.key || "");
    if (!Object.prototype.hasOwnProperty.call(STANDARD, key)) throw new F(400, "Unbekannte Einstellung.");
    let w = c.body.wert;
    // Objekt-Einstellungen mit den Standardwerten auffüllen, damit kein Pflichtfeld (z. B. zahlung.arten) fehlt.
    const std = STANDARD[key];
    if (std && typeof std === "object" && !Array.isArray(std)) {
      if (!w || typeof w !== "object" || Array.isArray(w)) throw new F(400, "Ungültiger Wert.");
      w = { ...std, ...w };
    }
    // Links nur als http(s)/mailto speichern – kein javascript: o. Ä.
    if (key === "seite") w.socials = Object.fromEntries(Object.entries(w.socials || {}).map(([k, v]) => [k, sichereUrl(v)]));
    if (key === "zahlung") { w.paypalMe = sichereUrl(w.paypalMe); w.arten = { ...std.arten, ...(w.arten || {}) }; }
    if (key === "gruppeHalteTage") w = Math.max(1, Math.min(365, Math.round(Number(w)) || 21));
    if (key === "gruppeMaxSitze") w = Math.max(1, Math.min(200, Math.round(Number(w)) || 10));
    if (key === "gruppeMaxTage") w = Math.max(0, Math.min(3650, Math.round(Number(w)) || 0));
    if (key === "gruppeStichtagTage") w = Number.isFinite(Number(w)) && String(w) !== "" ? Math.max(-1, Math.min(365, Math.round(Number(w)))) : -1;
    if (key === "gruppenErlaubt" || key === "gruppeVerlaengern") w = !!w;
    if (key === "netz") {
      w.portal = sichereUrl(w.portal);
      w.maxGeraete = Math.max(0, Math.min(20, Math.round(Number(w.maxGeraete)) || 0));
      w.aufbewahrungTage = Math.max(1, Math.min(365, Math.round(Number(w.aufbewahrungTage)) || 30));
    }
    if (key === "sponsoren") w = (Array.isArray(w) ? w : []).map((s) => ({ ...s, url: sichereUrl(s && s.url), logo: sichereUrl(s && s.logo) }));
    const wert = JSON.stringify(w);
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
    if (body.streamer != null) await los(env, "UPDATE users SET streamer = ? WHERE id = ?", body.streamer ? 1 : 0, u.id);
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

  // Konto endgültig löschen – nur ohne gültiges Ticket. Stornierte Tickets, Gruppen-Mitgliedschaft
  // und Übergabe-Anfragen gehen mit; Protokolleinträge bleiben (ohne Bezug zum Konto).
  async adminBenutzerLoeschen(c) {
    const { env, body } = c;
    const ich = brauchtAdmin(c);
    const u = await eins(env, "SELECT * FROM users WHERE id = ?", Number(body.userId));
    if (!u) throw new F(404, "Konto nicht gefunden.");
    if (u.id === ich.id) throw new F(400, "Du kannst dein eigenes Konto nicht löschen.");
    if (u.rolle === "admin") throw new F(409, "Veranstalter-Konten lassen sich nicht löschen – erst die Rolle ändern.");
    const tickets = await alle(env, `SELECT t.status, t.paypal_capture, l.name AS lan FROM tickets t JOIN lans l ON l.id = t.lan_id WHERE t.user_id = ?`, u.id);
    const gueltig = tickets.filter((t) => t.status !== "storniert");
    if (gueltig.length) throw new F(409, `${u.nick} hat noch ein Ticket (${[...new Set(gueltig.map((t) => t.lan))].join(", ")}). Erst das Ticket stornieren, dann löschen.`);
    if (tickets.some((t) => t.paypal_capture)) throw new F(409, `Zu einem stornierten Ticket von ${u.nick} gibt es eine PayPal-Zahlung. Das Konto bleibt deshalb als Beleg erhalten – sperre es stattdessen.`);
    for (const g of await alle(env, "SELECT g.* FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?", u.id)) await mitgliedEntfernen(env, g, u.id);
    await env.DB.batch([
      st(env, "DELETE FROM group_members WHERE user_id = ?", u.id),
      st(env, "DELETE FROM uebergaben WHERE von_id = ? OR an_id = ?", u.id, u.id),
      st(env, "UPDATE netz_logins SET ticket_id = NULL WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id = ?)", u.id),
      st(env, "DELETE FROM tickets WHERE user_id = ?", u.id),
      st(env, "UPDATE log SET user_id = NULL WHERE user_id = ?", u.id),
      st(env, "DELETE FROM users WHERE id = ?", u.id),
    ]);
    await protokoll(c, "benutzer-geloescht", { nutzer: u.nick, email: u.email });
    return { ok: true };
  },

  // ---------- Hallen-Portal ----------
  // Aufruf vom Portal-Server (PHP) – ohne Konto, mit PORTAL_SECRET.
  async portalAnmeldung(c) {
    const { env, body } = c;
    if (!env.PORTAL_SECRET) throw new F(503, "Portal-Anbindung ist nicht eingerichtet (Secret PORTAL_SECRET fehlt).");
    const bremse = "portal:" + c.ip;
    if (!bremseOffen(bremse)) throw new F(429, "Zu viele Fehlversuche.");
    if (!(await gleich(String(body.geheimnis || ""), env.PORTAL_SECRET))) { bremseFehlschlag(bremse); throw new F(403, "Falsches Portal-Geheimnis."); }
    return portalPruefen(env, { ...body, quelle: c.ip }, true);
  },

  // Orga: Code testen, ohne etwas zu speichern.
  async adminPortalTest(c) {
    brauchtOrga(c);
    return portalPruefen(c.env, c.body, false);
  },

  // Orga: Geräte-Anmeldungen ansehen und durchsuchen (MAC, IP, Nick, Platz).
  async adminNetz(c) {
    brauchtOrga(c);
    const { env, body } = c;
    const lan = await lanAusBody(c);
    const wo = ["n.lan_id = ?"], p = [lan.id];
    if (body.ticketId) { wo.push("n.ticket_id = ?"); p.push(Number(body.ticketId)); }
    const q = String(body.q || "").trim().toLowerCase().slice(0, 64);
    if (q) {
      const mac = macNorm(q);
      wo.push("(n.mac LIKE ? OR n.ip LIKE ? OR lower(n.nutzer) LIKE ? OR lower(u.nick) LIKE ? OR lower(s.label) = ?)");
      p.push(mac || "%" + q + "%", q + "%", "%" + q + "%", "%" + q + "%", q);
    }
    if (body.nurFehler) wo.push("n.ok = 0");
    const zeilen = await alle(env, `SELECT n.*, u.nick, s.label AS sitz_label FROM netz_logins n
      LEFT JOIN tickets t ON t.id = n.ticket_id LEFT JOIN users u ON u.id = t.user_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE ${wo.join(" AND ")} ORDER BY n.id DESC LIMIT 500`, ...p);
    const z = await eins(env, "SELECT COUNT(DISTINCT CASE WHEN mac != '' THEN mac END) AS geraete, COUNT(DISTINCT ticket_id) AS tickets FROM netz_logins WHERE lan_id = ? AND ok = 1", lan.id);
    return { eintraege: zeilen.map(netzZeile), geraete: z.geraete, tickets: z.tickets, eingerichtet: !!env.PORTAL_SECRET };
  },

  async adminNetzLeeren(c) {
    brauchtAdmin(c);
    const lan = await lanAusBody(c);
    const r = await los(c.env, "DELETE FROM netz_logins WHERE lan_id = ?", lan.id);
    await protokoll(c, "netz-geleert", { lan: lan.id, anzahl: geaendert(r) });
    return { geloescht: geaendert(r) };
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
  return { id: l.id, name: l.name, start: l.start, ende: l.ende, gaesteLimit: l.gaeste_limit, verkaufOffen: !!l.verkauf_offen, ort: l.ort, adresse: l.adresse, beschreibung: l.beschreibung, aktiv: !!l.aktiv, stufeAktiv: l.stufe_aktiv || 1, stufeAuto: l.stufe_auto == null ? true : !!l.stufe_auto };
}

function otpErzeugen() {
  return zufallsCode(5);
}

// ---------------------------------------------------------------------------
// Hallen-Portal: prüft Nutzername + Code und merkt sich das Gerät.
// ---------------------------------------------------------------------------
function macNorm(v) {
  const roh = String(v || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return roh.length === 12 ? roh.match(/../g).join(":") : "";
}
function ipNorm(v) {
  const s = String(v || "").trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(s) ? s : "";
}

async function portalPruefen(env, body, speichern) {
  const e = (await einstellungen(env)).netz;
  const lan = await aktiveLan(env);
  const nutzer = String(body.nutzer || "").trim().slice(0, 64);
  const code = String(body.code || "").toUpperCase().replace(/\s+/g, "").slice(0, 32);
  const mac = macNorm(body.mac);
  const ip = ipNorm(body.ip);
  const jetzt = Date.now();
  if (speichern && !mac && !body.ohneMac) throw new F(400, "MAC-Adresse fehlt oder ist ungültig.");

  // Bremse: höchstens 10 Fehlversuche je Gerät (ohne MAC: je Nutzername UND Absender) in 10 Minuten.
  // Der Absender zählt mit, damit niemand von außen per Fehlversuchen einen Gast am Hallen-Portal aussperrt.
  // Kommt die MAC ungeprüft vom Absender (/check_otp), zählt sie nicht – sonst umgeht eine Zufalls-MAC je
  // Versuch die Bremse. Zusätzlich gilt je Nutzername insgesamt eine Obergrenze von 30 Fehlversuchen.
  const quelle = String(body.quelle || "").slice(0, 64);
  const seit = jetzt - 10 * 60e3;
  const [[fehl], [fehlNick]] = await lesen(env,
    mac && !body.macUnsicher
      ? ["SELECT COUNT(*) AS n FROM netz_logins WHERE mac = ? AND ok = 0 AND at > ?", mac, seit]
      : ["SELECT COUNT(*) AS n FROM netz_logins WHERE lower(nutzer) = ? AND quelle = ? AND ok = 0 AND at > ?", nutzer.toLowerCase(), quelle, seit],
    ["SELECT COUNT(*) AS n FROM netz_logins WHERE lower(nutzer) = ? AND ok = 0 AND at > ?", nutzer.toLowerCase(), seit]);
  if (nutzer && (fehl.n >= 10 || fehlNick.n >= 30)) return { ok: false, meldung: "Zu viele Fehlversuche. Bitte warte 10 Minuten oder melde dich bei der Orga.", grund: "gebremst" };

  const t = !nutzer ? null : await eins(env, `SELECT t.*, u.nick, u.gesperrt, s.label AS sitz_label FROM tickets t
      JOIN users u ON u.id = t.user_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE t.lan_id = ? AND t.status != 'storniert' AND ${e.benutzer === "code" ? "substr(t.code, 1, 8) = ?" : "u.nick_key = ?"}
      LIMIT 1`, lan.id, nutzer.toLowerCase());
  let grund = "", meldung = "";
  if (!t) { grund = "unbekannter Nutzer"; meldung = "Nutzername oder Code falsch."; }
  else if (!t.otp || !(await gleich(t.otp, code))) { grund = "falscher Code"; meldung = "Nutzername oder Code falsch."; }
  else if (!t.checkin_at) { grund = "nicht eingecheckt"; meldung = "Du bist noch nicht eingecheckt."; }
  else if (t.gesperrt) { grund = "Konto gesperrt"; meldung = "Dein Konto ist gesperrt. Bitte melde dich bei der Orga."; }
  else if (mac) {
    const geraete = await alle(env, "SELECT DISTINCT mac FROM netz_logins WHERE ticket_id = ? AND ok = 1 AND mac != ''", t.id);
    const max = e.maxGeraete == null ? 3 : Number(e.maxGeraete) || 0; // 0 = unbegrenzt
    if (max > 0 && !geraete.some((g) => g.mac === mac) && geraete.length >= max) {
      grund = "zu viele Geräte"; meldung = `Mit deinem Code sind schon ${geraete.length} Geräte angemeldet. Bitte melde dich bei der Orga.`;
    }
  }
  const ok = !grund;
  if (speichern) {
    await los(env, "INSERT INTO netz_logins (at, lan_id, ticket_id, mac, ip, nutzer, ok, grund, quelle) VALUES (?,?,?,?,?,?,?,?,?)",
      jetzt, lan.id, t ? t.id : null, mac, ip, nutzer, ok ? 1 : 0, grund, quelle);
    if (ok && !t.freigeschaltet_at) await los(env, "UPDATE tickets SET freigeschaltet_at = ? WHERE id = ?", jetzt, t.id);
    // Datenschutz: alte Geräte-Einträge verfallen von selbst.
    const tage = Math.max(1, Number(e.aufbewahrungTage) || 30);
    await los(env, "DELETE FROM netz_logins WHERE at < ?", jetzt - tage * 864e5);
  }
  return ok
    ? { ok: true, nick: t.nick, platz: t.sitz_label || "", ticketId: t.id }
    : { ok: false, meldung, grund };
}

// Captive Portal: POST /check_otp {"username","otp"} (optional "mac", "ip").
// Antwort immer HTTP 200 mit {"status": "200"|"4xx", "message": "…"}.
const otpFehlschlaege = new Map();
async function checkOtp(request, env, cors) {
  const antwort = (status, message) => json({ status: String(status), message }, 200, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return antwort(405, "Nur POST");
  let body;
  try { body = await request.json(); } catch (e) { return antwort(400, "JSON erwartet"); }
  if (!body || typeof body !== "object") return antwort(400, "JSON erwartet");
  const username = String(body.username ?? "").trim();
  const otp = String(body.otp ?? "").trim();
  if (!username || !otp) return antwort(400, "username und otp fehlen");

  // Gegen Durchprobieren von außen: je Absender-IP höchstens 300 Fehlversuche in 10 Minuten.
  // Großzügig, weil das Portal der Halle alle Gäste über dieselbe IP schickt; je Nick
  // bremst zusätzlich portalPruefen (10 Fehlversuche in 10 Minuten).
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const e = otpFehlschlaege.get(ip);
  if (e && e.bis > Date.now() && e.anzahl >= 300) return antwort(429, "Zu viele Fehlversuche, bitte später nochmal");

  try {
    if (!env.DB) throw new Error("Datenbank-Binding DB fehlt");
    await bereitmachen(env);
    const r = await portalPruefen(env, { nutzer: username, code: otp, mac: body.mac, ip: body.ip, ohneMac: true, macUnsicher: true, quelle: ip }, true);
    if (r.ok) return antwort(200, "Ok");
    if (!e || e.bis < Date.now()) otpFehlschlaege.set(ip, { anzahl: 1, bis: Date.now() + 10 * 60e3 });
    else e.anzahl++;
    return antwort(r.grund === "gebremst" ? 429 : 403, r.meldung || "Secret falsch");
  } catch (err) {
    if (err instanceof F) return antwort(err.status, err.message);
    console.error(err);
    return antwort(500, "Interner Fehler");
  }
}

function netzZeile(z) {
  return { id: z.id, at: z.at, mac: z.mac, ip: z.ip, nutzer: z.nutzer, ok: !!z.ok, grund: z.grund,
    ticketId: z.ticket_id, nick: z.nick || "", platz: z.sitz_label || "" };
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
  return zugangAus(await einstellungen(env), t);
}
function zugangAus(e, t) {
  const n = e.netz;
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

// Sitze + Plan einer Vorlage in eine LAN schreiben ("leer" = leerer Plan).
async function vorlageDaten(env, vorlageId) {
  const leer = { plan: { breite: 30, hoehe: 20, deko: [] }, sitze: [] };
  if (String(vorlageId) === "leer") return leer;
  const v = await eins(env, "SELECT daten FROM plan_vorlagen WHERE id = ?", Number(vorlageId));
  if (!v) throw new F(404, "Diese Sitzplan-Vorlage gibt es nicht.");
  return parse(v.daten, leer);
}
async function vorlageStatements(env, lanId, vorlageId) {
  const daten = await vorlageDaten(env, vorlageId);
  // Ältere Vorlagen kennen noch „orga“ – das wird zu „gesperrt“.
  const stmts = daten.sitze.map((s) => st(env, "INSERT INTO seats (id, lan_id, label, x, y, gesperrt, stufe) VALUES (?,?,?,?,?,?,?)",
    zufallsId(), lanId, s.label, s.x, s.y, s.gesperrt || s.orga ? 1 : 0, Math.max(1, Math.min(9, Number(s.stufe) || 1))));
  stmts.push(st(env, "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", "plan:" + lanId, JSON.stringify(daten.plan)));
  return stmts;
}

// ---------------------------------------------------------------------------
// PayPal REST (Orders v2)
// ---------------------------------------------------------------------------
function paypalBereit(env) { return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET); }
function paypalModus(env) { return String(env.PAYPAL_MODE || "sandbox").trim().toLowerCase() === "live" ? "live" : "sandbox"; }
let paypalToken = null; // { modus, wert, bis } – hält, solange die Worker-Instanz lebt
async function paypalAnfrage(env, methode, pfad, daten, idem) {
  const modus = paypalModus(env);
  const basis = modus === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  if (!paypalToken || paypalToken.modus !== modus || paypalToken.bis < Date.now() + 60000) {
    const r = await fetch(basis + "/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(String(env.PAYPAL_CLIENT_ID).trim() + ":" + String(env.PAYPAL_SECRET).trim()), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) { console.error("PayPal-Token", r.status, j.error); throw new F(502, "PayPal-Anmeldung fehlgeschlagen (Zugangsdaten / Modus prüfen)."); }
    paypalToken = { modus, wert: j.access_token, bis: Date.now() + (Number(j.expires_in) || 300) * 1000 };
  }
  const kopf = { Authorization: "Bearer " + paypalToken.wert, "Content-Type": "application/json", Prefer: "return=representation" };
  if (idem) kopf["PayPal-Request-Id"] = idem;
  const r = await fetch(basis + pfad, { method: methode, headers: kopf, body: methode === "GET" ? undefined : JSON.stringify(daten || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const grund = ((j.details || [])[0] || {}).issue || j.name || r.status;
    console.error("PayPal", pfad, r.status, JSON.stringify(j).slice(0, 500));
    throw new F(502, "PayPal-Fehler: " + grund);
  }
  return j;
}

// PayPal-Bestellung prüfen, erst dann einziehen und das Ticket als bezahlt markieren.
// Reihenfolge ist wichtig: Betrag und Ticket VOR dem Einzug vergleichen, die Capture-ID
// sofort danach speichern – so geht keine Zahlung verloren, auch wenn danach etwas schiefgeht.
async function paypalEinziehen(c, t, orderId) {
  const env = c.env;
  const pfad = "/v2/checkout/orders/" + encodeURIComponent(orderId);
  const passt = (einh, betrag) => !!einh && betrag && betrag.currency_code === "EUR"
    && Math.round(Number(betrag.value) * 100) === t.preis_cent && String(einh.custom_id || "") === String(t.id);
  let erg = await paypalAnfrage(env, "GET", pfad);
  if (erg.status === "APPROVED") {
    const einh = (erg.purchase_units || [])[0];
    if (!passt(einh, einh && einh.amount)) {
      await los(env, "UPDATE tickets SET paypal_order = '' WHERE id = ? AND paypal_order = ?", t.id, orderId);
      await protokoll(c, "paypal-betrag-geaendert", { ticket: t.id, order: orderId });
      throw new F(409, "Der Ticketpreis hat sich geändert – es wurde nichts abgebucht. Bitte starte die Zahlung neu.");
    }
    try {
      erg = await paypalAnfrage(env, "POST", pfad + "/capture", {}, "capture-" + orderId);
    } catch (e) {
      // Schon eingezogen (z. B. Seite doppelt geladen) → Stand abfragen
      if (!(e instanceof F) || !/ORDER_ALREADY_CAPTURED/.test(e.message)) throw e;
      erg = await paypalAnfrage(env, "GET", pfad);
    }
  }
  const einh = (erg.purchase_units || [])[0] || {};
  const cap = ((einh.payments || {}).captures || [])[0];
  if (!cap) throw new F(409, "Die Zahlung wurde bei PayPal noch nicht bestätigt. Versuch es bitte nochmal.");
  // Ab hier ist (wahrscheinlich) Geld unterwegs: Capture-ID sofort festhalten. Sperrt Storno und neue Zahlung.
  await los(env, "UPDATE tickets SET paypal_capture = ? WHERE id = ?", (cap.status === "COMPLETED" ? "" : cap.status + ":") + cap.id, t.id);
  if (cap.status !== "COMPLETED") {
    await protokoll(c, "paypal-nicht-abgeschlossen", { ticket: t.id, status: erg.status, capture: cap.id, capStatus: cap.status });
    throw new F(409, cap.status === "PENDING"
      ? "PayPal prüft die Zahlung noch. Die Orga bestätigt dein Ticket, sobald das Geld da ist."
      : "Die Zahlung wurde von PayPal nicht abgeschlossen (" + cap.status + "). Bitte melde dich bei der Orga.");
  }
  const betrag = Math.round(Number(cap.amount && cap.amount.value) * 100);
  if (!passt({ custom_id: einh.custom_id || cap.custom_id }, cap.amount)) {
    await protokoll(c, "paypal-betrag-falsch", { ticket: t.id, betrag, soll: t.preis_cent, capture: cap.id });
    throw new F(409, "Der bezahlte Betrag passt nicht zum Ticket. Die Orga schaut sich das an.");
  }
  const r = await los(env, "UPDATE tickets SET status = 'bezahlt', bezahlt_at = ?, bezahlt_von = 'PayPal', zahlart = 'paypal_direkt' WHERE id = ? AND status = 'offen'",
    Date.now(), t.id);
  if (!geaendert(r)) {
    const jetzt = await eins(env, "SELECT status FROM tickets WHERE id = ?", t.id);
    if (jetzt && jetzt.status === "bezahlt") return;
    await protokoll(c, "paypal-bezahlt-ticket-nicht-offen", { ticket: t.id, capture: cap.id, status: jetzt && jetzt.status });
    throw new F(409, "Deine Zahlung ist eingegangen, aber dein Ticket wurde inzwischen storniert. Bitte melde dich bei der Orga – du bekommst das Geld zurück.");
  }
  await protokoll(c, "paypal-bezahlt", { ticket: t.id, betrag, capture: cap.id });
}

// Automatische Ausbaustufe: Sind so viele Sitzplatz-Tickets verkauft, wie die aktive Stufe
// Plätze hat, wird die nächste Stufe freigeschaltet (nur aufwärts, nie zurück).
// Beispiel: Stufe 1 = 96 Plätze → mit dem 96. Ticket öffnet Stufe 2, der 97. Gast kann kaufen.
async function stufeNachziehen(c, lanId) {
  const env = c.env;
  const [[l], stufen, [t]] = await lesen(env,
    ["SELECT stufe_aktiv, stufe_auto FROM lans WHERE id = ?", lanId],
    ["SELECT stufe, COUNT(*) AS n FROM seats WHERE lan_id = ? AND gesperrt = 0 GROUP BY stufe ORDER BY stufe", lanId],
    [`SELECT COUNT(*) AS n FROM tickets t JOIN ticket_types tt ON tt.id = t.type_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE t.lan_id = ? AND tt.mit_sitz = 1 AND t.status != 'storniert' AND COALESCE(s.gesperrt, 0) = 0`, lanId]);
  if (!l) return 1;
  const alt = l.stufe_aktiv || 1;
  if (!l.stufe_auto || !stufen.length) return alt;
  const maxStufe = Math.max(...stufen.map((z) => z.stufe));
  const plaetzeBis = (k) => stufen.filter((z) => z.stufe <= k).reduce((sum, z) => sum + z.n, 0);
  let aktiv = alt;
  while (aktiv < maxStufe && t.n >= plaetzeBis(aktiv)) aktiv++;
  if (aktiv > alt) {
    await los(env, "UPDATE lans SET stufe_aktiv = ? WHERE id = ?", aktiv, lanId);
    await protokoll(c, "ausbaustufe-auto", { lan: lanId, von: alt, auf: aktiv, tickets: t.n });
  }
  return aktiv;
}

async function sitzSetzen(env, ticketId, userId, lanId, sitzId, durchOrga) {
  const s = await eins(env, `SELECT s.*, g.ablauf AS g_ablauf, g.name AS g_name FROM seats s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = ? AND s.lan_id = ?`, sitzId, lanId);
  if (!s) throw new F(404, "Diesen Platz gibt es nicht.");
  if (s.gesperrt && !durchOrga) throw new F(409, "Dieser Platz ist gesperrt.");
  if (!durchOrga && (s.stufe || 1) > 1) {
    const l = await eins(env, "SELECT stufe_aktiv FROM lans WHERE id = ?", lanId);
    if ((s.stufe || 1) > ((l && l.stufe_aktiv) || 1)) throw new F(409, "Platz " + s.label + " wird erst mit Stage " + s.stufe + " freigeschaltet.");
  }
  const belegt = await eins(env, "SELECT id FROM tickets WHERE seat_id = ?", sitzId);
  if (belegt && belegt.id !== ticketId) throw new F(409, "Platz " + s.label + " ist schon vergeben.");
  if (!durchOrga && s.group_id && s.g_ablauf > Date.now()) {
    const m = await eins(env, "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", s.group_id, userId);
    if (!m) throw new F(409, "Platz " + s.label + " ist für die Gruppe „" + s.g_name + "“ vorgemerkt.");
  }
  // Der UNIQUE-Index auf seat_id fängt den Fall ab, dass jemand in derselben Millisekunde zugreift.
  await los(env, "UPDATE tickets SET seat_id = ? WHERE id = ?", sitzId, ticketId);
}

// Spätestes Ende einer Gruppe nach den Einstellungen (ms): Höchstdauer ab Gründung
// und Stichtag vor LAN-Beginn. Infinity = keine Grenze.
function gruppeGrenze(e, lan, erstellt) {
  let grenze = Infinity;
  const maxTage = Number(e.gruppeMaxTage) || 0;
  if (maxTage > 0) grenze = Math.min(grenze, erstellt + maxTage * 864e5);
  const stich = Number(e.gruppeStichtagTage);
  if (lan && lan.start && Number.isFinite(stich) && stich >= 0) grenze = Math.min(grenze, berlinMs(lan.start, "00:00:00") - stich * 864e5);
  return grenze;
}

async function eigeneGruppe(c, u) {
  const lan = await aktiveLan(c.env);
  const g = await eins(c.env, "SELECT g.* FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.lan_id = ?", u.id, lan.id);
  if (!g) throw new F(404, "Du bist in keiner Gruppe.");
  if (g.owner_id !== u.id && u.rolle !== "admin") throw new F(403, "Das darf nur die Gruppenleitung.");
  return g;
}

async function mitgliedEntfernen(env, g, userId) {
  // In EINEM Batch: Wer zuletzt geht, löscht die Gruppe – auch wenn zwei gleichzeitig gehen.
  const leer = "NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = ?)";
  await env.DB.batch([
    st(env, "DELETE FROM group_members WHERE group_id = ? AND user_id = ?", g.id, userId),
    st(env, `UPDATE seats SET group_id = NULL WHERE group_id = ? AND ${leer}`, g.id, g.id),
    st(env, `DELETE FROM groups WHERE id = ? AND ${leer}`, g.id, g.id),
  ]);
  const rest = await alle(env, "SELECT user_id FROM group_members WHERE group_id = ? ORDER BY created_at", g.id);
  if (rest.length && g.owner_id === userId) {
    await los(env, "UPDATE groups SET owner_id = ? WHERE id = ?", rest[0].user_id, g.id);
  }
}

async function gruppeDetail(env, gid, fuerUser, alsOrga) {
  const [[g], mitglieder, sitze] = await lesen(env,
    ["SELECT g.*, u.nick AS owner_nick FROM groups g JOIN users u ON u.id = g.owner_id WHERE g.id = ?", gid],
    [`SELECT u.id, u.nick, t.status AS t_status, s.label AS sitz, s.group_id AS sitz_gruppe
      FROM group_members gm JOIN users u ON u.id = gm.user_id
      LEFT JOIN tickets t ON t.user_id = u.id AND t.lan_id = gm.lan_id AND t.status != 'storniert'
      LEFT JOIN seats s ON s.id = t.seat_id WHERE gm.group_id = ? ORDER BY gm.created_at`, gid],
    ["SELECT s.id, s.label, t.user_id AS t_user FROM seats s LEFT JOIN tickets t ON t.seat_id = s.id WHERE s.group_id = ? ORDER BY s.y, s.x", gid]);
  if (!g) return null;
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
