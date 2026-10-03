// Demo-Modus: der ECHTE Worker (backend/worker.js) läuft im Browser, mit einer
// SQLite-Datenbank aus sql.js statt D1. Die Datenbank liegt im localStorage.
import worker from "../backend/worker.js?v=23";

const SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";
const SPEICHER = "agelan-demo-db-v1";
export const DEMO_PASSWORT = "demo1234";

function skriptLaden(src) {
  return new Promise((ok, fehler) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => fehler(new Error("sql.js konnte nicht geladen werden"));
    document.head.appendChild(s);
  });
}

// ---- D1-Nachbau über sql.js ----
class Anweisung {
  constructor(db, sql, p) { this.db = db; this.sql = sql; this.p = p || []; }
  bind(...p) { return new Anweisung(this.db, this.sql, p.map((x) => (typeof x === "boolean" ? (x ? 1 : 0) : x))); }
  zeilen() {
    const s = this.db.prepare(this.sql);
    try {
      s.bind(this.p);
      const out = [];
      while (s.step()) out.push(s.getAsObject());
      return out;
    } finally { s.free(); }
  }
  ausfuehren() {
    const s = this.db.prepare(this.sql);
    try { s.bind(this.p); while (s.step()) { /* weiter */ } } finally { s.free(); }
    const changes = this.db.getRowsModified();
    const id = this.db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    return { success: true, meta: { changes, last_row_id: id } };
  }
  async first(spalte) { const r = this.zeilen()[0]; return r ? (spalte ? r[spalte] : r) : null; }
  async all() { return { success: true, results: this.zeilen(), meta: {} }; }
  async run() { return this.ausfuehren(); }
}

