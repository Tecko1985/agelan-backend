import { api, token, tokenSetzen, istDemo } from "./api.js?v=2";
import { esc, el, $, $$, euro, zeitraum, newsDatum, datum, fehler, toast, AGELAN_APP, kopierenVerdrahten } from "./ui.js?v=2";

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
  zustand.ich = null;
  location.hash = "#/";
  neuLaden().then(route);
}

// ---------------------------------------------------------------------------
// Rahmen: Kopf, Bänder, Fuß
// ---------------------------------------------------------------------------
function rahmenZeichnen() {
  const d = zustand.daten;
  const s = d.einstellungen.seite;
  const baender = [];
  if (istDemo) {
    baender.push(`<div class="demo-band">🧪 Demo-Modus – alle Daten liegen nur in diesem Browser. Demo-Login: <b>Orga</b> / <b>demo1234</b> (Veranstalter)
      <button class="knopf klein geist" id="demo-reset">Demo zurücksetzen</button></div>`);
  }
  if (s.headerInfo) baender.push(`<div class="info-band">${esc(s.headerInfo)}</div>`);
  $("#baender").innerHTML = baender.join("");
  const reset = $("#demo-reset");
  if (reset) reset.onclick = async () => (await import("./demo.js?v=2")).demoZuruecksetzen();

  $$(".nur-orga").forEach((a) => a.classList.toggle("versteckt", !istOrga()));
  const rechts = $("#kopf-rechts");
  if (zustand.ich) {
    const t = zustand.ich.ticket;
    rechts.innerHTML = `<a class="knopf klein ${t ? "" : "primaer"}" href="${t ? "#/konto" : "#/tickets"}">${t ? "🎟️ <span class='knopf-text'>Mein Ticket</span>" : "Ticket kaufen"}</a>
      <a class="knopf klein geist" href="#/konto" title="Mein Konto">👤 <span class="knopf-text">${esc(zustand.ich.nutzer.nick)}</span></a>`;
  } else {
    rechts.innerHTML = `<a class="knopf klein geist" href="#/konto">Anmelden</a><a class="knopf klein primaer" href="#/tickets"><span>Ticket</span></a>`;
  }

  const so = s.socials || {};
  const socials = [["discord", "DC"], ["twitch", "TW"], ["youtube", "YT"], ["instagram", "IG"], ["facebook", "FB"]]
    .filter(([k]) => so[k]).map(([k, kurz]) => `<a href="${esc(so[k])}" target="_blank" rel="noopener" title="${k}">${kurz}</a>`).join("");
  $("#fuss").innerHTML = `
    <div><div class="marke" style="margin-bottom:8px"><img src="img/wappen.jpg" alt="" width="28" height="28"><span>AGE<b>-</b>LAN</span></div>
      <div>${esc(s.slogan)}</div><div class="klein leiser" style="margin-top:6px">© ${new Date().getFullYear()} AGE-LAN · Private Veranstaltung</div></div>
    <div class="zeile" style="gap:18px"><a href="#/faq">FAQ</a><a href="#/seite/anfahrt">Anfahrt</a><a href="#/seite/agb">Teilnahmebedingungen</a><a href="#/seite/datenschutz">Datenschutz</a><a href="#/seite/impressum">Impressum</a></div>
    <div class="socials">${socials}</div>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const SEITEN = {
  "": seiteStart,
  lan: seiteLan,
  faq: seiteFaq,
  news: seiteNews,
  gaeste: seiteGaeste,
  tickets: seiteTickets,
  seite: seiteText,
  sitzplan: async (m, p) => (await import("./sitzplan.js?v=2")).render(m, p),
  konto: async (m, p) => (await import("./konto.js?v=2")).render(m, p),
  t: async (m, p) => (await import("./konto.js?v=2")).renderTicketSeite(m, p),
  checkin: async (m, p) => (await import("./checkin.js?v=2")).render(m, p),
  admin: async (m, p) => (await import("./admin.js?v=2")).render(m, p),
};

let aufraeumen = null;
export function beimVerlassen(fn) { aufraeumen = fn; }

export async function route() {
  const [, name = "", param = ""] = (location.hash.replace(/^#/, "") || "/").split("/");
  const fn = SEITEN[name] || seiteStart;
  if (aufraeumen) { try { aufraeumen(); } catch (e) { /* egal */ } aufraeumen = null; }
  $$("#nav a").forEach((a) => a.classList.toggle("aktiv", a.dataset.route === name));
  $("#nav").classList.remove("offen");
  const main = $("#app");
  main.innerHTML = `<div class="lade">Lädt …</div>`;
  try {
    await fn(main, decodeURIComponent(param));
  } catch (e) {
    main.innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">⚠️ ${esc(e.message)}</div></div>`;
  }
  if (!location.hash.includes("#/admin")) window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Seiten
