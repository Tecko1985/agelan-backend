import { api, token, tokenSetzen, istDemo, appAnmeldungEntfernen, APP_KONTO_KEY, APP_TAB_KEY } from "./api.js?v=12";
import { esc, el, $, $$, euro, zeitraum, newsDatum, datum, fehler, toast, AGELAN_APP, kopierenVerdrahten, sichereUrl } from "./ui.js?v=12";

export const zustand = { daten: null, ich: null };

export async function neuLaden() {
  const [daten, ich] = await Promise.all([
    api("oeffentlich"),
    token() ? api("ich").catch(() => null) : Promise.resolve(null),
  ]);
  zustand.daten = daten;
  zustand.ich = ich;
  rahmenZeichnen();
  return daten;
}

export const istOrga = () => !!zustand.ich && ["orga", "admin"].includes(zustand.ich.nutzer.rolle);
export const istAdmin = () => !!zustand.ich && zustand.ich.nutzer.rolle === "admin";

export function abmelden() {
  tokenSetzen("");
  appAnmeldungEntfernen();
  zustand.ich = null;
  gehe("#/");
}

// Zur Seite wechseln: Hash setzen (hashchange ruft route auf); nur wenn der Hash
// schon stimmt, selbst neu zeichnen – sonst würde die Seite doppelt gerendert.
export function gehe(ziel) {
  const jetzt = "#" + (location.hash.replace(/^#/, "") || "/");
  if (jetzt === ziel) route();
  else location.hash = ziel;
}

// ---------------------------------------------------------------------------
// Rahmen: Kopf, Bänder, Fuß
// ---------------------------------------------------------------------------
function rahmenZeichnen() {
  const d = zustand.daten;
  const s = d.einstellungen.seite;
  const baender = [];
  if (istDemo) {
    baender.push(`<div class="demo-band">Demo-Modus – alle Daten liegen nur in diesem Browser. Demo-Login: <b>Orga</b> / <b>demo1234</b> (Veranstalter)
      <button class="knopf klein geist" id="demo-reset">Demo zurücksetzen</button></div>`);
  }
  if (s.headerInfo) baender.push(`<div class="info-band">${esc(s.headerInfo)}</div>`);
  $("#baender").innerHTML = baender.join("");
  const reset = $("#demo-reset");
  if (reset) reset.onclick = async () => (await import("./demo.js?v=12")).demoZuruecksetzen();

  $$(".nur-orga").forEach((a) => a.classList.toggle("versteckt", !istOrga()));
  const rechts = $("#kopf-rechts");
  if (zustand.ich) {
    const t = zustand.ich.ticket;
    // Auf dem Handy kurze Beschriftungen statt leerer Knöpfe.
    rechts.innerHTML = `<a class="knopf klein ${t ? "" : "primaer"}" href="${t ? "#/konto" : "#/tickets"}">${t ? "<span class='knopf-text'>Mein </span>Ticket" : "Ticket<span class='knopf-text'> kaufen</span>"}</a>
      <a class="knopf klein geist" href="#/konto" title="Mein Konto"><span class="knopf-text">${esc(zustand.ich.nutzer.nick)}</span><span class="knopf-kurz">Konto</span></a>`;
  } else {
    rechts.innerHTML = `<a class="knopf klein geist" href="#/konto">Anmelden</a><a class="knopf klein primaer" href="#/tickets"><span>Ticket</span></a>`;
  }

  const so = s.socials || {};
  const socials = [["discord", "DC"], ["twitch", "TW"], ["youtube", "YT"], ["instagram", "IG"], ["facebook", "FB"]]
    .filter(([k]) => sichereUrl(so[k])).map(([k, kurz]) => `<a href="${esc(sichereUrl(so[k]))}" target="_blank" rel="noopener" title="${k}">${kurz}</a>`).join("");
  $("#fuss").innerHTML = `
    <div><img src="img/logo.webp" alt="AGE LAN" width="64" height="64" style="margin-bottom:8px">
      <div>${esc(s.slogan)}</div><div class="klein leiser" style="margin-top:6px">© ${new Date().getFullYear()} AGE-LAN · Private Veranstaltung</div></div>
    <div class="zeile" style="gap:18px"><a href="#/faq">FAQ</a><a href="#/packliste">Packliste</a><a href="#/seite/anfahrt">Anfahrt</a><a href="#/seite/agb">Teilnahmebedingungen</a><a href="#/seite/datenschutz">Datenschutz</a><a href="#/seite/impressum">Impressum</a></div>
    <div class="socials">${socials}</div>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const SEITEN = {
  "": seiteStart,
  lan: seiteLan,
  faq: seiteFaq,
  packliste: seitePackliste,
  news: seiteNews,
  gaeste: seiteGaeste,
  tickets: seiteTickets,
  seite: seiteText,
  app: seiteApp,
  sitzplan: async (m, p) => (await import("./sitzplan.js?v=12")).render(m, p),
  konto: async (m, p) => (await import("./konto.js?v=12")).render(m, p),
  t: async (m, p) => (await import("./konto.js?v=12")).renderTicketSeite(m, p),
  checkin: async (m, p) => (await import("./checkin.js?v=12")).render(m, p),
  admin: async (m, p) => (await import("./admin.js?v=12")).render(m, p),
};

// Aufräumen beim Seitenwechsel (Intervalle, Kamera, Listener). el ist ein Element
// der Seite: Gehört es nicht mehr zur aktuellen Ansicht (die Seite wurde schon
// verlassen, während sie noch lud), wird sofort aufgeräumt.
let aufraeumen = [];
let ansicht = null;
export function beimVerlassen(fn, el) {
  if (el && !(ansicht && ansicht.contains(el))) { try { fn(); } catch (e) { /* egal */ } return; }
  aufraeumen.push(fn);
}
// Rückfrage vor dem Verlassen (z. B. ungespeicherter Sitzplan): fn liefert true = darf gehen.
let rueckfrage = null;
export function vorVerlassen(fn) { rueckfrage = fn; }

// Jeder Lauf rendert in einen eigenen Container. Startet ein neuer Lauf, bevor der
// alte fertig ist, schreibt der alte nur noch in seinen abgehängten Container.
let lauf = 0;
export async function route(ev) {
  const [, name = "", param = ""] = (location.hash.replace(/^#/, "") || "/").split("/");
  const fn = SEITEN[name] || seiteStart;
  // Bereichswechsel innerhalb der eingebetteten App: nicht neu laden, nur umschalten.
  if (name === "app" && appUmschalten(param)) return;
  if (rueckfrage && typeof HashChangeEvent !== "undefined" && ev instanceof HashChangeEvent) {
    const frage = rueckfrage;
    if (!(await frage())) { history.replaceState(null, "", new URL(ev.oldURL).hash || "#/"); return; }
  }
  const meiner = ++lauf;
  rueckfrage = null;
  // Offene Dialoge gehören zur alten Seite (z. B. Zurück-Wischen auf dem Handy).
  $$(".modal-hg").forEach((h) => (h.schliessen ? h.schliessen() : h.remove()));
  const alt = aufraeumen;
  aufraeumen = [];
  alt.forEach((f) => { try { f(); } catch (e) { /* egal */ } });
  $$("#nav a").forEach((a) => a.classList.toggle("aktiv", a.dataset.route === name));
  $("#nav").classList.remove("offen");
  const seite = el(`<div class="ansicht"><div class="lade">Lädt …</div></div>`);
  ansicht = seite;
  $("#app").replaceChildren(seite);
  try {
    await fn(seite, decodeURIComponent(param));
  } catch (e) {
    seite.innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">${esc(e.message)}</div></div>`;
  }
  if (meiner !== lauf) return;
  if (!location.hash.includes("#/admin")) window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Seiten
// ---------------------------------------------------------------------------
function belegungHtml(z) {
  const proz = z.sitzplaetze ? Math.round((z.sitzTickets / z.sitzplaetze) * 100) : 0;
  return `<div class="belegung"><div class="zeile zwischen"><span><b>${z.sitzFrei}</b> von ${z.sitzplaetze} PC-Plätzen frei</span><span class="leise">${z.gaeste} Gäste angemeldet</span></div>
    <div class="fortschritt"><i style="width:${proz}%"></i></div></div>`;
}

function datumKurz(iso) {
  const [j, m, t] = String(iso).split("-");
  return `${t}.${m}.${j}`;
}

function newsZeile(n) {
  return `<a class="news-zeile" href="#/news/${n.id}"><time>${datumKurz(n.datum)}</time><div><b>${esc(n.titel)}</b>${n.teaser && n.teaser !== n.titel ? `<span>${esc(n.teaser)}</span>` : ""}</div></a>`;
}

function ticketKarte(t) {
  return `<div class="karte ticket-karte">
    <div class="zeile zwischen" style="align-items:baseline"><h3>${esc(t.name)}</h3><div class="preis">${euro(t.preisCent)}</div></div>
    <div class="leise klein">${t.mitSitz ? "mit PC-Platz" : "ohne PC-Platz"}${t.beschreibung ? " – " + esc(t.beschreibung) : ""}</div>
    <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    ${t.extras.length ? `<div class="klein leise">Extras: ${t.extras.map((x) => esc(x.name) + " (+" + euro(x.preisCent) + ")").join(", ")}</div>` : ""}
    <div class="klein leise ticket-hinweis">${[t.rest != null && t.rest > 0 ? "noch " + t.rest + " Stück" : "", t.bis ? "bis " + datum(t.bis) : ""].filter(Boolean).join(" · ")}</div>
    <button class="knopf ${t.verfuegbar ? "primaer" : ""} voll" data-kaufen="${t.id}" ${t.verfuegbar ? "" : "disabled"}>${t.verfuegbar ? "Ticket kaufen" : esc(t.grund)}</button>
  </div>`;
}

function ticketKnoepfeVerdrahten(root) {
  $$("[data-kaufen]", root).forEach((b) => (b.onclick = async () => {
    const konto = await import("./konto.js?v=12");
    konto.kaufen(Number(b.dataset.kaufen));
  }));
}

function countdownStarten(root, start) {
  const ziel = new Date(start + "T12:00:00").getTime();
  const box = $(".countdown", root);
  if (!box) return;
  const tick = () => {
    const rest = ziel - Date.now();
    if (rest <= 0) { box.textContent = "Die LAN läuft."; return; }
    const t = Math.floor(rest / 864e5), h = Math.floor(rest / 36e5) % 24, m = Math.floor(rest / 6e4) % 60;
    box.innerHTML = `Noch <b>${t}</b> Tage, <b>${h}</b> Std. und <b>${m}</b> Min.`;
  };
  tick();
  const iv = setInterval(tick, 30000);
  beimVerlassen(() => clearInterval(iv), root);
}

// Eingecheckt? Dann gehört die LAN-Zentrale ganz nach oben: Platz, Internet,
// und der direkte Weg in die AgeLan-App (Essen, Frühstück, Turniere, Stream).
const APP_KACHELN = [
  ["essen", "Essen bestellen", "Speisekarte, Sonderwünsche, abholen"],
  ["fruehstueck", "Frühstück", "Für morgen früh vorbestellen"],
  ["turnier", "Turniere", "Eintragen, Spielplan, Ergebnisse"],
  ["stream", "Stream", "Sendeplan und Showmatches"],
  ["downloads", "Downloads", "Klickzähler und Map-Pack"],
];
function lanZentraleHtml(ich) {
  const t = ich && ich.ticket;
  if (!t || !t.checkinAt || t.status === "storniert") return "";
  const z = t.zugang || {};
  const feld = (label, wert) => wert ? `<div class="lz-feld"><span>${esc(label)}</span><b class="mono">${esc(wert)}</b><button class="knopf klein geist" data-kopieren="${esc(wert)}">Kopieren</button></div>` : "";
  return `<section class="lan-zentrale"><div class="wrap">
    <div class="lz-kopf">
      <h2>Hallo ${esc(ich.nutzer.nick)}, du bist eingecheckt.</h2>
      <div class="lz-sitz">${t.sitz ? `Platz <b>${esc(t.sitz)}</b>` : esc(t.typ.name)}${t.gruppe ? ` · ${esc(t.gruppe)}` : ""}</div>
    </div>
    <div class="lz-raster">
      <div class="lz-kacheln">${APP_KACHELN.map(([b, titel, text]) => `<a class="app-kachel" href="#/app/${b}"><b>${titel}</b><small>${text}</small></a>`).join("")}</div>
      <div class="lz-netz"><h3>Internet</h3>
        ${feld("WLAN", z.ssid)}${feld("WLAN-Passwort", z.wlanPasswort)}${feld("Benutzer", z.benutzer)}${feld("Passwort", z.passwort)}
        ${sichereUrl(z.portal) ? `<a class="knopf klein primaer" href="${esc(sichereUrl(z.portal))}" target="_blank" rel="noopener" style="margin-top:10px">Zum Anmelde-Portal</a>` : ""}</div>
    </div></div></section>`;
}

function eckdatenListe(e) {
  return `<ul class="haken">${e.highlights.map((h) => `<li><b>${esc(h.titel)}</b>${h.text ? ` – ${esc(h.text)}` : ""}</li>`).join("")}</ul>`;
}

async function seiteStart(main) {
  const d = await neuLaden();
  const { lan, zahlen: z, einstellungen: e } = d;
  const ort = [lan.ort, lan.adresse].filter(Boolean).join(", ");
  main.innerHTML = lanZentraleHtml(zustand.ich) + `
  <div class="kopfbild"><img src="img/header.webp" alt="${esc(lan.name)} – Age of Empires 2 LAN"></div>
  <section class="eckdaten"><div class="wrap">
    <div class="eckdaten-innen">
      <div>
        <h1>${esc(lan.name)}</h1>
        <p class="eck-zeile">${esc(zeitraum(lan.start, lan.ende))}${ort ? " · " + esc(ort) : ""}</p>
        ${lan.start ? `<p class="countdown"></p>` : ""}
      </div>
      <div class="zeile"><a class="knopf primaer gross" href="#/tickets">Tickets</a><a class="knopf gross" href="#/sitzplan">Sitzplan</a></div>
    </div>
    ${belegungHtml(z)}
  </div></section>

  <section class="abschnitt"><div class="wrap lan-kurz">
    <figure><img src="img/halle.jpg" alt="Die Nordhessenhalle in Volkmarsen vor dem Aufbau" loading="lazy"><figcaption>Die Nordhessenhalle – noch leer. Ein paar Tage später stehen hier ${z.sitzplaetze} PCs.</figcaption></figure>
    <div><h2>Die LAN</h2>${lan.beschreibung ? `<p class="news-text">${esc(lan.beschreibung)}</p>` : ""}${eckdatenListe(e)}
      <p><a href="#/lan">Anfahrt, Hallenplan und alle Infos</a></p></div>
  </div></section>

  <section class="abschnitt"><div class="wrap">
    <div class="abschnitt-kopf"><h2>Tickets</h2><a href="#/tickets">Bezahlung und Ablauf</a></div>
    <div class="raster raster-3">${d.tickettypen.filter((t) => t.kaufbar).map(ticketKarte).join("") || `<div class="leer">Noch keine Tickets im Verkauf.</div>`}</div>
  </div></section>

  ${d.news.length ? `<section class="abschnitt"><div class="wrap schmal">
    <div class="abschnitt-kopf"><h2>News</h2><a href="#/lan">Alle Meldungen</a></div>
    <div class="news-liste">${d.news.slice(0, 5).map(newsZeile).join("")}</div>
  </div></section>` : ""}

  ${e.sponsoren.length ? `<section class="abschnitt"><div class="wrap">
    <h2>Sponsoren</h2>
    <div class="sponsoren">${e.sponsoren.map((s) => `<a class="sponsor" ${sichereUrl(s.url) ? `href="${esc(sichereUrl(s.url))}" target="_blank" rel="noopener"` : ""}>${s.logo ? `<img src="${esc(s.logo)}" alt="">` : ""}${esc(s.name)}</a>`).join("")}</div>
  </div></section>` : ""}

  ${e.seite.socials && sichereUrl(e.seite.socials.discord) ? `<section class="abschnitt"><div class="wrap"><p class="discord-zeile">Fragen, Mitfahrgelegenheit, Teams? Das läuft alles auf unserem <a href="${esc(sichereUrl(e.seite.socials.discord))}" target="_blank" rel="noopener">Discord</a>.</p></div></section>` : ""}`;
  ticketKnoepfeVerdrahten(main);
  kopierenVerdrahten(main);
  if (lan.start) countdownStarten(main, lan.start);
}

async function seiteTickets(main) {
  const d = await neuLaden();
  const z = d.zahlen;
  const za = d.einstellungen.zahlung;
  const arten = [za.arten.paypal && "PayPal (Freunde & Familie)", za.arten.ueberweisung && "Überweisung", za.arten.bar && "bar"].filter(Boolean);
  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf"><h1>Tickets</h1><p class="leise">${esc(d.lan.name)} · ${esc(zeitraum(d.lan.start, d.lan.ende))}</p>${belegungHtml(z)}</div>
    ${d.lan.verkaufOffen ? "" : `<div class="karte" style="margin:20px 0;border-color:var(--rot)">Der Ticketverkauf ist gerade geschlossen.</div>`}
    <div class="raster raster-3" style="margin-top:22px">${d.tickettypen.map(ticketKarte).join("") || `<div class="leer">Noch keine Tickets im Verkauf.</div>`}</div>
    <div class="karte ablauf" style="margin-top:28px"><h3>Ablauf</h3><ol>
      <li>Konto anlegen und Ticket bestellen.</li>
      <li>Bezahlen: ${esc(arten.join(", "))}. Sobald das Geld da ist, bestätigt die Orga dein Ticket – erst dann ist dein Platz sicher.</li>
      <li>Platz im <a href="#/sitzplan">Sitzplan</a> aussuchen. Wer zusammen sitzen will, gründet eine Reservierungsgruppe.</li>
      <li>Auf der LAN zeigst du den QR-Code deines Tickets beim Check-in vor. Danach stehen deine Internet-Daten im Konto.</li>
    </ol></div></div>`;
  ticketKnoepfeVerdrahten(main);
}

async function seiteLan(main) {
  const d = await neuLaden();
  const { lan, einstellungen: e } = d;
  const maps = lan.adresse ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(lan.ort + ", " + lan.adresse) : "";
  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf"><h1>${esc(lan.name)}</h1>${lan.beschreibung ? `<p class="news-text">${esc(lan.beschreibung)}</p>` : ""}</div>
    <div class="raster raster-2" style="margin-top:18px">
      <div class="karte"><h3>Eckdaten</h3><dl class="daten-liste">
        <dt>Wann</dt><dd>${esc(zeitraum(lan.start, lan.ende))}</dd>
        <dt>Wo</dt><dd>${esc(lan.ort)}${lan.adresse ? "<br>" + esc(lan.adresse) : ""}</dd>
        <dt>Plätze</dt><dd>${d.zahlen.sitzplaetze} PC-Plätze</dd>
        <dt>Gäste</dt><dd>${d.zahlen.gaeste} angemeldet</dd></dl>
        ${eckdatenListe(e)}
        ${maps ? `<a class="knopf klein" href="${maps}" target="_blank" rel="noopener">In Google Maps öffnen</a>` : ""}</div>
      <div class="karte"><h3>Anfahrt</h3><p class="news-text">${esc(e.texte.anfahrt || "Infos zur Anfahrt folgen.")}</p></div>
    </div>
    <div class="karte" style="margin-top:18px"><h3>Hallenplan</h3><img class="hallenplan" src="img/hallenplan.png" alt="Hallenplan der Nordhessenhalle mit Schlafsälen, Food-Point, Check-in und den Tischreihen A bis H" loading="lazy"></div>
    <div class="abschnitt-kopf" style="margin-top:40px"><h2>News</h2></div>
    <div class="news-liste schmal">${d.news.map(newsZeile).join("") || `<div class="leer">Noch keine News.</div>`}</div>
  </div>`;
}

async function seiteNews(main, id) {
  const { news } = await api("news", { id: Number(id) });
  const d = newsDatum(news.datum);
  main.innerHTML = `<div class="wrap" style="max-width:780px"><div class="seitenkopf">
    <a href="#/lan" class="klein">← Alle News</a>
    <div class="leise" style="margin-top:16px">${d.tag}. ${d.monat} ${d.jahr}</div><h1>${esc(news.titel)}</h1>
    <p class="leise" style="font-size:1.1rem">${esc(news.teaser)}</p></div>
    <div class="karte news-text">${esc(news.text)}</div></div>`;
}

async function seiteFaq(main) {
  const d = zustand.daten || await neuLaden();
  main.innerHTML = `<div class="wrap" style="max-width:860px"><div class="seitenkopf"><h1>FAQ</h1></div>
    ${d.einstellungen.faq.map((f, i) => `<details class="faq" ${i === 0 ? "open" : ""}><summary>${esc(f.f)}</summary><div>${esc(f.a)}</div></details>`).join("")}</div>`;
}

// Packliste: fest im Code, Haken merkt sich nur der eigene Browser.
const PACKLISTE = [
  ["Rechner & Zubehör", [
    ["pc", "PC oder Laptop"],
    ["netzteil", "Stromkabel für PC und Monitor (bzw. Laptop-Netzteil)"],
    ["monitor", "Monitor mit passendem Kabel (HDMI / DisplayPort)"],
    ["maus", "Maus und Mauspad"],
    ["tastatur", "Tastatur"],
    ["headset", "Headset oder Kopfhörer"],
    ["lankabel", "Netzwerkkabel, am besten 5 m oder länger"],
    ["steckdose", "Mehrfachsteckdose"],
  ]],
  ["Vorher zu Hause erledigen", [
    ["update", "Age of Empires 2 und Windows auf den neuesten Stand bringen"],
    ["login", "Zugangsdaten für Steam bzw. Microsoft-Konto parat haben"],
    ["treiber", "Grafiktreiber aktualisieren"],
  ]],
  ["Persönliches", [
    ["ticket", "Ticket (QR-Code auf dem Handy oder ausgedruckt)"],
    ["ausweis", "Personalausweis"],
    ["muttizettel", "Unter 18: unterschriebener Muttizettel und Aufsichtsperson"],
    ["bargeld", "Etwas Bargeld"],
    ["handy", "Handy mit Ladekabel"],
    ["kleidung", "Bequeme Kleidung und Wechselsachen"],
  ]],
  ["Übernachtung", [
    ["schlafsack", "Schlafsack oder Decke und Kissen"],
    ["isomatte", "Isomatte oder Luftmatratze"],
    ["handtuch", "Handtuch und Duschzeug"],
    ["ohrstoepsel", "Ohrstöpsel und Schlafmaske"],
  ]],
];
const PACK_KEY = "packliste";

function seitePackliste(main) {
  let haken = {};
  try { haken = JSON.parse(localStorage.getItem(PACK_KEY) || "{}") || {}; } catch (e) { /* privater Modus */ }
  const alle = PACKLISTE.flatMap(([, punkte]) => punkte.map(([id]) => id));
  main.innerHTML = `<div class="wrap" style="max-width:780px"><div class="seitenkopf"><span class="ueberzeile">Vor der LAN</span><h1>Packliste</h1>
    <p>Das brauchst du typischerweise für die LAN. Strom und Netz gibt es an jedem Platz, Getränke und Essen vor Ort. Bier darf nicht mitgebracht werden.</p></div>
    <div class="karte"><div class="zeile" style="justify-content:space-between"><b id="pk-stand"></b><button class="knopf klein geist" id="pk-reset">Alle Haken entfernen</button></div></div>
    ${PACKLISTE.map(([titel, punkte]) => `<div class="karte" style="margin-top:14px"><h3>${esc(titel)}</h3>
      <div class="packliste">${punkte.map(([id, text]) => `<label class="pack-punkt"><input type="checkbox" data-pack="${id}" ${haken[id] ? "checked" : ""}><span>${esc(text)}</span></label>`).join("")}</div></div>`).join("")}
    <p class="leise klein" style="margin-top:14px">Die Haken werden nur auf diesem Gerät gespeichert.</p></div>`;
  const stand = () => {
    const n = alle.filter((id) => haken[id]).length;
    $("#pk-stand", main).textContent = n === alle.length ? "Alles eingepackt." : `${n} von ${alle.length} erledigt`;
  };
  const speichern = () => { try { localStorage.setItem(PACK_KEY, JSON.stringify(haken)); } catch (e) { /* egal */ } };
  $$("[data-pack]", main).forEach((cb) => (cb.onchange = () => {
    if (cb.checked) haken[cb.dataset.pack] = 1; else delete haken[cb.dataset.pack];
    speichern(); stand();
  }));
  $("#pk-reset", main).onclick = () => { haken = {}; speichern(); $$("[data-pack]", main).forEach((cb) => (cb.checked = false)); stand(); };
  stand();
}

const TEXTSEITEN = { anfahrt: "Anfahrt", impressum: "Impressum", datenschutz: "Datenschutz", agb: "Teilnahmebedingungen" };
// Rechtstexte & Co. werden als schlichter Text gepflegt (Verwaltung → Einstellungen).
// Hier wird daraus lesbares HTML: kurze Zeilen ohne Schlusspunkt am Blockanfang
// werden Überschriften, Zeilen mit "1." / "-" werden Listen, "Stand: …" klein.
function textAlsHtml(text, seitenTitel) {
  const verlinken = (s) => esc(s)
    .replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, '<a href="mailto:$1">$1</a>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const istUeberschrift = (z) => z.length <= 80 && !/[.,;]$/.test(z) && !/^(Stand|Telefon|E-Mail)\b/.test(z);
  const bloecke = String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.split("\n").map((z) => z.trim()).filter(Boolean)).filter((b) => b.length);
  let html = "";
  bloecke.forEach((zeilen, i) => {
    // Erste Zeile, die nur den Seitentitel wiederholt, weglassen.
    if (i === 0 && seitenTitel && zeilen[0].toLowerCase().startsWith(seitenTitel.toLowerCase().slice(0, 12))) zeilen = zeilen.slice(1);
    if (!zeilen.length) return;
    if (zeilen.length === 1 && istUeberschrift(zeilen[0]) && !/^\d+\.\s/.test(zeilen[0]) && zeilen[0].split(" ").length <= 4) {
      html += `<h2>${esc(zeilen[0])}</h2>`;
      return;
    }
    if (zeilen.length > 1 && istUeberschrift(zeilen[0])) {
      html += `<h3>${esc(zeilen[0])}</h3>`;
      zeilen = zeilen.slice(1);
    }
    const nummeriert = zeilen.every((z) => /^\d+\.\s/.test(z));
    const punkte = zeilen.every((z) => /^[-–•]\s/.test(z));
    if (zeilen.length > 1 && (nummeriert || punkte)) {
      const tag = nummeriert ? "ol" : "ul";
      html += `<${tag}>${zeilen.map((z) => `<li>${verlinken(z.replace(/^(\d+\.|[-–•])\s+/, ""))}</li>`).join("")}</${tag}>`;
      return;
    }
    // Kurze Zeilen (Anschrift, Kontakt) bleiben ein Absatz mit Umbrüchen.
    if (zeilen.length > 1 && zeilen.every((z) => z.length < 70)) {
      html += `<p>${zeilen.map(verlinken).join("<br>")}</p>`;
      return;
    }
    zeilen.forEach((z) => {
      if (/^Stand:/.test(z)) html += `<p class="stand">${esc(z)}</p>`;
      else html += `<p>${verlinken(z)}</p>`;
    });
  });
  return html;
}

async function seiteText(main, welche) {
  const d = zustand.daten || await neuLaden();
  const titel = TEXTSEITEN[welche] || "Seite";
  const inhalt = d.einstellungen.texte[welche] || "";
  main.innerHTML = `<div class="wrap rechtstext-wrap"><div class="seitenkopf"><h1>${esc(titel)}</h1></div>
    <article class="rechtstext">${inhalt ? textAlsHtml(inhalt, titel) : "<p>Dieser Text wird noch ergänzt.</p>"}</article></div>`;
}

async function seiteGaeste(main) {
  const d = await api("gaeste");
  if (!d.oeffentlich) { main.innerHTML = `<div class="wrap"><div class="seitenkopf"><h1>Gäste</h1></div><div class="leer">Die Gästeliste ist nicht öffentlich.</div></div>`; return; }
  const z = d.zahlen;
  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf"><h1>Gäste <span class="leise">(${d.gaeste.length})</span></h1>${belegungHtml(z)}</div>
    <div class="zeile" style="margin:18px 0"><input id="g-suche" placeholder="Suchen nach Nick, Gruppe oder Platz …" style="max-width:360px"></div>
    <div class="tabelle-wrap"><table><thead><tr><th>#</th><th>Nickname</th><th>Gruppe</th><th>Ticket</th><th>Platz</th></tr></thead><tbody id="g-liste"></tbody></table></div></div>`;
  const zeichnen = () => {
    const q = $("#g-suche", main).value.trim().toLowerCase();
    const liste = d.gaeste.filter((g) => !q || [g.nick, g.gruppe, g.sitz].join(" ").toLowerCase().includes(q));
    $("#g-liste", main).innerHTML = liste.map((g, i) => `<tr><td class="leise">${i + 1}</td><td><b>${esc(g.nick)}</b></td><td>${g.gruppe ? `<span class="abzeichen blau">${esc(g.gruppe)}</span>` : ""}</td>
      <td class="leise">${esc(g.typ)}</td><td>${g.sitz ? `<a href="#/sitzplan/${encodeURIComponent(g.sitz)}" class="abzeichen gold">${esc(g.sitz)}</a>` : `<span class="leise">–</span>`}</td></tr>`).join("")
      || `<tr><td colspan="5" class="leise">Niemand gefunden.</td></tr>`;
  };
  $("#g-suche", main).oninput = zeichnen;
  zeichnen();
}

// ---------------------------------------------------------------------------
// AgeLan-App eingebettet (#/app/<bereich>)
// ---------------------------------------------------------------------------
// Die App (agelan-klon) liegt unter derselben Herkunft (tecko1985.github.io).
// Die Website holt beim Backend ein App-Token und legt es dort ab, wo die App
// ihre Anmeldung sucht (localStorage "klon:agelan_konto" – mit Präfix, damit es
// nicht mit der Live-App unter derselben Herkunft kollidiert) – dann startet sie
// im iframe ohne zweite Anmeldung.
const BEREICHE = [["essen", "Essen"], ["fruehstueck", "Frühstück"], ["turnier", "Turniere"], ["stream", "Stream"], ["downloads", "Downloads"]];

function appUmschalten(bereich) {
  const rahmen = $("#app-frame");
  const ziel = BEREICHE.find(([b]) => b === bereich);
  if (!rahmen || !ziel) return false;
  try {
    const w = rahmen.contentWindow;
    if (typeof w.activateTab !== "function") return false;
    w.activateTab(bereich);
    if (typeof w.document !== "undefined") { const hub = w.document.getElementById("start-hub"); if (hub) hub.hidden = true; }
  } catch (e) { return false; }
  $$(".app-kopf .app-kachel").forEach((a) => a.classList.toggle("aktiv", a.getAttribute("href") === "#/app/" + bereich));
  return true;
}

async function seiteApp(main, bereich) {
  if (!BEREICHE.some(([b]) => b === bereich)) bereich = "essen";
  await neuLaden();
  if (!zustand.ich) {
    main.innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">Bitte zuerst <a href="#/konto">anmelden</a>.</div></div>`;
    return;
  }
  let konto;
  try { konto = (await api("appToken")).konto; } catch (e) {
    main.innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">${esc(e.message)}</div></div>`;
    return;
  }
  try {
    localStorage.setItem(APP_KONTO_KEY, JSON.stringify(konto));
    localStorage.setItem(APP_TAB_KEY, bereich);
  } catch (e) { /* privater Modus: dann fragt die App selbst nach der Anmeldung */ }
  // Dieselben Kacheln wie in der LAN-Zentrale der Startseite – sie sind hier die
  // Navigation; die Reiterleiste der App ist eingebettet ausgeblendet.
  // &t= erzwingt die aktuelle Fassung der App (GitHub Pages cacht sonst 10 Min).
  main.innerHTML = `<div class="app-rahmen">
    <div class="app-kopf"><div class="wrap lz-kacheln">${APP_KACHELN.map(([b, titel, text]) => `<a class="app-kachel ${b === bereich ? "aktiv" : ""}" href="#/app/${b}"><b>${titel}</b><small>${text}</small></a>`).join("")}</div></div>
    <iframe id="app-frame" title="AgeLan-App" src="${AGELAN_APP}?eingebettet=1&bereich=${bereich}&t=${Date.now()}"></iframe></div>`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
$("#burger").onclick = () => $("#nav").classList.toggle("offen");
window.addEventListener("hashchange", route);
neuLaden().then(route).catch((e) => {
  $("#app").innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">${esc(e.message)}</div></div>`;
  fehler(e);
});
export { toast };