function d1(db) {
  return {
    prepare: (sql) => new Anweisung(db, sql),
    async batch(liste) {
      db.exec("BEGIN");
      try {
        const out = liste.map((a) => (/^\s*select/i.test(a.sql) ? { results: a.zeilen() } : a.ausfuehren()));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

function speichern(db) {
  try {
    const bytes = db.export();
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    localStorage.setItem(SPEICHER, btoa(s));
  } catch (e) { console.warn("Demo-DB nicht gespeichert", e); }
}

export function demoZuruecksetzen() {
  try { localStorage.removeItem(SPEICHER); localStorage.removeItem("agelan-token"); } catch (e) { /* egal */ }
  location.reload();
}

export async function starten() {
  await skriptLaden(SQL_CDN + "sql-wasm.js");
  const SQL = await window.initSqlJs({ locateFile: (f) => SQL_CDN + f });
  let db;
  let gespeichert = null;
  try { gespeichert = localStorage.getItem(SPEICHER); } catch (e) { /* privat */ }
  db = gespeichert ? new SQL.Database(Uint8Array.from(atob(gespeichert), (c) => c.charCodeAt(0))) : new SQL.Database();
  const env = { DB: d1(db), TOKEN_SECRET: "demo-geheimnis", ADMIN_SETUP: "demo", PORTAL_SECRET: "demo-portal", ORIGINS: "*" };
  const fetchen = async (req) => {
    const res = await worker.fetch(req, env, { waitUntil() {} });
    speichern(db);
    return res;
  };
  if (!gespeichert) await demoDatenAnlegen(db, fetchen);
  return { fetch: fetchen };
}

// ---- Beispieldaten, damit der Sitzplan nicht leer aussieht ----
async function demoDatenAnlegen(db, fetchen) {
  const anfrage = (aktion, daten) => fetchen(new Request("https://demo.invalid/api", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aktion, ...daten }),
  })).then((r) => r.json());

  // Erstes Konto über den Worker anlegen (liefert einen echten Passwort-Hash) …
  await anfrage("registrieren", {
    nick: "Orga", email: "orga@demo.invalid", passwort: DEMO_PASSWORT, vorname: "Olli", nachname: "Orga",
    geburtsdatum: "1985-05-05", datenschutz: true,
  });
  const q = (sql, p = []) => { const s = db.prepare(sql); s.bind(p); const out = []; while (s.step()) out.push(s.getAsObject()); s.free(); return out; };
  const x = (sql, p = []) => db.run(sql, p);
  x("UPDATE users SET rolle = 'admin' WHERE nick = 'Orga'");
  const hash = q("SELECT pw FROM users WHERE nick = 'Orga'")[0].pw;
  x("UPDATE lans SET start = '2027-10-07', ende = '2027-10-10', name = 'AGE-LAN #4'");
  x("INSERT OR REPLACE INTO settings (key, value) VALUES ('zahlung', ?)", [JSON.stringify({
    arten: { paypal: true, ueberweisung: true, bar: true },
    paypal: "tickets@demo.invalid", paypalMe: "", iban: "DE00 1234 5678 9000 0000 00", kontoinhaber: "Demo Orga", bank: "Demo-Bank",
    hinweis: "Bitte gib bei PayPal und Überweisung deinen Nickname und die ersten 8 Zeichen deines Ticket-Codes als Verwendungszweck an. Bei PayPal bitte „Freunde und Familie“ wählen.",
    fristTage: 14,
  })]);
  x("INSERT OR REPLACE INTO settings (key, value) VALUES ('sponsoren', ?)", [JSON.stringify([
    { name: "Hardware-Partner", url: "", logo: "" }, { name: "Kühl-Partner", url: "", logo: "" }, { name: "Getränke-Partner", url: "", logo: "" },
  ])]);
  const jetzt = Date.now();
  const news = [
    ["2026-09-28", "Der Ticketverkauf für die AGE-LAN #4 ist offen", "Sichert euch jetzt die limitierten First-Ager-Tickets.", "Ab sofort könnt ihr Tickets für die AGE-LAN #4 kaufen.\n\nDie ersten 30 Sitzplätze gibt es zum First-Ager-Preis. Danach gilt der normale Preis.\n\nNeu: Reservierungsgruppen. Gründet eine Gruppe, merkt euch einen Block Plätze vor und gebt den Gruppen-Code an eure Leute weiter."],
    ["2026-09-12", "Erstes Turnier angekündigt: 2v2 Arabia", "Das Eröffnungsturnier steht.", "Zum Auftakt spielen wir 2v2 auf Arabia. Anmeldung vor Ort über die AgeLan-App."],
    ["2026-08-30", "Neue Website", "Tickets, Sitzplan und Check-in jetzt an einem Ort.", "Mit eurem Konto kauft ihr Tickets, wählt euren Platz und bekommt euer Ticket mit QR-Code."],
  ];
  for (const [datum, titel, teaser, text] of news) x("INSERT INTO news (titel, teaser, text, datum, created_at) VALUES (?,?,?,?,?)", [titel, teaser, text, datum, jetzt]);

  const nicks = ["Huskarl", "Mangonel", "Trebuchet", "Paladin", "Wololo", "Kriegselefant", "Schildwache", "Hussar", "Arbalest", "Halberdier",
    "Konquistador", "Mameluke", "Samurai", "Berserker", "Kataphrakt", "Janitschar", "Longbow", "Woad", "Teutone", "Bombarde",
    "Hellebarde", "Kamelreiter", "Steppenlanze", "Druzhina", "Obuch", "Leitis", "Coustillier", "Shotel", "Gbeto", "Ratha",
    "Chakram", "Urumi", "Ghulam", "Karambit", "Organ", "Genitour", "Kipchak", "Keshik", "Magyar", "Boyar",
    "Plumed", "Jaguar", "Eagle", "Slinger", "Kamayuk", "Rattan", "Ballista", "Arambai", "ChuKoNu", "Tarkan"];
  const gruppen = [["Die Teutonen", ["Teutone", "Paladin", "Hellebarde", "Bombarde"], ["A1", "A2", "A3", "A4", "B1", "B2"]],
    ["Clan Wololo", ["Wololo", "Mangonel", "Trebuchet"], ["D5", "D6", "D7", "C5"]],
    ["Steppe", ["Keshik", "Kipchak", "Magyar", "Steppenlanze", "Tarkan"], ["G1", "H1", "G2", "H2", "G3", "H3"]],
    ["Inka-Express", ["Kamayuk", "Slinger", "Jaguar"], ["E10", "F10", "E11", "F11"]]];
  const typen = q("SELECT id, name, mit_sitz, preis_cent FROM ticket_types ORDER BY sort");
  const sitze = Object.fromEntries(q("SELECT id, label FROM seats").map((s) => [s.label, s.id]));
  const freieLabels = Object.keys(sitze).sort(() => Math.random() - 0.5);
  const vergeben = new Set();
  const userIds = {};
  nicks.forEach((nick, i) => {
    x(`INSERT INTO users (nick, nick_key, email, email_key, vorname, nachname, geburtsdatum, discord, pw, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [nick, nick.toLowerCase(), nick.toLowerCase() + "@demo.invalid", nick.toLowerCase() + "@demo.invalid",
      "Demo", "Gast " + (i + 1), (1980 + (i % 28)) + "-0" + (1 + (i % 9)) + "-1" + (i % 9), "", hash, jetzt - (60 - i) * 864e5]);
    userIds[nick] = q("SELECT last_insert_rowid() AS id")[0].id;
  });
  const lanId = q("SELECT id FROM lans LIMIT 1")[0].id;
  for (const g of gruppen) {
    const [name, mitglieder, labels] = g;
    x("INSERT INTO groups (lan_id, name, name_key, owner_id, code, ablauf, created_at) VALUES (?,?,?,?,?,?,?)",
      [lanId, name, name.toLowerCase(), userIds[mitglieder[0]], Math.random().toString(36).slice(2, 8).toUpperCase(), jetzt + 14 * 864e5, jetzt]);
    const gid = q("SELECT last_insert_rowid() AS id")[0].id;
    for (const m of mitglieder) x("INSERT INTO group_members (group_id, user_id, lan_id, created_at) VALUES (?,?,?,?)", [gid, userIds[m], lanId, jetzt]);
    for (const l of labels) { x("UPDATE seats SET group_id = ? WHERE id = ?", [gid, sitze[l]]); vergeben.add(l); }
    g.sitzVon = Object.fromEntries(mitglieder.map((m, i) => [m, labels[i]]));
  }
  const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  nicks.forEach((nick, i) => {
    if (i % 11 === 10) return; // ein paar ohne Ticket
    const typ = i < 22 ? typen[0] : i % 7 === 3 ? typen[2] : typen[1];
    const bezahlt = i % 5 !== 2;
    const zahlart = ["paypal", "ueberweisung", "paypal", "bar"][i % 4];
    let sitz = null;
    if (typ.mit_sitz && i % 6 !== 5) {
      const g = gruppen.find((gg) => gg.sitzVon && gg.sitzVon[nick]);
      const label = g ? g.sitzVon[nick] : freieLabels.find((l) => !vergeben.has(l));
      if (label) { vergeben.add(label); sitz = sitze[label]; }
    }
    x(`INSERT INTO tickets (lan_id, user_id, type_id, code, status, zahlart, preis_cent, seat_id, agb_at, created_at, bezahlt_at, bezahlt_von)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [lanId, userIds[nick], typ.id, hex(), bezahlt ? "bezahlt" : "offen", zahlart, typ.preis_cent, sitz,
      jetzt, jetzt - (50 - i) * 864e5, bezahlt ? jetzt - (45 - i) * 864e5 : null, bezahlt ? "Orga" : ""]);
  });
  speichern(db);
}