// ---------------------------------------------------------------------------
function belegungHtml(z) {
  const proz = z.sitzplaetze ? Math.round((z.sitzTickets / z.sitzplaetze) * 100) : 0;
  return `<div class="belegung"><div class="zeile"><span><b class="gold">${z.sitzFrei}</b> von ${z.sitzplaetze} PC-Plätzen frei</span><span class="leise">${proz} % vergeben</span></div>
    <div class="fortschritt"><i style="width:${proz}%"></i></div></div>`;
}

function newsKarte(n) {
  const d = newsDatum(n.datum);
  return `<a class="karte news-karte" href="#/news/${n.id}"><div class="news-datum"><span>${d.tag}. ${d.monat} ${d.jahr}</span></div>
    <h3>${esc(n.titel)}</h3><p>${esc(n.teaser)}</p><span class="klein gold">Weiterlesen →</span></a>`;
}

function ticketKarte(t, i) {
  const empf = i === 0 && t.verfuegbar;
  return `<div class="karte ticket-karte ${empf ? "empfohlen" : ""}">
    ${t.rest != null && t.rest > 0 && t.rest <= 20 ? `<div class="band">Nur noch ${t.rest}</div>` : ""}
    <span class="ueberzeile">${t.mitSitz ? "Mit PC-Platz" : "Ohne PC-Platz"}</span>
    <h3>${esc(t.name)}</h3>
    <div class="leise klein">${esc(t.beschreibung)}</div>
    <div class="preis">${euro(t.preisCent)}</div>
    ${t.extras.length ? `<div class="klein leise">Extras: ${t.extras.map((x) => esc(x.name) + " (+" + euro(x.preisCent) + ")").join(", ")}</div>` : ""}
    <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    ${t.bis ? `<div class="klein leise" style="margin-bottom:10px">Verfügbar bis ${datum(t.bis)}</div>` : ""}
    <button class="knopf ${t.verfuegbar ? "primaer" : ""} voll" data-kaufen="${t.id}" ${t.verfuegbar ? "" : "disabled"}>${t.verfuegbar ? "Ticket kaufen" : esc(t.grund)}</button>
  </div>`;
}

function ticketKnoepfeVerdrahten(root) {
  $$("[data-kaufen]", root).forEach((b) => (b.onclick = async () => {
    const konto = await import("./konto.js?v=2");
    konto.kaufen(Number(b.dataset.kaufen));
  }));
}

function countdownStarten(root, start) {
  const ziel = new Date(start + "T12:00:00").getTime();
  const box = $(".countdown", root);
  if (!box) return;
  const tick = () => {
    const rest = ziel - Date.now();
    if (rest <= 0) { box.innerHTML = `<div style="min-width:auto;padding:12px 18px"><b>⚔️ Die LAN läuft!</b></div>`; return; }
    const t = Math.floor(rest / 864e5), h = Math.floor(rest / 36e5) % 24, m = Math.floor(rest / 6e4) % 60, s = Math.floor(rest / 1e3) % 60;
    box.innerHTML = [[t, "Tage"], [h, "Std"], [m, "Min"], [s, "Sek"]].map(([w, l]) => `<div><b>${String(w).padStart(2, "0")}</b><span>${l}</span></div>`).join("");
  };
  tick();
  const iv = setInterval(tick, 1000);
  beimVerlassen(() => clearInterval(iv));
}

// Eingecheckt? Dann gehört die LAN-Zentrale ganz nach oben: Platz, Internet,
// und der direkte Weg in die AgeLan-App (Essen, Frühstück, Turniere, Stream).
const APP_KACHELN = [
  ["essen", "🍕", "Essen bestellen", "Speisekarte, Sonderwünsche, abholen"],
  ["fruehstueck", "🥐", "Frühstück", "Für morgen früh vorbestellen"],
  ["turnier", "🏆", "Turniere", "Eintragen, Spielplan, Ergebnisse"],
  ["stream", "📺", "Stream", "Sendeplan und Showmatches"],
  ["downloads", "💾", "Downloads", "Klickzähler und Map-Pack"],
];
function lanZentraleHtml(ich) {
  const t = ich && ich.ticket;
  if (!t || !t.checkinAt || t.status === "storniert") return "";
  const z = t.zugang || {};
  const feld = (label, wert) => wert ? `<div class="lz-feld"><span>${esc(label)}</span><b class="mono">${esc(wert)}</b><button class="knopf klein geist" data-kopieren="${esc(wert)}" title="Kopieren">⧉</button></div>` : "";
  return `<section class="lan-zentrale"><div class="wrap">
    <div class="lz-kopf">
      <div><span class="ueberzeile">⚔️ Du bist eingecheckt</span><h2>Willkommen auf der ${esc(t.lan.name)}, ${esc(ich.nutzer.nick)}!</h2></div>
      <div class="lz-sitz">${t.sitz ? `<span>Dein Platz</span><b>${esc(t.sitz)}</b>` : `<span>Ticket</span><b class="klein">${esc(t.typ.name)}</b>`}${t.gruppe ? `<em>👥 ${esc(t.gruppe)}</em>` : ""}</div>
    </div>
    <div class="lz-raster">
      <div class="lz-kacheln">${APP_KACHELN.map(([b, ico, titel, text]) => `<a class="app-kachel" href="${AGELAN_APP}?bereich=${b}" target="_blank" rel="noopener">
        <span class="ico">${ico}</span><b>${titel}</b><small>${text}</small></a>`).join("")}</div>
      <div class="lz-netz"><h3>🌐 Internet</h3>
        ${feld("WLAN", z.ssid)}${feld("WLAN-Passwort", z.wlanPasswort)}${feld("Benutzer", z.benutzer)}${feld("Passwort", z.passwort)}
        ${z.portal ? `<a class="knopf klein primaer" href="${esc(z.portal)}" target="_blank" rel="noopener" style="margin-top:10px">Zum Anmelde-Portal</a>` : ""}
        <p class="klein leise" style="margin:10px 0 0">In der App meldest du dich mit demselben Nickname und Passwort an wie hier.</p></div>
    </div></div></section>`;
}

async function seiteStart(main) {
  const d = await neuLaden();
  const { lan, zahlen: z, einstellungen: e } = d;
  main.innerHTML = lanZentraleHtml(zustand.ich) + `
  <section class="hero"><div class="wrap hero-innen">
    <div>
      <span class="ueberzeile">${esc(e.seite.slogan)}</span>
      <h1>${esc(lan.name)}</h1>
      <div class="chips">
        <span class="chip">📅 ${esc(zeitraum(lan.start, lan.ende))}</span>
        ${lan.ort ? `<span class="chip">📍 ${esc(lan.ort)}</span>` : ""}
        <span class="chip">🖥️ ${z.sitzplaetze} Plätze</span>
      </div>
      ${lan.start ? `<div class="countdown"></div>` : ""}
      <div class="zeile" style="margin-bottom:26px">
        <a class="knopf primaer gross" href="#/tickets">Ticket sichern</a>
        <a class="knopf gross" href="#/sitzplan">Sitzplan ansehen</a>
      </div>
      ${belegungHtml(z)}
    </div>
    <div class="hero-wappen"><div class="ring"></div><img src="img/wappen.jpg" alt="AGE-LAN Wappen"></div>
  </div></section>

  <section class="abschnitt"><div class="wrap">
    <div class="abschnitt-kopf"><div><span class="ueberzeile">Was dich erwartet</span><h2>Vier Tage Age of Empires</h2></div></div>
    <div class="raster raster-3">${e.highlights.map((h) => `<div class="karte highlight"><div class="ico">${esc(h.icon)}</div><div><h3>${esc(h.titel)}</h3><p>${esc(h.text)}</p></div></div>`).join("")}</div>
  </div></section>

  <section class="abschnitt"><div class="wrap">
    <div class="abschnitt-kopf"><div><span class="ueberzeile">Tickets</span><h2>Sei dabei</h2></div><a href="#/tickets">Alle Infos zu Tickets →</a></div>
    <div class="raster raster-3">${d.tickettypen.filter((t) => t.kaufbar).map(ticketKarte).join("") || `<div class="leer">Noch keine Tickets im Verkauf.</div>`}</div>
  </div></section>

  ${d.news.length ? `<section class="abschnitt"><div class="wrap">
    <div class="abschnitt-kopf"><div><span class="ueberzeile">Neuigkeiten</span><h2>Aus dem Lager</h2></div><a href="#/lan">Alle News →</a></div>
    <div class="raster raster-3">${d.news.slice(0, 3).map(newsKarte).join("")}</div>
  </div></section>` : ""}

  ${e.sponsoren.length ? `<section class="abschnitt"><div class="wrap">
    <div class="abschnitt-kopf"><div><span class="ueberzeile">Danke an</span><h2>Unsere Sponsoren</h2></div></div>
    <div class="sponsoren">${e.sponsoren.map((s) => `<a class="sponsor" ${s.url ? `href="${esc(s.url)}" target="_blank" rel="noopener"` : ""}>${s.logo ? `<img src="${esc(s.logo)}" alt="">` : ""}${esc(s.name)}</a>`).join("")}</div>
  </div></section>` : ""}

  ${e.seite.socials && e.seite.socials.discord ? `<section class="abschnitt"><div class="wrap"><div class="karte glanz zeile zwischen" style="padding:28px">
    <div><h2 style="margin:0">Komm auf unseren Discord</h2><p class="leise" style="margin:6px 0 0">Mitspieler finden, Gruppen bilden, Turniere besprechen.</p></div>
    <a class="knopf primaer gross" href="${esc(e.seite.socials.discord)}" target="_blank" rel="noopener">Discord beitreten</a></div></div></section>` : ""}`;
  ticketKnoepfeVerdrahten(main);
  kopierenVerdrahten(main);
  if (lan.start) countdownStarten(main, lan.start);
}

async function seiteTickets(main) {
  const d = await neuLaden();
  const z = d.zahlen;
  const za = d.einstellungen.zahlung;
  const arten = [za.arten.paypal && "PayPal (Freunde)", za.arten.ueberweisung && "Überweisung", za.arten.bar && "Bar"].filter(Boolean);
  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf"><span class="ueberzeile">${esc(d.lan.name)} · ${esc(zeitraum(d.lan.start, d.lan.ende))}</span><h1>Tickets</h1>
      <p>Konto anlegen, Ticket wählen, bezahlen, Platz aussuchen – fertig. Dein Ticket mit QR-Code findest du danach in deinem Konto.</p>
      ${belegungHtml(z)}</div>
    ${d.lan.verkaufOffen ? "" : `<div class="karte" style="margin:20px 0;border-color:var(--rot)">Der Ticketverkauf ist gerade geschlossen.</div>`}
    <div class="raster raster-3" style="margin-top:26px">${d.tickettypen.map(ticketKarte).join("") || `<div class="leer">Noch keine Tickets im Verkauf.</div>`}</div>
    <div class="raster raster-3" style="margin-top:36px">
      <div class="karte"><h3>💳 Bezahlen</h3><p class="leise">${esc(arten.join(", "))}. Nach dem Zahlungseingang bestätigt die Orga dein Ticket – dann ist dein Platz sicher.</p></div>
      <div class="karte"><h3>🪑 Platz wählen</h3><p class="leise">Mit Ticket suchst du dir deinen Platz im <a href="#/sitzplan">Sitzplan</a> aus. Mit Freunden? Gründet eine Reservierungsgruppe.</p></div>
      <div class="karte"><h3>📱 Einlass</h3><p class="leise">Beim Check-in scannen wir den QR-Code deines Tickets. Danach scannst du ihn selbst mit dem Handy und siehst deine Zugangsdaten fürs Internet.</p></div>
    </div></div>`;
  ticketKnoepfeVerdrahten(main);
}

async function seiteLan(main) {
  const d = await neuLaden();
  const { lan, einstellungen: e } = d;
  const maps = lan.adresse ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(lan.ort + ", " + lan.adresse) : "";
  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf"><span class="ueberzeile">Die LAN</span><h1>${esc(lan.name)}</h1><p class="news-text">${esc(lan.beschreibung)}</p></div>
    <div class="raster raster-2" style="margin-top:20px">
      <div class="karte"><h3>Eckdaten</h3><dl class="daten-liste">
        <dt>Wann</dt><dd>${esc(zeitraum(lan.start, lan.ende))}</dd>
        <dt>Wo</dt><dd>${esc(lan.ort)}${lan.adresse ? "<br>" + esc(lan.adresse) : ""}</dd>
        <dt>Plätze</dt><dd>${d.zahlen.sitzplaetze} PC-Plätze</dd>
        <dt>Gäste</dt><dd>${d.zahlen.gaeste} angemeldet</dd></dl>
        ${maps ? `<a class="knopf klein" style="margin-top:14px" href="${maps}" target="_blank" rel="noopener">📍 In Google Maps öffnen</a>` : ""}</div>
      <div class="karte"><h3>Anfahrt</h3><p class="leise news-text">${esc(e.texte.anfahrt || "Infos zur Anfahrt folgen.")}</p></div>
    </div>
    <div class="raster raster-3" style="margin-top:18px">${e.highlights.map((h) => `<div class="karte highlight"><div class="ico">${esc(h.icon)}</div><div><h3>${esc(h.titel)}</h3><p>${esc(h.text)}</p></div></div>`).join("")}</div>
    <div class="abschnitt-kopf" style="margin-top:46px"><h2>Neuigkeiten</h2></div>
    <div class="raster raster-3">${d.news.map(newsKarte).join("") || `<div class="leer">Noch keine News.</div>`}</div>
  </div>`;
}

async function seiteNews(main, id) {
  const { news } = await api("news", { id: Number(id) });
  const d = newsDatum(news.datum);
  main.innerHTML = `<div class="wrap" style="max-width:780px"><div class="seitenkopf">
    <a href="#/lan" class="klein">← Alle News</a>
    <div class="news-datum" style="margin-top:16px">${d.tag}. ${d.monat} ${d.jahr}</div><h1>${esc(news.titel)}</h1>
    <p class="leise" style="font-size:1.1rem">${esc(news.teaser)}</p></div>
    <div class="karte news-text">${esc(news.text)}</div></div>`;
}

async function seiteFaq(main) {
  const d = zustand.daten || await neuLaden();
  main.innerHTML = `<div class="wrap" style="max-width:860px"><div class="seitenkopf"><span class="ueberzeile">Gut zu wissen</span><h1>FAQ</h1></div>
    ${d.einstellungen.faq.map((f, i) => `<details class="faq" ${i === 0 ? "open" : ""}><summary>${esc(f.f)}</summary><div>${esc(f.a)}</div></details>`).join("")}</div>`;
}

const TEXTSEITEN = { anfahrt: "Anfahrt", impressum: "Impressum", datenschutz: "Datenschutz", agb: "Teilnahmebedingungen" };
async function seiteText(main, welche) {
  const d = zustand.daten || await neuLaden();
  const titel = TEXTSEITEN[welche] || "Seite";
  const inhalt = d.einstellungen.texte[welche] || "";
  main.innerHTML = `<div class="wrap" style="max-width:860px"><div class="seitenkopf"><h1>${esc(titel)}</h1></div>
    <div class="karte news-text">${esc(inhalt || "Dieser Text wird noch ergänzt.")}</div></div>`;
}

async function seiteGaeste(main) {
  const d = await api("gaeste");
  if (!d.oeffentlich) { main.innerHTML = `<div class="wrap"><div class="seitenkopf"><h1>Gäste</h1></div><div class="leer">Die Gästeliste ist nicht öffentlich.</div></div>`; return; }
  const z = d.zahlen;
  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf"><span class="ueberzeile">Wer ist dabei?</span><h1>Gäste <span class="leise">(${d.gaeste.length})</span></h1>${belegungHtml(z)}</div>
    <div class="zeile" style="margin:18px 0"><input id="g-suche" placeholder="Suchen nach Nick, Gruppe oder Platz …" style="max-width:360px"></div>
    <div class="tabelle-wrap"><table><thead><tr><th>#</th><th>Nickname</th><th>Gruppe</th><th>Ticket</th><th>Platz</th></tr></thead><tbody id="g-liste"></tbody></table></div></div>`;
  const zeichnen = () => {
    const q = $("#g-suche").value.trim().toLowerCase();
    const liste = d.gaeste.filter((g) => !q || [g.nick, g.gruppe, g.sitz].join(" ").toLowerCase().includes(q));
    $("#g-liste").innerHTML = liste.map((g, i) => `<tr><td class="leise">${i + 1}</td><td><b>${esc(g.nick)}</b></td><td>${g.gruppe ? `<span class="abzeichen blau">${esc(g.gruppe)}</span>` : ""}</td>
      <td class="leise">${esc(g.typ)}</td><td>${g.sitz ? `<a href="#/sitzplan/${encodeURIComponent(g.sitz)}" class="abzeichen gold">${esc(g.sitz)}</a>` : `<span class="leise">–</span>`}</td></tr>`).join("")
      || `<tr><td colspan="5" class="leise">Niemand gefunden.</td></tr>`;
  };
  $("#g-suche").oninput = zeichnen;
  zeichnen();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
$("#burger").onclick = () => $("#nav").classList.toggle("offen");
window.addEventListener("hashchange", route);
neuLaden().then(route).catch((e) => {
  $("#app").innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">⚠️ ${esc(e.message)}</div></div>`;
  fehler(e);
});
export { toast };
