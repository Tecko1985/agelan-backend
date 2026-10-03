// Verwaltung für die Orga (Rolle admin).
import { api, istDemo } from "./api.js?v=65";
import { zustand, neuLaden, istOrga, istAdmin } from "./app.js?v=65";
import { planSvg, planGroesse, tooltipAnbinden, legendeHtml, sitzInfo, U } from "./plan.js?v=65";
import { qrSvg, ticketLink, kopierenVerdrahten } from "./ui.js?v=65";
import { esc, $, $$, euro, zeit, datum, zeitraum, toast, fehler, modal, bestaetigen, formDaten, mitSperre, drucken, berlinIso, berlinDatum } from "./ui.js?v=65";

const REITER = [
  ["uebersicht", "Übersicht", false],
  ["gaeste", "Gäste & Zahlungen", false],
  ["gruppen", "Reservierungsgruppen", false],
  ["netz", "Internet & Geräte", false],
  ["-", "Einrichtung"],
  ["plan", "Sitzplan-Editor", true],
  ["tickettypen", "Ticketsorten", true],
  ["gutscheine", "Gutscheine", true],
  ["news", "Neuigkeiten", true],
  ["lans", "LANs", true],
  ["einstellungen", "Einstellungen", true],
  ["benutzer", "Benutzer", true],
  ["protokoll", "Protokoll", true],
];
const ZAHLARTEN = { paypal_direkt: "PayPal (direkt)", paypal: "PayPal (Freunde)", ueberweisung: "Überweisung", bar: "Bar" };
let reiter = "uebersicht";
let lanId = null;
let planModul = null; // Sitzplan-Editor, sobald einmal geladen

// Reiter-/LAN-Wechsel: bei ungespeichertem Sitzplan erst nachfragen.
const darfWechseln = async () => !planModul || planModul.verlassenErlaubt();

export async function render(main, param) {
  await neuLaden();
  if (!istOrga()) { main.innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">Nur für die Orga. <a href="#/konto">Anmelden</a></div></div>`; return; }
  if (param && REITER.some(([k]) => k === param)) reiter = param;
  const { lans } = await api("adminLans");
  if (!lanId || !lans.some((l) => l.id === lanId)) lanId = (lans.find((l) => l.aktiv) || lans[0]).id;
  main.innerHTML = `<div class="wrap admin-layout">
    <nav class="admin-nav">
      <div style="padding:0 6px 10px"><select id="a-lan" title="LAN">${lans.map((l) => `<option value="${l.id}" ${l.id === lanId ? "selected" : ""}>${esc(l.name)}${l.aktiv ? " (aktiv)" : ""}</option>`).join("")}</select></div>
      ${REITER.filter(([, , nurAdmin]) => !nurAdmin || istAdmin()).map(([k, l]) => (k === "-" ? (istAdmin() ? `<div class="trenner">${l}</div>` : "") : `<button data-r="${k}" class="${k === reiter ? "aktiv" : ""}">${l}</button>`)).join("")}
      <a class="knopf klein" style="margin:12px 6px 0" href="#/checkin">Check-in öffnen</a>
    </nav>
    <section id="a-inhalt"><div class="lade">Lädt …</div></section></div>`;
  const box = $("#a-inhalt", main);
  $("#a-lan", main).onchange = async (e) => {
    if (!(await darfWechseln())) { e.target.value = lanId; return; }
    lanId = Number(e.target.value);
    zeigen(box);
  };
  $$("[data-r]", main).forEach((b) => (b.onclick = async () => {
    if (!(await darfWechseln())) return;
    reiter = b.dataset.r;
    $$("[data-r]", main).forEach((x) => x.classList.toggle("aktiv", x === b));
    history.replaceState(null, "", "#/admin/" + reiter);
    reiterZeigen();
    zeigen(box);
  }));
  // Auf dem Handy ist die Leiste wischbar – den aktiven Reiter in Sicht holen.
  const reiterZeigen = () => { const b = $(".admin-nav .aktiv", main); if (b) b.scrollIntoView({ block: "nearest", inline: "center" }); };
  reiterZeigen();
  zeigen(box);
}

async function zeigen(box) {
  if (!box || !box.isConnected) return;
  if (planModul) planModul.schliessen();
  box.innerHTML = `<div class="lade">Lädt …</div>`;
  try {
    await ({ uebersicht, gaeste, gruppen, netz, plan, tickettypen, gutscheine, news, lans, einstellungen, benutzer, protokoll }[reiter] || uebersicht)(box);
  } catch (e) { box.innerHTML = `<div class="leer">${esc(e.message)}</div>`; }
}

const kopf = (titel, rechts = "") => `<div class="abschnitt-kopf"><h2>${titel}</h2><div class="zeile">${rechts}</div></div>`;

// ---------------------------------------------------------------------------
async function uebersicht(box) {
  const d = await api("adminTickets", { lanId });
  const aktiv = d.tickets.filter((t) => t.status !== "storniert");
  const bez = aktiv.filter((t) => t.status === "bezahlt");
  const offen = aktiv.filter((t) => t.status === "offen");
  const summe = (l) => l.reduce((s, t) => s + t.preisCent, 0);
  const proTyp = {};
  aktiv.forEach((t) => { proTyp[t.typ.name] = (proTyp[t.typ.name] || 0) + 1; });
  const proZahl = {};
  aktiv.forEach((t) => { proZahl[t.zahlartText] = (proZahl[t.zahlartText] || 0) + 1; });
  const max = Math.max(1, ...Object.values(proTyp));
  const z = d.zahlen;
  box.innerHTML = kopf(esc(d.lan.name), `<span class="leise">${esc(zeitraum(d.lan.start, d.lan.ende))}</span>`) + `
    <div class="raster raster-4">
      <div class="karte kennzahl"><b>${aktiv.length}</b><span>Gäste mit Ticket</span></div>
      <div class="karte kennzahl"><b>${bez.length}</b><span>bezahlt · ${euro(summe(bez))}</span></div>
      <div class="karte kennzahl"><b>${offen.length}</b><span>Zahlung offen · ${euro(summe(offen))}</span></div>
      <div class="karte kennzahl"><b>${aktiv.filter((t) => t.checkinAt).length}</b><span>eingecheckt</span></div>
      <div class="karte kennzahl"><b>${z.sitzFrei}</b><span>freie PC-Plätze von ${z.sitzplaetze}</span></div>
      <div class="karte kennzahl"><b>${aktiv.filter((t) => t.typ.mitSitz && !t.sitz).length}</b><span>mit Sitz-Ticket, aber ohne Platz</span></div>
    </div>
    <div class="raster raster-2" style="margin-top:18px">
      <div class="karte"><h3>Tickets nach Sorte</h3>${Object.entries(proTyp).map(([n, c]) => `<div class="balken"><span style="width:180px">${esc(n)}</span><div class="fortschritt"><i style="width:${(c / max) * 100}%"></i></div><b>${c}</b></div>`).join("") || `<p class="leise">Noch keine.</p>`}</div>
      <div class="karte"><h3>Zahlarten</h3>${Object.entries(proZahl).map(([n, c]) => `<div class="balken"><span style="width:120px">${esc(n)}</span><div class="fortschritt"><i style="width:${(c / Math.max(1, aktiv.length)) * 100}%"></i></div><b>${c}</b></div>`).join("") || `<p class="leise">Noch keine.</p>`}</div>
    </div>
    <div class="karte" style="margin-top:18px"><h3>Neueste Bestellungen</h3><div class="tabelle-wrap"><table><thead><tr><th>Wann</th><th>Gast</th><th>Ticket</th><th>Status</th><th class="zahl">Preis</th></tr></thead><tbody>
      ${d.tickets.slice(0, 10).map((t) => `<tr><td class="leise">${esc(zeit(t.createdAt))}</td><td><b>${esc(t.nutzer.nick)}</b></td><td>${esc(t.typ.name)}</td><td>${statusAbzeichen(t)}</td><td class="zahl">${euro(t.preisCent)}</td></tr>`).join("")}
    </tbody></table></div></div>`;
}

function statusAbzeichen(t) {
  if (t.status === "storniert") return `<span class="abzeichen rot">storniert</span>`;
  if (t.checkinAt) return `<span class="abzeichen gruen">✓ eingecheckt</span>`;
  return t.status === "bezahlt" ? `<span class="abzeichen gruen">bezahlt</span>` : `<span class="abzeichen gold">offen</span>`;
}

// ---------------------------------------------------------------------------
async function gaeste(box) {
  const d = await api("adminTickets", { lanId });
  const typen = [...new Set(d.tickets.map((t) => t.typ.name))];
  const gruppenNamen = [...new Set(d.tickets.map((t) => t.gruppe).filter(Boolean))].sort();
  box.innerHTML = kopf(`Gäste <span class="leise">(${d.tickets.filter((t) => t.status !== "storniert").length})</span>`, `<button class="knopf primaer klein" data-vorort>+ Gast vor Ort</button><button class="knopf klein" data-csv>CSV</button>`) + `
    <div class="filter">
      <input data-f="q" placeholder="Suche: Nick, Name, E-Mail, Platz">
      <select data-f="status"><option value="">Alle Status</option><option value="offen">Zahlung offen</option><option value="bezahlt">Bezahlt</option><option value="storniert">Storniert</option></select>
      <select data-f="zahlart"><option value="">Alle Zahlarten</option>${Object.entries(ZAHLARTEN).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <select data-f="typ"><option value="">Alle Tickets</option>${typen.map((t) => `<option>${esc(t)}</option>`).join("")}</select>
      <select data-f="checkin"><option value="">Check-in egal</option><option value="ja">Eingecheckt</option><option value="nein">Nicht eingecheckt</option></select>
      <select data-f="gruppe"><option value="">Alle Gruppen</option><option value="-">ohne Gruppe</option>${gruppenNamen.map((g) => `<option>${esc(g)}</option>`).join("")}</select>
    </div>
    <div class="tabelle-wrap"><table><thead><tr><th>Gast</th><th>Ticket</th><th>Status</th><th>Zahlart</th><th class="zahl">Preis</th><th>Gruppe</th><th>Platz</th><th>Check-in</th><th>OTP</th><th></th></tr></thead><tbody id="a-liste"></tbody></table></div>
    <p class="klein leise" id="a-summe" style="margin-top:8px"></p>`;
  const f = {};
  const liste = () => {
    $$("[data-f]", box).forEach((i) => (f[i.dataset.f] = i.value.trim().toLowerCase()));
    return d.tickets.filter((t) =>
      (!f.q || [t.nutzer.nick, t.nutzer.vorname, t.nutzer.nachname, t.nutzer.email, t.sitz].join(" ").toLowerCase().includes(f.q)) &&
      (f.status ? t.status === f.status : t.status !== "storniert") && (!f.zahlart || t.zahlart === f.zahlart) &&
      (!f.typ || t.typ.name.toLowerCase() === f.typ) && (!f.checkin || (f.checkin === "ja") === !!t.checkinAt) &&
      (!f.gruppe || (f.gruppe === "-" ? !t.gruppe : t.gruppe.toLowerCase() === f.gruppe)));
  };
  const zeichnen = () => {
    const l = liste();
    $("#a-liste", box).innerHTML = l.map((t) => `<tr>
      <td><b>${esc(t.nutzer.nick)}</b><div class="klein leise">${esc(t.nutzer.vorname)} ${esc(t.nutzer.nachname)}</div>${t.notiz ? `<div class="klein gold" title="${esc(t.notiz)}">${esc(t.notiz.slice(0, 40))}</div>` : ""}</td>
      <td class="klein">${esc(t.typ.name)}</td><td>${statusAbzeichen(t)}${t.bezahltAt ? `<div class="klein leise">${esc(zeit(t.bezahltAt))}</div>` : ""}</td>
      <td class="klein">${esc(t.zahlartText)}</td><td class="zahl">${euro(t.preisCent)}</td><td class="klein">${esc(t.gruppe)}</td>
      <td>${t.sitz ? `<span class="abzeichen gold">${esc(t.sitz)}</span>` : t.typ.mitSitz ? `<span class="leise">–</span>` : `<span class="leise klein">Gast</span>`}</td>
      <td class="klein">${t.checkinAt ? `✓ ${esc(zeit(t.checkinAt))}<div class="leise">${esc(t.checkinVon)}</div>` : ""}</td>
      <td class="mono">${esc(t.otp)}</td>
      <td style="white-space:nowrap">${t.status === "offen" ? `<button class="knopf klein gruen" data-bezahlt="${t.id}" title="Zahlung bestätigen">✓ Bezahlt</button>` : ""}
        <button class="knopf klein" data-details="${t.id}">Details</button></td></tr>`).join("") || `<tr><td colspan="10" class="leise">Keine Treffer.</td></tr>`;
    const bez = l.filter((t) => t.status === "bezahlt");
    $("#a-summe", box).textContent = `${l.length} angezeigt · ${bez.length} bezahlt (${euro(bez.reduce((s, t) => s + t.preisCent, 0))}) · offen ${euro(l.filter((t) => t.status === "offen").reduce((s, t) => s + t.preisCent, 0))}`;
    $$("[data-bezahlt]", box).forEach((b) => (b.onclick = () => mitSperre(b, async () => {
      const r = await api("adminBezahlt", { ticketId: Number(b.dataset.bezahlt), bezahlt: true });
      Object.assign(d.tickets.find((t) => t.id === r.ticket.id), r.ticket);
      toast("Zahlung von " + r.ticket.nutzer.nick + " bestätigt.", "ok");
      zeichnen();
    })));
    $$("[data-details]", box).forEach((b) => (b.onclick = () => mitSperre(b, () => ticketDetails(d.tickets.find((t) => t.id === Number(b.dataset.details)), (neu) => {
      if (neu) Object.assign(d.tickets.find((t) => t.id === neu.id), neu);
      zeichnen();
    }))));
  };
  $$("[data-f]", box).forEach((i) => (i.oninput = zeichnen));
  $("[data-vorort]", box).onclick = (e) => mitSperre(e.currentTarget, () => gastVorOrt(d.lan, (neu) => { d.tickets.unshift(neu); zeichnen(); }));
  $("[data-csv]", box).onclick = () => {
    const zeilen = [["Nick", "Vorname", "Nachname", "E-Mail", "Geburtsdatum", "Ticket", "Status", "Zahlart", "Preis", "Bezahlt am", "Gruppe", "Platz", "Check-in", "OTP", "Hinweis", "Orga-Notiz"]];
    liste().forEach((t) => zeilen.push([t.nutzer.nick, t.nutzer.vorname, t.nutzer.nachname, t.nutzer.email, t.nutzer.geburtsdatum, t.typ.name, t.status, t.zahlartText,
      (t.preisCent / 100).toFixed(2).replace(".", ","), zeit(t.bezahltAt), t.gruppe, t.sitz, zeit(t.checkinAt), t.otp, t.notiz, t.orgaNotiz]));
    const csv = "﻿" + zeilen.map((z) => z.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "gaeste.csv";
    a.click();
  };
  zeichnen();
}

async function ticketDetails(t, fertig) {
  const admin = istAdmin();
  const typen = admin ? (await api("adminTickettypen", { lanId: t.lanId })).tickettypen : [];
  const m = modal("Ticket von " + t.nutzer.nick, `<div class="stapel">
    <dl class="daten-liste">
      <dt>Name</dt><dd>${esc(t.nutzer.vorname)} ${esc(t.nutzer.nachname)} (${esc(t.nutzer.geburtsdatum)})</dd><dt>E-Mail</dt><dd>${esc(t.nutzer.email)}</dd>
      ${t.nutzer.discord ? `<dt>Discord</dt><dd>${esc(t.nutzer.discord)}</dd>` : ""}
      <dt>Ticket</dt><dd>${esc(t.typ.name)} · ${euro(t.preisCent)}${t.rabattCent ? ` (Rabatt ${euro(t.rabattCent)}, ${esc(t.couponCode)})` : ""}${t.extras.length ? " · " + t.extras.map((x) => esc(x.name)).join(", ") : ""}</dd>
      <dt>Status</dt><dd>${statusAbzeichen(t)} ${t.bezahltVon ? `<span class="klein leise">bestätigt von ${esc(t.bezahltVon)}</span>` : ""}</dd>
      <dt>Bestellt</dt><dd>${esc(zeit(t.createdAt))}</dd><dt>Gruppe</dt><dd>${esc(t.gruppe || "–")}</dd>
      ${t.notiz ? `<dt>Hinweis Gast</dt><dd>${esc(t.notiz)}</dd>` : ""}<dt>OTP</dt><dd class="mono">${esc(t.otp || "–")}</dd>
      <dt>Code</dt><dd class="mono klein">${esc(t.code)}</dd>
      <dt>Geräte</dt><dd id="a-geraete" class="klein leise">${t.checkinAt ? "Lädt …" : "–"}</dd></dl>
    <form class="formular" data-form>
      ${t.status !== "storniert" ? `<div class="zwei"><label class="feld"><span>Zahlung</span><select name="bezahlt"><option value="0" ${t.status === "offen" ? "selected" : ""}>offen</option><option value="1" ${t.status === "bezahlt" ? "selected" : ""}>bezahlt</option></select></label>
        <label class="feld"><span>Zahlart</span><select name="zahlart">${Object.entries(ZAHLARTEN).map(([k, l]) => `<option value="${k}" ${k === t.zahlart ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>` : ""}
      ${admin && t.status !== "storniert" ? `<div class="zwei"><label class="feld"><span>Ticketsorte</span><select name="typId">${typen.map((x) => `<option value="${x.id}" ${x.id === t.typ.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
        <label class="feld"><span>Platz</span><div class="zeile" style="gap:8px;flex-wrap:nowrap">
          <input name="sitz" value="${esc(t.sitz)}" readonly placeholder="kein Platz" style="cursor:pointer" data-sitzwahl title="Im Sitzplan wählen">
          <button type="button" class="knopf" data-sitzwahl>Sitzplan</button></div></label></div>
        <label class="feld"><span>Preis (€)</span><input name="preis" type="number" step="0.01" min="0" value="${(t.preisCent / 100).toFixed(2)}"></label>` : ""}
      <label class="feld"><span>Orga-Notiz</span><input name="orgaNotiz" value="${esc(t.orgaNotiz)}"></label>
      <div class="fehler-text"></div>
      <div class="zeile"><button class="knopf primaer">Speichern</button>
        <button type="button" class="knopf" data-ticket>Ticket anzeigen</button>
        ${admin ? `<button type="button" class="knopf" data-otp>OTP neu</button>` : ""}
        ${admin && t.checkinAt ? `<button type="button" class="knopf" data-checkout>Check-in zurücknehmen</button>` : ""}
        ${admin && t.status !== "storniert" ? `<button type="button" class="knopf rot" data-storno>Stornieren</button>` : ""}</div>
    </form></div>`, { breit: true });
  if (t.checkinAt) {
    api("adminNetz", { lanId: t.lanId, ticketId: t.id }).then((r) => {
      const ziel = $("#a-geraete", m.el);
      if (!ziel) return;
      const geraete = geraeteAus(r.eintraege.filter((e) => e.ok));
      const fehl = r.eintraege.filter((e) => !e.ok).length;
      ziel.classList.remove("leise");
      ziel.innerHTML = (geraete.length ? geraete.map((g) => `<div><span class="mono">${esc(g.mac || "ohne MAC")}</span> · ${esc(g.ip || "–")} <span class="leise">· zuletzt ${esc(zeit(g.at))}</span></div>`).join("")
        : `<span class="leise">${t.freigeschaltetAt ? "" : "Noch nicht am Portal angemeldet."}</span>`) + (fehl ? `<div class="rot">${fehl} Fehlversuch${fehl === 1 ? "" : "e"}</div>` : "");
    }).catch(() => { const ziel = $("#a-geraete", m.el); if (ziel) ziel.textContent = "–"; });
  }
  const f = $("[data-form]", m.el);
  $$("[data-sitzwahl]", f).forEach((x) => (x.onclick = (e) => { e.preventDefault(); mitSperre($("button[data-sitzwahl]", f), () => platzWaehlen(t, f.sitz)); }));
  const aktion = (knopf, fn) => mitSperre(knopf, async () => { const r = await fn(); if (r && r.ticket) { m.schliessen(); fertig(r.ticket); } });
  f.onsubmit = (e) => {
    e.preventDefault();
    mitSperre($("button", f), async () => {
      const v = formDaten(f);
      try {
        let neu = t;
        // Zahlungsstatus über adminBezahlt (setzt beim Bestätigen auch die Zahlart).
        if (v.bezahlt !== undefined && (v.bezahlt === "1") !== (t.status === "bezahlt")) neu = (await api("adminBezahlt", { ticketId: t.id, bezahlt: v.bezahlt === "1", zahlart: v.zahlart })).ticket;
        // Alles andere über adminTicketAendern – nur geänderte Felder. Notiz und Zahlart darf auch die Orga.
        const aend = { ticketId: t.id };
        if (v.orgaNotiz !== (t.orgaNotiz || "")) aend.orgaNotiz = v.orgaNotiz;
        if (v.zahlart !== undefined && v.zahlart !== neu.zahlart) aend.zahlart = v.zahlart;
        if (admin && t.status !== "storniert") {
          if (Number(v.typId) !== t.typ.id) aend.typId = Number(v.typId);
          // Leeres Preisfeld = Preis unverändert
          if (String(v.preis).trim() !== "") {
            const cent = Math.round(Number(v.preis) * 100);
            if (!Number.isFinite(cent) || cent < 0) throw new Error("Bitte einen gültigen Preis eingeben.");
            if (cent !== t.preisCent) aend.preisCent = cent;
          }
          const sitzAlt = t.sitz || "";
          if (v.sitz.trim() !== sitzAlt) {
            if (!v.sitz.trim()) aend.sitzId = "";
            else {
              const plan = await api("sitzplan", { lanId: t.lanId });
              const s = plan.sitze.find((x) => x.label.toLowerCase() === v.sitz.trim().toLowerCase());
              if (!s) throw new Error("Platz „" + v.sitz + "“ gibt es nicht.");
              aend.sitzId = s.id;
            }
          }
        }
        if (Object.keys(aend).length > 1) neu = (await api("adminTicketAendern", aend)).ticket;
        m.schliessen(); toast("Gespeichert.", "ok"); fertig(neu);
      } catch (err) { $(".fehler-text", f).textContent = err.message; }
    });
  };
  $("[data-ticket]", m.el).onclick = async () => {
    const { ticketHtml } = await import("./konto.js?v=65");
    const mm = modal("Ticket", `<div>${ticketHtml(t)}</div><div class="zeile" style="margin-top:14px"><button class="knopf primaer" data-d>Drucken</button></div>`, { breit: true });
    $("[data-d]", mm.el).onclick = () => drucken(`<div style="max-width:190mm;margin:0 auto">${ticketHtml(t)}</div>`);
  };
  const otp = $("[data-otp]", m.el); if (otp) otp.onclick = () => aktion(otp, () => api("adminTicketAendern", { ticketId: t.id, otpNeu: true }));
  const co = $("[data-checkout]", m.el); if (co) co.onclick = () => aktion(co, () => api("checkinZuruecknehmen", { ticketId: t.id }));
  const sto = $("[data-storno]", m.el);
  // Knopf vorher festhalten: nach dem await der Rückfrage ist e.currentTarget null.
  if (sto) sto.onclick = async () => {
    if (!(await bestaetigen(`Ticket von ${t.nutzer.nick} stornieren? Der Platz wird frei.`, { ja: "Stornieren", gefahr: true }))) return;
    aktion(sto, () => api("adminTicketAendern", { ticketId: t.id, status: "storniert" }));
  };
}

// ---------------------------------------------------------------------------
// Regeln für Reservierungsgruppen: Haltefrist, Verlängerung, Höchstdauer, Stichtag.
function gruppenRegelnHtml(e, lan) {
  const admin = istAdmin();
  const stich = Number(e.gruppeStichtagTage);
  const zahl = (name, wert, min, max, hinweis) => `<label class="feld"><span>${hinweis}</span><input name="${name}" type="number" min="${min}" max="${max}" value="${esc(String(wert))}" ${admin ? "" : "disabled"}></label>`;
  return `<form class="karte formular" data-regeln style="margin-bottom:18px"><div class="karte-kopf"><h3 style="margin:0">Regeln für Reservierungsgruppen</h3><span class="klein leise" id="g-vorschau"></span></div>
    <label class="check"><input type="checkbox" name="gruppenErlaubt" ${e.gruppenErlaubt !== false ? "checked" : ""} ${admin ? "" : "disabled"}> Gäste dürfen Gruppen gründen</label>
    <div class="zwei">${zahl("gruppeHalteTage", e.gruppeHalteTage, 1, 365, "Haltefrist einer neuen Gruppe (Tage)")}${zahl("gruppeMaxSitze", e.gruppeMaxSitze, 1, 200, "Max. Plätze je Gruppe")}</div>
    <label class="check"><input type="checkbox" name="gruppeVerlaengern" ${e.gruppeVerlaengern !== false ? "checked" : ""} ${admin ? "" : "disabled"}> Erneutes Vormerken verlängert die Haltefrist (wieder um die Haltefrist)</label>
    <div class="zwei">${zahl("gruppeMaxTage", e.gruppeMaxTage ?? 60, 0, 3650, "Höchstdauer ab Gründung (Tage, 0 = keine)")}
      ${zahl("gruppeStichtagTage", Number.isFinite(stich) && stich >= 0 ? stich : "", 0, 365, `Spätestens … Tage vor LAN-Beginn (leer = aus)${lan && lan.start ? "" : " – LAN hat noch keinen Termin"}`)}</div>
    <p class="klein leise" style="margin:0">Abgelaufene Gruppen geben ihre vorgemerkten Plätze frei; Mitglieder mit Ticket behalten ihren eigenen Platz. Die Orga kann einzelne Fristen unten per Datum ändern.</p>
    ${admin ? `<div class="zeile"><button class="knopf primaer">Regeln speichern</button><button type="button" class="knopf" data-fristen>Auf bestehende Gruppen anwenden</button></div>` : ""}</form>`;
}

async function gruppen(box) {
  const [{ gruppen: gs }, { lans: alleLans }] = await Promise.all([api("adminGruppen", { lanId }), api("adminLans")]);
  const lan = alleLans.find((l) => l.id === lanId);
  const e = zustand.daten.einstellungen;
  box.innerHTML = kopf(`Reservierungsgruppen <span class="leise">(${gs.length})</span>`) + gruppenRegelnHtml(e, lan) + (gs.length ? `<div class="raster raster-2">${gs.map((g) => `
    <div class="karte"><div class="karte-kopf"><div><h3 style="margin:0">${esc(g.name)}</h3><div class="klein leise">Leitung: ${esc(g.leitung)} · Code <span class="mono gold">${esc(g.code)}</span></div></div>
      <span class="abzeichen ${g.aktiv ? "blau" : "rot"}">${g.aktiv ? "Plätze " + g.fuellung : "abgelaufen"}</span></div>
      <div class="klein" style="margin-bottom:8px">${g.sitze.map((s) => `<span class="abzeichen ${s.besetzt ? "rot" : "blau"}">${esc(s.label)}</span>`).join(" ") || `<span class="leise">keine Plätze vorgemerkt</span>`}</div>
      <div class="klein leise" style="margin-bottom:10px">Mitglieder: ${g.mitglieder.map((m) => esc(m.nick) + (m.sitz ? " (" + esc(m.sitz) + ")" : "") + (m.ticket ? "" : " (ohne Ticket)")).join(", ")}</div>
      ${istAdmin() ? `<div class="zeile"><label class="klein leise">Hält bis <input type="date" data-ablauf="${g.id}" value="${berlinIso(g.ablauf)}" style="width:auto;padding:5px"></label>
        <button class="knopf klein" data-sitze="${g.id}">Plätze ändern</button><button class="knopf klein rot" data-loeschen="${g.id}">Auflösen</button></div>` : ""}
    </div>`).join("")}</div>` : `<div class="leer">Noch keine Gruppen.</div>`);
  const rf = $("[data-regeln]", box);
  // Vorschau: bis wann hält eine heute gegründete Gruppe?
  const vorschau = () => {
    const v = formDaten(rf), jetzt = Date.now();
    if (!v.gruppenErlaubt) { $("#g-vorschau", box).textContent = "Gäste können keine Gruppen gründen."; return; }
    let bis = jetzt + (Number(v.gruppeHalteTage) || 0) * 864e5;
    if (Number(v.gruppeMaxTage) > 0) bis = Math.min(bis, jetzt + Number(v.gruppeMaxTage) * 864e5);
    if (lan && lan.start && String(v.gruppeStichtagTage).trim() !== "") bis = Math.min(bis, Date.parse(lan.start + "T00:00:00") - Number(v.gruppeStichtagTage) * 864e5);
    $("#g-vorschau", box).textContent = bis <= jetzt ? "Stichtag vorbei: keine neuen Gruppen mehr." : "Neue Gruppe heute hält bis " + berlinDatum(bis - 1);
  };
  rf.oninput = vorschau;
  vorschau();
  if (istAdmin()) {
    rf.onsubmit = (ev) => { ev.preventDefault(); mitSperre($("button.primaer", rf), async () => {
      const v = formDaten(rf);
      const werte = [["gruppenErlaubt", v.gruppenErlaubt], ["gruppeHalteTage", Number(v.gruppeHalteTage)], ["gruppeMaxSitze", Number(v.gruppeMaxSitze)],
        ["gruppeVerlaengern", v.gruppeVerlaengern], ["gruppeMaxTage", Number(v.gruppeMaxTage) || 0], ["gruppeStichtagTage", String(v.gruppeStichtagTage).trim() === "" ? -1 : Number(v.gruppeStichtagTage)]];
      for (const [key, wert] of werte) await api("adminEinstellungSpeichern", { key, wert });
      await neuLaden();
      toast("Regeln gespeichert. Sie gelten für neue Gruppen und Verlängerungen.", "ok");
      gruppen(box);
    }); };
    $("[data-fristen]", rf).onclick = async (ev) => {
      const k = ev.currentTarget;
      if (!(await bestaetigen("Gespeicherte Regeln (Höchstdauer, Stichtag) auf alle Gruppen dieser LAN anwenden? Fristen werden dabei nur gekürzt, nie verlängert.", { ja: "Anwenden" }))) return;
      mitSperre(k, async () => { const r = await api("adminGruppenFristen", { lanId }); toast(r.gekuerzt ? `${r.gekuerzt} Gruppen gekürzt.` : "Keine Gruppe musste gekürzt werden.", "ok"); gruppen(box); });
    };
  }
  $$("[data-ablauf]", box).forEach((i) => (i.onchange = async () => {
    try { await api("adminGruppeAendern", { gruppeId: Number(i.dataset.ablauf), ablauf: i.value }); toast("Haltefrist geändert.", "ok"); gruppen(box); } catch (e) { fehler(e); }
  }));
  $$("[data-sitze]", box).forEach((b) => (b.onclick = () => {
    const g = gs.find((x) => x.id === Number(b.dataset.sitze));
    const m = modal("Plätze für " + g.name, `<form class="formular"><label class="feld"><span>Platznamen, mit Komma getrennt</span><textarea name="l">${esc(g.sitze.map((s) => s.label).join(", "))}</textarea></label>
      <div class="fehler-text"></div><button class="knopf primaer">Speichern</button></form>`);
    const f = $("form", m.el);
    f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
      const plan = await api("sitzplan", { lanId });
      const labels = f.l.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      const fehlt = labels.filter((l) => !plan.sitze.some((s) => s.label.toLowerCase() === l.toLowerCase()));
      if (fehlt.length) { $(".fehler-text", f).textContent = "Unbekannt: " + fehlt.join(", "); return; }
      await api("adminGruppeAendern", { gruppeId: g.id, sitzIds: labels.map((l) => plan.sitze.find((s) => s.label.toLowerCase() === l.toLowerCase()).id) });
      m.schliessen(); toast("Gespeichert.", "ok"); gruppen(box);
    }); };
  }));
  $$("[data-loeschen]", box).forEach((b) => (b.onclick = async () => {
    if (!(await bestaetigen("Gruppe auflösen? Die vorgemerkten Plätze werden frei, Tickets und Plätze der Mitglieder bleiben.", { ja: "Auflösen", gefahr: true }))) return;
    mitSperre(b, async () => { await api("adminGruppeAendern", { gruppeId: Number(b.dataset.loeschen), loeschen: true }); gruppen(box); });
  }));
}

// ---------------------------------------------------------------------------
// Geräte je MAC zusammenfassen (neueste Anmeldung gewinnt).
function geraeteAus(eintraege) {
  const je = new Map();
  for (const e of eintraege) if (!je.has(e.mac)) je.set(e.mac, e);
  return [...je.values()];
}

async function netz(box) {
  box.innerHTML = kopf("Internet & Geräte", `<button class="knopf klein" data-neu>Aktualisieren</button>`) + `
    <p class="klein leise" id="n-stand" style="margin-top:-6px"></p>
    <div class="karte" style="margin-bottom:14px"><h3>Code testen</h3>
      <p class="klein leise" style="margin:0 0 10px">Prüft wie das Portal, ob Nutzername und Code passen. Es wird nichts gespeichert.</p>
      <form class="zeile" data-test style="align-items:flex-end">
        <label class="feld" style="flex:1;min-width:140px"><span>Nutzername</span><input name="nutzer" autocomplete="off"></label>
        <label class="feld" style="flex:1;min-width:110px"><span>Code</span><input name="code" autocomplete="off" class="mono"></label>
        ${istDemo ? `<label class="feld" style="flex:1;min-width:160px"><span>MAC (nur Demo)</span><input name="mac" placeholder="aa:bb:cc:dd:ee:ff" class="mono"></label>` : ""}
        <button class="knopf">Testen</button>${istDemo ? `<button type="button" class="knopf" data-simulieren title="Wie ein echter Portal-Login, wird gespeichert">Anmeldung simulieren</button>` : ""}
      </form><div id="n-test" class="klein" style="margin-top:8px"></div></div>
    <div class="filter">
      <input data-q placeholder="Suche: MAC, IP, Nick oder Platz">
      <label class="check klein"><input type="checkbox" data-fehler> nur Fehlversuche</label>
    </div>
    <div class="tabelle-wrap"><table><thead><tr><th>Wann</th><th>Ergebnis</th><th>Gast</th><th>MAC</th><th>IP</th></tr></thead><tbody id="n-liste"><tr><td colspan="5" class="leise">Lädt …</td></tr></tbody></table></div>
    ${istAdmin() ? `<div class="zeile" style="margin-top:14px"><button class="knopf klein rot" data-leeren>Alle Einträge dieser LAN löschen</button></div>` : ""}`;
  let lauf = 0;
  const laden = async () => {
    const nr = ++lauf;
    const r = await api("adminNetz", { lanId, q: $("[data-q]", box).value.trim(), nurFehler: $("[data-fehler]", box).checked });
    if (nr !== lauf || !box.isConnected) return;
    $("#n-stand", box).innerHTML = (r.eingerichtet ? "" : `<span class="gold">Portal-Anbindung noch nicht eingerichtet (Secret PORTAL_SECRET fehlt). </span>`)
      + `${r.geraete} Geräte von ${r.tickets} Gästen angemeldet. Einträge verfallen automatisch (Einstellungen → Internet-Zugang).`;
    $("#n-liste", box).innerHTML = r.eintraege.map((e) => `<tr>
      <td class="klein leise" style="white-space:nowrap">${esc(zeit(e.at))}</td>
      <td>${e.ok ? `<span class="abzeichen gruen">ok</span>` : `<span class="abzeichen rot">${esc(e.grund || "abgelehnt")}</span>`}</td>
      <td>${e.nick ? `<b>${esc(e.nick)}</b>${e.platz ? ` <span class="abzeichen gold">${esc(e.platz)}</span>` : ""}` : `<span class="leise">${esc(e.nutzer || "–")}</span>`}</td>
      <td class="mono klein">${e.mac ? `<a href="#" data-mac="${esc(e.mac)}">${esc(e.mac)}</a>` : `<span class="leise">–</span>`}</td><td class="mono klein">${esc(e.ip || "–")}</td></tr>`).join("")
      || `<tr><td colspan="5" class="leise">Keine Einträge.</td></tr>`;
    $$("[data-mac]", box).forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); $("[data-q]", box).value = a.dataset.mac; laden().catch(fehler); }));
  };
  let warte = null;
  $("[data-q]", box).oninput = () => { clearTimeout(warte); warte = setTimeout(() => laden().catch(fehler), 300); };
  $("[data-fehler]", box).onchange = () => laden().catch(fehler);
  $("[data-neu]", box).onclick = (ev) => mitSperre(ev.currentTarget, laden);
  const tf = $("[data-test]", box);
  const ergebnis = (r) => {
    $("#n-test", box).innerHTML = r.ok ? `<span class="abzeichen gruen">würde freigeschaltet</span> ${esc(r.nick)}${r.platz ? " · Platz " + esc(r.platz) : ""}`
      : `<span class="abzeichen rot">abgelehnt</span> ${esc(r.grund || "")} <span class="leise">– Gast sieht: „${esc(r.meldung)}“</span>`;
  };
  tf.onsubmit = (ev) => { ev.preventDefault(); mitSperre($("button", tf), async () => ergebnis(await api("adminPortalTest", formDaten(tf)))); };
  const sim = $("[data-simulieren]", box);
  if (sim) sim.onclick = () => mitSperre(sim, async () => {
    const v = formDaten(tf);
    ergebnis(await api("portalAnmeldung", { ...v, ip: "10.95.41." + (2 + Math.floor(Math.random() * 250)), geheimnis: "demo-portal" }));
    await laden();
  });
  const leeren = $("[data-leeren]", box);
  if (leeren) leeren.onclick = async () => {
    if (!(await bestaetigen("Alle Geräte-Einträge dieser LAN löschen? Das geht nicht rückgängig.", { ja: "Löschen", gefahr: true }))) return;
    mitSperre(leeren, async () => { const r = await api("adminNetzLeeren", { lanId }); toast(r.geloescht + " Einträge gelöscht.", "ok"); await laden(); });
  };
  await laden();
}

// ---------------------------------------------------------------------------
async function plan(box) {
  box.innerHTML = kopf("Sitzplan-Editor") + `<div id="a-editor"></div>`;
  planModul = await import("./planeditor.js?v=65");
  await planModul.editor($("#a-editor", box), lanId);
}

// ---------------------------------------------------------------------------
async function tickettypen(box) {
  const [{ tickettypen: ts }, { lans: alleLans }] = await Promise.all([api("adminTickettypen", { lanId }), api("adminLans")]);
  const lan = alleLans.find((l) => l.id === lanId);
  box.innerHTML = kopf("Ticketsorten", `<button class="knopf primaer klein" data-neu>+ Neue Sorte</button>`) + `
    <div class="karte zeile zwischen" style="margin-bottom:14px;padding:14px 18px">
      <label class="check" style="font-size:1rem"><input type="checkbox" data-verkauf ${lan && lan.verkaufOffen ? "checked" : ""}> <b>Ticketverkauf offen</b></label>
      <span class="klein ${lan && lan.verkaufOffen ? "gruen" : "leise"}" data-verkauf-text>${lan && lan.verkaufOffen ? "Gäste können Tickets kaufen." : "Verkauf geschlossen – auf der Website ist nichts bestellbar."}</span></div>
    <div class="tabelle-wrap"><table><thead><tr><th>#</th><th>Name</th><th class="zahl">Preis</th><th>Sitz</th><th>Aktiv</th><th>Kaufbar</th><th class="zahl">Verkauft / Limit</th><th>Zeitraum</th><th></th></tr></thead><tbody>
    ${ts.map((t) => `<tr><td class="leise">${t.sort}</td><td><b>${esc(t.name)}</b>${t.extras.length ? `<div class="klein leise">+ ${t.extras.map((x) => esc(x.name)).join(", ")}</div>` : ""}</td><td class="zahl">${euro(t.preisCent)}</td>
      <td>${t.mitSitz ? "✓" : "–"}</td><td>${t.aktiv ? "✓" : "–"}</td><td>${t.kaufbar ? "✓" : "–"}</td><td class="zahl">${t.verkauft} / ${t.limit || "∞"}</td>
      <td class="klein">${t.von ? datum(t.von) : ""}${t.von || t.bis ? " – " : ""}${t.bis ? datum(t.bis) : ""}</td>
      <td style="white-space:nowrap"><button class="knopf klein" data-bearbeiten="${t.id}">Bearbeiten</button> <button class="knopf klein" data-kopieren-typ="${t.id}" title="Als neue Sorte übernehmen, z. B. für die nächste Preisstufe">Kopieren</button>${t.verkauft ? "" : ` <button class="knopf klein geist" data-loeschen="${t.id}">Löschen</button>`}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="klein leise" style="margin-top:8px">„Aktiv“ = auf der Website sichtbar, „Kaufbar“ = kann bestellt werden. Nicht kaufbare Sorten (z. B. Orga/Free) vergibst du unter Benutzer → Ticket anlegen.</p>`;
  const bearbeiten = (t = { sort: ts.length + 1, name: "", beschreibung: "", features: [], preisCent: 0, extras: [], mitSitz: true, aktiv: true, kaufbar: true, limit: 0, von: "", bis: "" }) => {
    const m = modal(t.id ? "Ticketsorte bearbeiten" : t.kopieVon ? "Ticketsorte kopieren" : "Neue Ticketsorte", `<form class="formular">
      ${t.kopieVon ? `<p class="klein leise" style="margin:0">Kopie von „${esc(t.kopieVon)}“. Wird erst mit „Speichern“ als neue Sorte angelegt – Preis und Zeitraum anpassen.</p>` : ""}
      <div class="zwei"><label class="feld"><span>Name</span><input name="name" value="${esc(t.name)}" required></label><label class="feld"><span>Sortierung</span><input name="sort" type="number" value="${t.sort}"></label></div>
      <label class="feld"><span>Beschreibung</span><input name="beschreibung" value="${esc(t.beschreibung)}"></label>
      <label class="feld"><span>Enthaltene Leistungen (eine pro Zeile)</span><textarea name="features">${esc(t.features.join("\n"))}</textarea></label>
      <div class="zwei"><label class="feld"><span>Preis (€)</span><input name="preis" type="number" step="0.01" min="0" value="${(t.preisCent / 100).toFixed(2)}"></label><label class="feld"><span>Limit (0 = keins)</span><input name="limit" type="number" min="0" value="${t.limit}"></label></div>
      <label class="feld"><span>Extras (eine pro Zeile: Name | Preis in €)</span><textarea name="extras" style="min-height:60px" placeholder="T-Shirt | 15">${esc(t.extras.map((x) => x.name + " | " + (x.preisCent / 100)).join("\n"))}</textarea></label>
      <div class="zwei"><label class="feld"><span>Verfügbar ab</span><input name="von" type="date" value="${esc(t.von)}"></label><label class="feld"><span>Verfügbar bis</span><input name="bis" type="date" value="${esc(t.bis)}"></label></div>
      <div class="zeile"><label class="check"><input type="checkbox" name="mitSitz" ${t.mitSitz ? "checked" : ""}> mit Sitzplatz</label><label class="check"><input type="checkbox" name="aktiv" ${t.aktiv ? "checked" : ""}> aktiv</label><label class="check"><input type="checkbox" name="kaufbar" ${t.kaufbar ? "checked" : ""}> kaufbar</label></div>
      <div class="fehler-text"></div><button class="knopf primaer">Speichern</button></form>`);
    const f = $("form", m.el);
    f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
      const v = formDaten(f);
      try {
        await api("adminTickettypSpeichern", { lanId, typ: {
          id: t.id, name: v.name, sort: Number(v.sort) || 0, beschreibung: v.beschreibung, features: v.features.split("\n").map((x) => x.trim()).filter(Boolean),
          preisCent: Math.round(Number(v.preis) * 100), limit: Number(v.limit) || 0, von: v.von, bis: v.bis, mitSitz: v.mitSitz, aktiv: v.aktiv, kaufbar: v.kaufbar,
          extras: v.extras.split("\n").map((z) => z.split("|")).filter((z) => z[0].trim()).map(([n, p]) => ({ name: n.trim(), preisCent: Math.round(Number(String(p || 0).replace(",", ".")) * 100) })),
        } });
        m.schliessen(); toast("Gespeichert.", "ok"); tickettypen(box);
      } catch (err) { $(".fehler-text", f).textContent = err.message; }
    }); };
  };
  $("[data-neu]", box).onclick = () => bearbeiten();
  $$("[data-bearbeiten]", box).forEach((b) => (b.onclick = () => bearbeiten(ts.find((t) => t.id === Number(b.dataset.bearbeiten)))));
  const vk = $("[data-verkauf]", box);
  vk.onchange = async () => {
    vk.disabled = true;
    try {
      await api("adminLanSpeichern", { lan: { ...lan, verkaufOffen: vk.checked } });
      lan.verkaufOffen = vk.checked;
      toast(vk.checked ? "Ticketverkauf ist offen." : "Ticketverkauf ist geschlossen.", "ok");
      const t = $("[data-verkauf-text]", box);
      t.className = "klein " + (vk.checked ? "gruen" : "leise");
      t.textContent = vk.checked ? "Gäste können Tickets kaufen." : "Verkauf geschlossen – auf der Website ist nichts bestellbar.";
    } catch (e) { vk.checked = !vk.checked; fehler(e); }
    vk.disabled = false;
  };
  // Kopie für die nächste Preisstufe: alles übernehmen, neue Sortierung, „ab“ = Tag nach dem bisherigen Ende.
  $$("[data-kopieren-typ]", box).forEach((b) => (b.onclick = () => {
    const q = ts.find((t) => t.id === Number(b.dataset.kopierenTyp));
    const naechsterTag = (iso) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
    bearbeiten({ ...q, id: undefined, kopieVon: q.name, sort: Math.max(0, ...ts.map((t) => t.sort)) + 1,
      features: [...q.features], extras: q.extras.map((x) => ({ ...x })), von: q.bis ? naechsterTag(q.bis) : q.von, bis: "" });
  }));
  $$("[data-loeschen]", box).forEach((b) => (b.onclick = async () => {
    if (!(await bestaetigen("Diese Ticketsorte löschen?", { ja: "Löschen", gefahr: true }))) return;
    mitSperre(b, async () => { await api("adminTickettypLoeschen", { lanId, id: Number(b.dataset.loeschen) }); tickettypen(box); });
  }));
}

// ---------------------------------------------------------------------------
async function gutscheine(box) {
  const { gutscheine: gs } = await api("adminGutscheine", { lanId });
  box.innerHTML = kopf("Gutscheine") + `
    <form class="karte zeile" style="margin-bottom:16px;align-items:end" data-neu>
      <label class="feld" style="flex:1;min-width:120px"><span>Code (leer = zufällig)</span><input name="code"></label>
      <label class="feld"><span>Art</span><select name="typ"><option value="betrag">Betrag (€)</option><option value="prozent">Prozent</option></select></label>
      <label class="feld" style="width:100px"><span>Wert</span><input name="wert" type="number" min="0.01" step="0.01" required></label>
      <label class="feld" style="flex:1;min-width:140px"><span>Bezeichnung</span><input name="name" placeholder="z. B. Helfer-Rabatt"></label>
      <label class="feld" style="width:100px"><span>Max. Nutzungen</span><input name="max" type="number" min="1" value="1"></label>
      <button class="knopf primaer">Anlegen</button></form>
    <div class="tabelle-wrap"><table><thead><tr><th>Code</th><th>Wert</th><th>Bezeichnung</th><th class="zahl">Eingelöst</th><th>Von</th><th></th></tr></thead><tbody>
    ${gs.map((g) => `<tr><td class="mono gold">${esc(g.code)}</td><td>${g.typ === "prozent" ? g.wert + " %" : euro(g.wert)}</td><td>${esc(g.name)}</td><td class="zahl">${g.eingeloest} / ${g.max}</td><td class="klein">${esc(g.nutzer)}</td>
      <td>${g.eingeloest ? "" : `<button class="knopf klein geist" data-loeschen="${g.id}">Löschen</button>`}</td></tr>`).join("") || `<tr><td colspan="6" class="leise">Noch keine Gutscheine.</td></tr>`}
    </tbody></table></div>`;
  const f = $("[data-neu]", box);
  // Betrag in Euro mit Cent, Prozent ganzzahlig 1–100
  f.typ.onchange = () => {
    const betrag = f.typ.value === "betrag";
    f.wert.step = betrag ? "0.01" : "1";
    f.wert.min = betrag ? "0.01" : "1";
    if (betrag) f.wert.removeAttribute("max"); else f.wert.max = "100";
  };
  f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
    const v = formDaten(f);
    await api("adminGutscheinSpeichern", { lanId, gutschein: { code: v.code, typ: v.typ, wert: v.typ === "betrag" ? Math.round(Number(v.wert) * 100) : Number(v.wert), name: v.name, max: Number(v.max) } });
    toast("Gutschein angelegt.", "ok"); gutscheine(box);
  }); };
  $$("[data-loeschen]", box).forEach((b) => (b.onclick = () => mitSperre(b, async () => { await api("adminGutscheinLoeschen", { lanId, id: Number(b.dataset.loeschen) }); gutscheine(box); })));
}

// ---------------------------------------------------------------------------
async function news(box) {
  const d = await api("oeffentlich");
  box.innerHTML = kopf("Neuigkeiten", `<button class="knopf primaer klein" data-neu>+ Neue Meldung</button>`) +
    `<div class="stapel">${d.news.map((n) => `<div class="karte zeile zwischen"><div><div class="klein gold">${esc(datum(n.datum))}</div><b>${esc(n.titel)}</b><div class="klein leise">${esc(n.teaser)}</div></div>
      <div class="zeile"><button class="knopf klein" data-bearbeiten="${n.id}">Bearbeiten</button><button class="knopf klein geist" data-loeschen="${n.id}">Löschen</button></div></div>`).join("") || `<div class="leer">Noch keine News.</div>`}</div>`;
  const bearbeiten = async (id) => {
    const n = id ? (await api("news", { id })).news : { titel: "", teaser: "", text: "", datum: berlinIso(Date.now()) };
    const m = modal(id ? "Meldung bearbeiten" : "Neue Meldung", `<form class="formular">
      <div class="zwei"><label class="feld"><span>Titel</span><input name="titel" value="${esc(n.titel)}" required></label><label class="feld"><span>Datum</span><input name="datum" type="date" value="${esc(n.datum)}"></label></div>
      <label class="feld"><span>Kurztext</span><input name="teaser" value="${esc(n.teaser)}"></label>
      <label class="feld"><span>Text</span><textarea name="text" style="min-height:220px">${esc(n.text)}</textarea></label>
      <div class="fehler-text"></div><button class="knopf primaer">Speichern</button></form>`, { breit: true });
    const f = $("form", m.el);
    f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
      try { await api("adminNewsSpeichern", { news: { id, ...formDaten(f) } }); m.schliessen(); toast("Gespeichert.", "ok"); news(box); } catch (err) { $(".fehler-text", f).textContent = err.message; }
    }); };
  };
  $("[data-neu]", box).onclick = () => bearbeiten(null);
  $$("[data-bearbeiten]", box).forEach((b) => (b.onclick = () => mitSperre(b, () => bearbeiten(Number(b.dataset.bearbeiten)))));
  $$("[data-loeschen]", box).forEach((b) => (b.onclick = async () => {
    if (!(await bestaetigen("Meldung löschen?", { ja: "Löschen", gefahr: true }))) return;
    mitSperre(b, async () => { await api("adminNewsLoeschen", { id: Number(b.dataset.loeschen) }); news(box); });
  }));
}

// ---------------------------------------------------------------------------
async function lans(box) {
  const [{ lans: ls }, { vorlagen }] = await Promise.all([api("adminLans"), api("adminVorlagen")]);
  const neuZeichnen = () => { const ansicht = box.closest(".ansicht"); if (ansicht) render(ansicht, "lans"); };
  box.innerHTML = kopf("LANs", `<button class="knopf primaer klein" data-neu>+ Neue LAN</button>`) + `
    <div class="tabelle-wrap"><table><thead><tr><th>Name</th><th>Zeitraum</th><th>Verkauf</th><th class="zahl">Limit</th><th class="zahl">Gäste</th><th></th></tr></thead><tbody>
    ${ls.map((l) => `<tr><td><b>${esc(l.name)}</b> ${l.aktiv ? `<span class="abzeichen gold">aktiv</span>` : ""}</td><td>${esc(zeitraum(l.start, l.ende))}</td><td>${l.verkaufOffen ? "offen" : "zu"}</td>
      <td class="zahl">${l.gaesteLimit}</td><td class="zahl">${l.zahlen.gaeste} (${l.zahlen.bezahlt} bez.)</td>
      <td style="white-space:nowrap"><button class="knopf klein" data-stufen="${l.id}">Stages</button> <button class="knopf klein" data-sitze="${l.id}">Plätze sperren</button> <button class="knopf klein" data-bearbeiten="${l.id}">Bearbeiten</button>${l.aktiv ? "" : ` <button class="knopf klein rot" data-lloeschen="${l.id}" title="LAN löschen">Löschen</button>`}</td></tr>`).join("")}
    </tbody></table></div><p class="klein leise" style="margin-top:8px">Die aktive LAN ist die, die auf der Website erscheint. Eine neue LAN übernimmt die Ticketsorten der aktiven; den Sitzplan wählst du beim Anlegen (wie die aktive LAN, aus einer Vorlage oder leer).</p>
    <div class="karte" style="margin-top:18px"><h3>Sitzplan-Vorlagen</h3>
      <p class="klein leise" style="margin:0 0 10px">Eine Vorlage speichert Fläche, Beschriftungen und alle Plätze samt Sperren. Speichern: im LAN-Fenster unter „Sitzplan“.</p>
      ${vorlagen.length ? `<div class="tabelle-wrap"><table><thead><tr><th>Name</th><th class="zahl">Plätze</th><th class="zahl">gesperrt</th><th>Gespeichert</th><th></th></tr></thead><tbody>
        ${vorlagen.map((v) => `<tr><td><b>${esc(v.name)}</b></td><td class="zahl">${v.sitze}</td><td class="zahl">${v.gesperrt}</td><td class="klein leise">${esc(zeit(v.erstellt))}</td>
          <td><button class="knopf klein rot" data-vloeschen="${v.id}">Vorlage löschen</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="leise klein">Noch keine Vorlagen.</div>`}</div>`;

  const vorlagenOptionen = vorlagen.map((v) => `<option value="${v.id}">${esc(v.name)} (${v.sitze} Plätze)</option>`).join("");
  const bearbeiten = (l = { name: "", start: "", ende: "", gaesteLimit: 120, verkaufOffen: false, ort: "", adresse: "", beschreibung: "", aktiv: false }) => {
    const aktiveLan = ls.find((x) => x.aktiv);
    const m = modal(l.id ? "LAN bearbeiten" : "Neue LAN", `<form class="formular">
      <label class="feld"><span>Name</span><input name="name" value="${esc(l.name)}" required></label>
      <div class="zwei"><label class="feld"><span>Start</span><input name="start" type="date" value="${esc(l.start)}"></label><label class="feld"><span>Ende</span><input name="ende" type="date" value="${esc(l.ende)}"></label></div>
      <div class="zwei"><label class="feld"><span>Ort</span><input name="ort" value="${esc(l.ort)}"></label><label class="feld"><span>Adresse</span><input name="adresse" value="${esc(l.adresse)}"></label></div>
      <label class="feld"><span>Gäste-Limit (PC-Plätze)</span><input name="gaesteLimit" type="number" min="0" value="${l.gaesteLimit}"></label>
      <label class="feld"><span>Beschreibung</span><textarea name="beschreibung">${esc(l.beschreibung)}</textarea></label>
      ${l.id ? "" : `<label class="feld"><span>Sitzplan</span><select name="planVorlage">
        <option value="aktiv">wie die aktive LAN${aktiveLan ? ` (${esc(aktiveLan.name)})` : ""}</option>
        ${vorlagen.length ? `<optgroup label="Vorlagen">${vorlagenOptionen}</optgroup>` : ""}
        <option value="leer">leerer Plan</option></select></label>`}
      <div class="zeile"><label class="check"><input type="checkbox" name="verkaufOffen" ${l.verkaufOffen ? "checked" : ""}> Ticketverkauf offen</label><label class="check"><input type="checkbox" name="aktiv" ${l.aktiv ? "checked" : ""}> Aktive LAN (auf der Website)</label></div>
      <div class="fehler-text"></div><button class="knopf primaer">Speichern</button></form>
      ${l.id ? `<div class="karte" style="margin-top:18px"><h3>Sitzplan</h3>
        <div class="zeile"><button type="button" class="knopf" data-l-stufen>Stages</button><button type="button" class="knopf" data-l-sitze>Plätze sperren</button><button type="button" class="knopf" data-l-editor>Im Sitzplan-Editor öffnen</button></div>
        <div class="zeile" style="margin-top:12px;align-items:flex-end">
          <label class="feld" style="flex:1;min-width:180px;margin:0"><span>Als Vorlage speichern</span><input data-v-name placeholder="Name, z. B. Nordhessenhalle 120"></label>
          <button type="button" class="knopf" data-v-speichern>Speichern</button></div>
        ${vorlagen.length ? `<div class="zeile" style="margin-top:12px;align-items:flex-end">
          <label class="feld" style="flex:1;min-width:180px;margin:0"><span>Vorlage anwenden (ersetzt den Plan)</span><select data-v-wahl>${vorlagenOptionen}</select></label>
          <button type="button" class="knopf" data-v-anwenden>Anwenden</button></div>` : ""}</div>` : ""}`);
    const f = $("form", m.el);
    f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
      try { const v = formDaten(f); await api("adminLanSpeichern", { lan: { ...v, id: l.id, gaesteLimit: Number(v.gaesteLimit) } }); m.schliessen(); toast("Gespeichert.", "ok"); neuZeichnen(); } catch (err) { $(".fehler-text", f).textContent = err.message; }
    }); };
    if (!l.id) return;
    $("[data-l-sitze]", m.el).onclick = () => sitzStatusBearbeiten(l);
    $("[data-l-stufen]", m.el).onclick = () => { m.schliessen(); stufenBearbeiten(l, neuZeichnen); };
    $("[data-l-editor]", m.el).onclick = async () => {
      if (!(await darfWechseln())) return;
      m.schliessen(); lanId = l.id; reiter = "plan";
      history.replaceState(null, "", "#/admin/plan");
      const ansicht = box.closest(".ansicht"); if (ansicht) render(ansicht, "plan");
    };
    const vs = $("[data-v-speichern]", m.el);
    vs.onclick = () => mitSperre(vs, async () => {
      const name = $("[data-v-name]", m.el).value.trim();
      if (!name) { toast("Bitte einen Namen für die Vorlage eingeben."); return; }
      if (vorlagen.some((v) => v.name.toLowerCase() === name.toLowerCase())
        && !(await bestaetigen(`Die Vorlage „${name}“ gibt es schon. Überschreiben?`, { ja: "Überschreiben" }))) return;
      await api("adminVorlageSpeichern", { lanId: l.id, name });
      toast("Vorlage „" + name + "“ gespeichert.", "ok");
      m.schliessen(); neuZeichnen();
    });
    const va = $("[data-v-anwenden]", m.el);
    if (va) va.onclick = async () => {
      const wahl = $("[data-v-wahl]", m.el);
      const v = vorlagen.find((x) => x.id === Number(wahl.value));
      if (!(await bestaetigen(`Plan von „${l.name}“ durch die Vorlage „${v.name}“ ersetzen? Gruppen-Vormerkungen dieser LAN gehen dabei verloren.`, { ja: "Ersetzen", gefahr: true }))) return;
      mitSperre(va, async () => { await api("adminVorlageAnwenden", { lanId: l.id, vorlageId: v.id }); toast("Vorlage angewendet.", "ok"); m.schliessen(); neuZeichnen(); });
    };
  };
  $("[data-neu]", box).onclick = () => bearbeiten();
  $$("[data-bearbeiten]", box).forEach((b) => (b.onclick = () => bearbeiten(ls.find((l) => l.id === Number(b.dataset.bearbeiten)))));
  $$("[data-sitze]", box).forEach((b) => (b.onclick = () => sitzStatusBearbeiten(ls.find((l) => l.id === Number(b.dataset.sitze)))));
  $$("[data-stufen]", box).forEach((b) => (b.onclick = () => mitSperre(b, () => stufenBearbeiten(ls.find((l) => l.id === Number(b.dataset.stufen)), neuZeichnen))));
  $$("[data-lloeschen]", box).forEach((b) => (b.onclick = async () => {
    const l = ls.find((x) => x.id === Number(b.dataset.lloeschen));
    if (!(await bestaetigen(`LAN „${l.name}“ endgültig löschen? Sitzplan, Ticketsorten, Gutscheine und Gruppen dieser LAN werden mit gelöscht.`, { ja: "Endgültig löschen", gefahr: true }))) return;
    mitSperre(b, async () => {
      await api("adminLanLoeschen", { lanId: l.id });
      if (lanId === l.id) lanId = null;
      toast("LAN „" + l.name + "“ gelöscht.", "ok");
      neuZeichnen();
    });
  }));
  $$("[data-vloeschen]", box).forEach((b) => (b.onclick = async () => {
    const v = vorlagen.find((x) => x.id === Number(b.dataset.vloeschen));
    if (!(await bestaetigen(`Vorlage „${v.name}“ löschen? LANs, die sie benutzt haben, bleiben unverändert.`, { ja: "Löschen", gefahr: true }))) return;
    mitSperre(b, async () => { await api("adminVorlageLoeschen", { vorlageId: v.id }); toast("Vorlage gelöscht.", "ok"); neuZeichnen(); });
  }));
}

// Ausbaustufen-Konfigurator: Jeder Platz bekommt eine Stufe (1 = von Anfang an buchbar).
// Bis zur aktiven Stufe sind Plätze buchbar; mit Automatik öffnet die nächste Stufe,
// sobald die aktive ausverkauft ist. Zuordnen per Klick, Ziehen oder ganze Reihe.
async function stufenBearbeiten(l, fertig) {
  const daten = await api("sitzplan", { lanId: l.id });
  const stufe = new Map(daten.sitze.map((s) => [s.id, s.stufe || 1]));
  const vorher = new Map(stufe);
  let aktiv = daten.lan.stufeAktiv || 1, auto = daten.lan.stufeAuto !== false;
  const reihe = (s) => (s.label.match(/^[^\d]+/) || [s.label])[0];
  let werkzeug = 1;
  const maxStufe = () => Math.max(1, ...stufe.values());
  const m = modal("Stages: " + l.name, `<div class="stapel">
    <p class="klein leise" style="margin:0">Jeder Platz gehört zu einer Stage. Stage 1 ist von Anfang an buchbar, weitere Stages kommen dazu, wenn mehr Gäste kommen. Gäste sehen noch nicht freigeschaltete Plätze gestrichelt mit „folgt in Stage …“.</p>
    <div class="zeile" style="gap:6px;align-items:center"><span class="klein leise">Plätzen zuordnen:</span><span data-werkzeuge class="zeile" style="gap:6px"></span>
      <label class="check klein" style="margin-left:6px"><input type="checkbox" data-reihe> ganze Reihe</label>
      <span style="flex:1"></span><button class="knopf klein" data-z="-1" title="Verkleinern">−</button><button class="knopf klein" data-z="1" title="Vergrößern">+</button></div>
    <div class="plan-buehne stufen-plan" id="sb-buehne" style="max-height:52vh;max-height:52dvh"></div>
    <div class="karte" style="margin:0;padding:12px 16px"><div id="sb-uebersicht" class="klein"></div></div>
    <div class="zeile" style="align-items:center">
      <label class="klein">Aktiv bis Stage <select data-aktiv style="width:auto;margin-left:6px"></select></label>
      <label class="check klein"><input type="checkbox" data-auto ${auto ? "checked" : ""}> Automatisch die nächste Stage freischalten, wenn die aktive ausverkauft ist</label></div>
    <div class="zeile"><button class="knopf primaer" data-ok>Speichern</button><button class="knopf geist" data-ab>Abbrechen</button><span class="klein leise" id="sb-aend"></span></div></div>`, { breit: true });
  const buehne = $("#sb-buehne", m.el);
  let zoom = Math.min(1.4, Math.max(0.45, (buehne.clientWidth - 30) / (planGroesse(daten.plan, daten.sitze).breite * U + 12)));
  const klasse = (s) => `sitz s-frei st-${stufe.get(s.id)}${stufe.get(s.id) > aktiv ? " inaktiv" : ""}`;
  const stand = () => {
    const ms = Math.max(maxStufe(), aktiv);
    // Werkzeug-Knöpfe: vorhandene Stufen + eine neue
    $("[data-werkzeuge]", m.el).innerHTML = Array.from({ length: Math.min(9, ms + 1) }, (_, i) => i + 1)
      .map((n) => `<button class="knopf klein stufe-knopf st-${n} ${n === werkzeug ? "primaer" : ""}" data-w="${n}">${n > maxStufe() ? "+ Stage " + n : "Stage " + n}</button>`).join("");
    $$("[data-w]", m.el).forEach((b) => (b.onclick = () => { werkzeug = Number(b.dataset.w); stand(); }));
    const frei = daten.sitze.filter((s) => !s.gesperrt);
    let summe = 0;
    $("#sb-uebersicht", m.el).innerHTML = Array.from({ length: maxStufe() }, (_, i) => i + 1).map((n) => {
      const neu = frei.filter((s) => stufe.get(s.id) === n).length;
      summe += neu;
      return `<div class="zeile zwischen" style="padding:4px 0"><span><span class="stufe-knopf st-${n}" style="border:1px solid var(--rand);padding:0 8px;border-radius:3px">Stage ${n}</span> +${neu} Plätze</span>
        <span>${n <= aktiv ? '<b class="gruen">freigeschaltet</b>' : '<span class="leise">noch zu</span>'} · zusammen <b>${summe}</b></span></div>`;
    }).join("") + (daten.sitze.length > frei.length ? `<div class="leise" style="margin-top:4px">${daten.sitze.length - frei.length} gesperrte Plätze zählen in keiner Stage.</div>` : "")
      + `<div class="leise" style="margin-top:4px">Verkaufte Sitzplatz-Tickets zählen gegen die freigeschalteten Plätze; das Gäste-Limit der LAN (${l.gaesteLimit}) begrenzt zusätzlich.</div>`;
    const sel = $("[data-aktiv]", m.el);
    sel.innerHTML = Array.from({ length: maxStufe() }, (_, i) => `<option value="${i + 1}" ${i + 1 === aktiv ? "selected" : ""}>Stage ${i + 1}</option>`).join("");
    const n = [...stufe].filter(([id, v]) => vorher.get(id) !== v).length;
    $("#sb-aend", m.el).textContent = n ? `${n} Plätze geändert – noch nicht gespeichert` : "";
  };
  const zeichnen = () => {
    buehne.innerHTML = planSvg(daten.plan, daten.sitze.map((s) => ({ ...s, meins: false, meineGruppe: false })), { zoom, klassen: (s, istDeko) => (istDeko ? "" : `st-${stufe.get(s.id)}${stufe.get(s.id) > aktiv ? " inaktiv" : ""}`) });
    stand();
  };
  const setzen = (s) => {
    const ziele = $("[data-reihe]", m.el).checked ? daten.sitze.filter((x) => reihe(x) === reihe(s)) : [s];
    for (const x of ziele) {
      stufe.set(x.id, werkzeug);
      const g = buehne.querySelector(`[data-sitz="${CSS.escape(x.id)}"]`);
      if (g) g.setAttribute("class", klasse(x));
    }
    stand();
  };
  const sitzAus = (e) => { const g = e.target.closest && e.target.closest("[data-sitz]"); return g ? daten.sitze.find((x) => x.id === g.dataset.sitz) : null; };
  let malen = false, maus = false;
  buehne.addEventListener("pointerdown", (e) => { maus = e.pointerType === "mouse"; if (!maus) return; const s = sitzAus(e); if (!s) return; e.preventDefault(); malen = true; setzen(s); });
  buehne.addEventListener("pointerover", (e) => { if (!malen) return; const s = sitzAus(e); if (s && stufe.get(s.id) !== werkzeug) setzen(s); });
  buehne.addEventListener("click", (e) => { if (maus) return; const s = sitzAus(e); if (s) setzen(s); });
  const loslassen = () => { malen = false; };
  window.addEventListener("pointerup", loslassen);
  const abbauen = new MutationObserver(() => { if (!buehne.isConnected) { window.removeEventListener("pointerup", loslassen); abbauen.disconnect(); } });
  abbauen.observe(document.body, { childList: true });
  $("[data-aktiv]", m.el).onchange = (e) => { aktiv = Number(e.target.value); zeichnen(); };
  $("[data-auto]", m.el).onchange = (e) => { auto = e.target.checked; };
  $$("[data-z]", m.el).forEach((b) => (b.onclick = () => { zoom = Math.min(2.5, Math.max(0.4, zoom + Number(b.dataset.z) * 0.2)); zeichnen(); }));
  $("[data-ab]", m.el).onclick = () => m.schliessen();
  const ok = $("[data-ok]", m.el);
  ok.onclick = () => mitSperre(ok, async () => {
    const sitze = [...stufe].filter(([id, v]) => vorher.get(id) !== v).map(([id, v]) => ({ id, stufe: v }));
    const r = await api("adminStufenSpeichern", { lanId: l.id, sitze, aktiv: Math.min(aktiv, maxStufe()), auto });
    toast(r.stufeAktiv > aktiv ? `Gespeichert – automatisch auf Stage ${r.stufeAktiv} geschaltet, weil Stage ${aktiv} schon voll ist.` : "Stages gespeichert.", "ok");
    m.schliessen();
    if (fertig) fertig();
  });
  zeichnen();
}

// Plätze einer LAN sperren oder freigeben. Werkzeug wählen, dann
// Plätze anklicken (mit der Maus auch über mehrere ziehen) oder ganze Reihen.
async function sitzStatusBearbeiten(l) {
  const daten = await api("sitzplan", { lanId: l.id });
  const merkmal = new Map(daten.sitze.map((s) => [s.id, s.gesperrt || s.status === "gesperrt" ? "gesperrt" : "frei"]));
  const vorher = new Map(merkmal);
  const vergeben = (s) => s.status === "belegt";
  const reihe = (s) => (s.label.match(/^[^\d]+/) || [s.label])[0];
  let werkzeug = "gesperrt";
  const m = modal("Plätze: " + l.name, `<div class="stapel">
    <div class="zeile" style="gap:6px">
      <button class="knopf klein" data-w="gesperrt">Sperren</button><button class="knopf klein" data-w="frei">Freigeben</button>
      <label class="check klein" style="margin-left:6px"><input type="checkbox" data-reihe> ganze Reihe</label>
      <span style="flex:1"></span><button class="knopf klein" data-z="-1" title="Verkleinern">−</button><button class="knopf klein" data-z="1" title="Vergrößern">+</button></div>
    <div class="klein" id="ss-info"></div>
    <div class="plan-buehne" id="ss-buehne" style="max-height:60vh;max-height:60dvh"></div>
    <p class="klein leise" style="margin:0">Gesperrte Plätze kann kein Gast buchen und sie zählen nicht als freie Plätze. Im Ticket-Dialog kann die Orga sie trotzdem vergeben (z. B. für Orga-Mitglieder). Plätze, auf denen schon ein Gast sitzt, behalten ihren Gast.</p>
    <div class="zeile"><button class="knopf primaer" data-ok>Speichern</button><button class="knopf geist" data-ab>Abbrechen</button><span class="klein leise" id="ss-aend"></span></div></div>`, { breit: true });
  const buehne = $("#ss-buehne", m.el);
  let zoom = Math.min(1.4, Math.max(0.45, (buehne.clientWidth - 30) / (daten.plan.breite * U + 12)));
  const anzeige = (s) => (vergeben(s) ? s.status : merkmal.get(s.id));
  const klasse = (s) => `sitz s-${anzeige(s)}${vergeben(s) && merkmal.get(s.id) !== "frei" ? " markiert" : ""}`;
  const stand = () => {
    const z = { gesperrt: 0 };
    for (const v of merkmal.values()) if (z[v] !== undefined) z[v]++;
    $("#ss-info", m.el).innerHTML = `${daten.sitze.length} Plätze · <b>${z.gesperrt}</b> gesperrt · ${daten.sitze.length - z.gesperrt} buchbar`;
    const n = [...merkmal].filter(([id, v]) => vorher.get(id) !== v).length;
    $("#ss-aend", m.el).textContent = n ? `${n} Änderung${n === 1 ? "" : "en"} nicht gespeichert` : "";
    $$("[data-w]", m.el).forEach((b) => b.classList.toggle("primaer", b.dataset.w === werkzeug));
  };
  const zeichnen = () => {
    buehne.innerHTML = planSvg(daten.plan, daten.sitze.map((s) => ({ ...s, status: anzeige(s), meins: false, meineGruppe: false })),
      { zoom, klassen: (s, istDeko) => (!istDeko && vergeben(s) && merkmal.get(s.id) !== "frei" ? "markiert" : "") });
    stand();
  };
  const setzen = (s) => {
    const ziele = $("[data-reihe]", m.el).checked ? daten.sitze.filter((x) => reihe(x) === reihe(s)) : [s];
    for (const x of ziele) {
      merkmal.set(x.id, werkzeug);
      const g = buehne.querySelector(`[data-sitz="${CSS.escape(x.id)}"]`);
      if (g) g.setAttribute("class", klasse(x));
    }
    stand();
  };
  const sitzAus = (e) => { const g = e.target.closest && e.target.closest("[data-sitz]"); return g ? daten.sitze.find((x) => x.id === g.dataset.sitz) : null; };
  // Maus: gedrückt halten und ziehen markiert mehrere Plätze. Touch: einzeln antippen.
  let malen = false, maus = false;
  buehne.addEventListener("pointerdown", (e) => {
    maus = e.pointerType === "mouse";
    if (!maus) return; // Touch/Stift: erst beim Antippen (click), Wischen scrollt
    const s = sitzAus(e); if (!s) return;
    e.preventDefault(); malen = true; setzen(s);
  });
  buehne.addEventListener("pointerover", (e) => { if (!malen) return; const s = sitzAus(e); if (s && merkmal.get(s.id) !== werkzeug) setzen(s); });
  buehne.addEventListener("click", (e) => { if (maus) return; const s = sitzAus(e); if (s) setzen(s); });
  const loslassen = () => { malen = false; };
  window.addEventListener("pointerup", loslassen);
  const abbauen = new MutationObserver(() => { if (!buehne.isConnected) { window.removeEventListener("pointerup", loslassen); abbauen.disconnect(); } });
  abbauen.observe(document.body, { childList: true });
  tooltipAnbinden(buehne, (id) => { const s = daten.sitze.find((x) => x.id === id); return s ? { ...s, status: anzeige(s) } : null; });
  $$("[data-w]", m.el).forEach((b) => (b.onclick = () => { werkzeug = b.dataset.w; stand(); }));
  $$("[data-z]", m.el).forEach((b) => (b.onclick = () => { zoom = Math.min(2.5, Math.max(0.4, zoom + Number(b.dataset.z) * 0.2)); zeichnen(); }));
  const zu = () => m.schliessen();
  $("[data-ab]", m.el).onclick = async () => {
    if ([...merkmal].some(([id, v]) => vorher.get(id) !== v) && !(await bestaetigen("Änderungen verwerfen?", { ja: "Verwerfen" }))) return;
    zu();
  };
  const ok = $("[data-ok]", m.el);
  ok.onclick = () => mitSperre(ok, async () => {
    const aenderungen = [...merkmal].filter(([id, v]) => vorher.get(id) !== v).map(([id, status]) => ({ id, status }));
    if (aenderungen.length) await api("adminSitzStatus", { lanId: l.id, aenderungen });
    toast(aenderungen.length ? `${aenderungen.length} Plätze geändert.` : "Keine Änderungen.", "ok");
    zu();
  });
  zeichnen();
}

// ---------------------------------------------------------------------------
// Gast ohne Konto an der Tür: Konto + Ticket + Platz (+ Check-in) in einem Schritt.
async function gastVorOrt(lan, fertig) {
  const { tickettypen } = await api("adminTickettypen", { lanId: lan.id });
  const typen = tickettypen.filter((x) => x.aktiv);
  if (!typen.length) { toast("Für diese LAN gibt es keine aktive Ticketsorte."); return; }
  const admin = istAdmin();
  const m = modal("Gast vor Ort anlegen – " + lan.name, `<form class="formular" autocomplete="off">
    <p class="klein leise" style="margin:0">Für Gäste ohne Konto: Es wird ein Konto mit Zufallspasswort angelegt, dazu das Ticket. Die Zugangsdaten zeigst du dem Gast danach.</p>
    <div class="zwei"><label class="feld"><span>Nickname</span><input name="nick" required maxlength="24"></label>
      <label class="feld"><span>Geburtsdatum</span><input name="geburtsdatum" type="date" required></label></div>
    <div class="zwei"><label class="feld"><span>Vorname</span><input name="vorname" required></label><label class="feld"><span>Nachname</span><input name="nachname" required></label></div>
    <label class="feld"><span>E-Mail (optional)</span><input name="email" type="email" placeholder="leer lassen, wenn keine angegeben"></label>
    <div class="zwei"><label class="feld"><span>Ticketsorte</span><select name="typId">${typen.map((x) => `<option value="${x.id}" data-sitz="${x.mitSitz ? 1 : 0}" data-preis="${x.preisCent}">${esc(x.name)} · ${euro(x.preisCent)}</option>`).join("")}</select></label>
      <label class="feld" data-platzfeld><span>Platz</span><div class="zeile" style="gap:8px;flex-wrap:nowrap">
        <input name="sitz" readonly placeholder="kein Platz" style="cursor:pointer" data-sitzwahl><button type="button" class="knopf" data-sitzwahl>Sitzplan</button></div></label></div>
    ${admin ? `<label class="feld"><span>Preis (€, leer = Preis der Ticketsorte)</span><input name="preis" type="number" step="0.01" min="0"></label>` : ""}
    <div class="zeile"><label class="check"><input type="checkbox" name="frei"> Freiticket (0 €)</label>
      <label class="check"><input type="checkbox" name="bezahlt" checked> Bar bezahlt</label>
      <label class="check"><input type="checkbox" name="einchecken" checked> Gleich einchecken</label></div>
    <label class="feld"><span>Orga-Notiz (optional)</span><input name="orgaNotiz" placeholder="z. B. Muttizettel liegt vor"></label>
    <div class="fehler-text"></div><button class="knopf primaer">Gast anlegen</button></form>`, { breit: true });
  const f = $("form", m.el);
  const typWahl = () => {
    const o = f.typId.selectedOptions[0];
    const mitSitz = o && o.dataset.sitz === "1";
    $("[data-platzfeld]", f).classList.toggle("versteckt", !mitSitz);
    if (!mitSitz) f.sitz.value = "";
  };
  f.typId.onchange = typWahl;
  typWahl();
  // Freiticket: nichts zu kassieren – „bezahlt“ ist dann automatisch.
  f.frei.onchange = () => {
    f.bezahlt.checked = true; f.bezahlt.disabled = f.frei.checked;
    if (f.preis) { f.preis.disabled = f.frei.checked; if (f.frei.checked) f.preis.value = ""; }
  };
  f.bezahlt.onchange = () => { if (!f.bezahlt.checked) f.einchecken.checked = false; };
  f.einchecken.onchange = () => { if (f.einchecken.checked) f.bezahlt.checked = true; };
  $$("[data-sitzwahl]", f).forEach((x) => (x.onclick = (e) => {
    e.preventDefault();
    const platzhalter = { lanId: lan.id, sitzId: null, sitz: "", nutzer: { nick: f.nick.value.trim() || "neuen Gast" } };
    mitSperre($("button[data-sitzwahl]", f), () => platzWaehlen(platzhalter, f.sitz));
  }));
  f.onsubmit = (e) => {
    e.preventDefault();
    mitSperre($("button.primaer", f), async () => {
      const v = formDaten(f);
      try {
        let sitzId = "";
        if (v.sitz) {
          const plan = await api("sitzplan", { lanId: lan.id });
          const s = plan.sitze.find((x) => x.label.toLowerCase() === v.sitz.toLowerCase());
          if (!s) throw new Error("Platz „" + v.sitz + "“ gibt es nicht.");
          sitzId = s.id;
        }
        const preis = admin && String(v.preis || "").trim() !== "" ? Math.round(Number(v.preis) * 100) : null;
        if (preis != null && (!Number.isFinite(preis) || preis < 0)) throw new Error("Bitte einen gültigen Preis eingeben.");
        const r = await api("adminGastAnlegen", {
          lanId: lan.id, nick: v.nick, vorname: v.vorname, nachname: v.nachname, geburtsdatum: v.geburtsdatum, email: v.email,
          typId: Number(v.typId), sitzId, bezahlt: v.bezahlt || v.frei, frei: v.frei, zahlart: "bar", einchecken: v.einchecken, orgaNotiz: v.orgaNotiz, preisCent: v.frei ? null : preis,
        });
        m.schliessen();
        fertig(r.ticket);
        gastZugangZeigen(r);
      } catch (err) { $(".fehler-text", f).textContent = err.message; }
    });
  };
}

// Nach dem Anlegen: Zugangsdaten einmalig zeigen. Der Gast scannt den QR mit dem Handy
// und hat dann sein Ticket samt Internet-Zugang; mit Nick + Passwort kommt er ins Konto und die App.
function gastZugangZeigen(r) {
  const t = r.ticket;
  const zeile = (label, wert) => `<div class="zugang-feld"><span>${esc(label)}</span><b class="mono">${esc(wert)}</b><button class="knopf klein geist" data-kopieren="${esc(wert)}">Kopieren</button></div>`;
  const m = modal("Gast angelegt: " + t.nutzer.nick, `<div class="stapel">
    ${r.hinweis ? `<div class="abzeichen gold" style="white-space:normal;padding:8px 12px">${esc(r.hinweis)}</div>` : ""}
    <div class="zeile" style="align-items:flex-start;gap:18px">
      <div style="background:#fff;padding:10px;border-radius:8px;width:180px;max-width:45vw">${qrSvg(ticketLink(t.code))}</div>
      <div style="flex:1;min-width:200px">
        <p class="klein leise" style="margin-top:0">Gast scannt den QR-Code mit dem Handy: Dort stehen Ticket${t.checkinAt ? " und Internet-Zugang" : ""}.</p>
        <div class="karte" style="padding:12px">
          <div class="ueberzeile" style="margin-bottom:6px">Konto (Website und AgeLan-App)</div>
          ${zeile("Nickname", t.nutzer.nick)}${zeile("Passwort", r.passwort)}
          ${t.otp ? `<div class="ueberzeile" style="margin:10px 0 6px">Internet</div>${zeile("Code", t.otp)}` : ""}
        </div>
        <p class="klein leise">Platz: <b>${esc(t.sitz || "–")}</b> · ${t.checkinAt ? "eingecheckt" : "noch nicht eingecheckt"} · ${t.status === "bezahlt" ? "bezahlt" : "Zahlung offen"}</p>
      </div></div>
    <p class="klein gold" style="margin:0">Das Passwort wird nur jetzt angezeigt. Vergessen? Verwaltung → Benutzer → Passwort zurücksetzen.</p>
    <div class="zeile"><button class="knopf primaer" data-drucken>Ticket drucken</button><button class="knopf geist" data-fertig>Fertig</button></div></div>`, { breit: true });
  kopierenVerdrahten(m.el);
  $("[data-fertig]", m.el).onclick = () => m.schliessen();
  $("[data-drucken]", m.el).onclick = async () => {
    const { ticketHtml } = await import("./konto.js?v=65");
    drucken(`<div style="max-width:190mm;margin:0 auto">${ticketHtml(t)}</div>`);
  };
}

// ---------------------------------------------------------------------------
// Platz für ein Ticket im Sitzplan auswählen. Frei, von einer Gruppe vorgemerkt
// oder gesperrt darf die Orga vergeben; Plätze anderer Gäste nicht.
// Übernimmt nur ins Formular – gespeichert wird mit „Speichern“ im Ticket-Dialog.
async function platzWaehlen(t, feld) {
  const daten = await api("sitzplan", { lanId: t.lanId });
  const sitze = daten.sitze.map((s) => ({ ...s, meins: false, meineGruppe: false }));
  const waehlbar = (s) => s.id === t.sitzId || ["frei", "gruppe", "gesperrt"].includes(s.status);
  let gewaehlt = sitze.find((s) => s.label.toLowerCase() === feld.value.trim().toLowerCase()) || null;
  const m = modal("Platz für " + t.nutzer.nick, `<div class="stapel">
    <div class="zeile zwischen" style="align-items:center"><div class="klein" id="pw-info"></div>
      <div class="zeile" style="gap:6px"><button class="knopf klein" data-z="-1" title="Verkleinern">−</button><button class="knopf klein" data-z="1" title="Vergrößern">+</button></div></div>
    <div class="plan-buehne" id="pw-buehne" style="max-height:62vh;max-height:62dvh"></div>
    <details><summary class="klein leise" style="cursor:pointer">Legende</summary>${legendeHtml()}</details>
    <div class="zeile"><button class="knopf primaer" data-ok>Platz übernehmen</button><button class="knopf" data-kein>Kein Platz</button><button class="knopf geist" data-ab>Abbrechen</button></div></div>`, { breit: true });
  const buehne = $("#pw-buehne", m.el);
  const info = $("#pw-info", m.el);
  let zoom = Math.min(1.4, Math.max(0.45, (buehne.clientWidth - 30) / (daten.plan.breite * U + 12)));
  const zeichnen = () => {
    buehne.innerHTML = planSvg(daten.plan, sitze, {
      zoom,
      klassen: (s, istDeko) => (istDeko ? "" : [s.id === t.sitzId ? "markiert" : "", gewaehlt && s.id === gewaehlt.id ? "gewaehlt" : ""].join(" ")),
    });
    const frei = sitze.filter((s) => s.status === "frei").length;
    info.innerHTML = gewaehlt && gewaehlt.id !== t.sitzId
      ? `Gewählt: ${sitzInfo(gewaehlt)}${gewaehlt.status === "gruppe" ? ` <span class="gold">– der Gruppe wird der Platz damit genommen</span>` : ""}${gewaehlt.status === "gesperrt" ? ` <span class="gold">– Platz ist gesperrt</span>` : ""}`
      : `Aktuell: <b>${esc(t.sitz || "kein Platz")}</b> · ${frei} Plätze frei. Klicke einen freien Platz an.`;
  };
  buehne.addEventListener("click", (e) => {
    const g = e.target.closest("[data-sitz]");
    if (!g) return;
    const s = sitze.find((x) => x.id === g.dataset.sitz);
    if (!s) return;
    if (!waehlbar(s)) { toast(`Platz ${s.label} ist schon vergeben${s.nick ? " an " + s.nick : ""}.`); return; }
    gewaehlt = s;
    zeichnen();
  });
  tooltipAnbinden(buehne, (id) => sitze.find((x) => x.id === id));
  $$("[data-z]", m.el).forEach((b) => (b.onclick = () => { zoom = Math.min(2.5, Math.max(0.4, zoom + Number(b.dataset.z) * 0.2)); zeichnen(); }));
  const setzen = (wert) => { feld.value = wert; feld.dispatchEvent(new Event("input", { bubbles: true })); m.schliessen(); };
  $("[data-ok]", m.el).onclick = () => { if (!gewaehlt) { toast("Bitte erst einen Platz anklicken."); return; } setzen(gewaehlt.label); };
  $("[data-kein]", m.el).onclick = () => setzen("");
  $("[data-ab]", m.el).onclick = () => m.schliessen();
  zeichnen();
  const ziel = $(".gewaehlt, .markiert", buehne);
  if (ziel) ziel.scrollIntoView({ block: "center", inline: "center" });
}

async function einstellungen(box) {
  const { einstellungen: e, paypal: pp = {} } = await api("adminEinstellungen");
  const s = e.seite, z = e.zahlung;
  box.innerHTML = kopf("Einstellungen") + `<div class="stapel">
    <form class="karte formular" data-key="seite"><h3>Website</h3>
      <div class="zwei"><label class="feld"><span>Titel</span><input name="titel" value="${esc(s.titel)}"></label><label class="feld"><span>Slogan</span><input name="slogan" value="${esc(s.slogan)}"></label></div>
      <label class="feld"><span>Info-Band oben (leer = aus)</span><input name="headerInfo" value="${esc(s.headerInfo)}"></label>
      <div class="zwei">${["discord", "twitch", "youtube", "instagram", "facebook"].map((k) => `<label class="feld"><span>${k}</span><input name="so_${k}" value="${esc((s.socials || {})[k] || "")}" placeholder="https://…"></label>`).join("")}</div>
      <button class="knopf primaer">Speichern</button></form>
    <form class="karte formular" data-key="zahlung"><h3>Zahlung</h3>
      <label class="check"><input type="checkbox" name="a_paypal_direkt" ${z.arten.paypal_direkt ? "checked" : ""}> <span><b>PayPal direkt</b> – Gast zahlt beim Kauf über PayPal, Ticket ist sofort bezahlt
        <span class="klein ${pp.bereit ? "gruen" : "rot"}" style="display:block">${pp.bereit ? "Eingerichtet (" + (pp.modus === "live" ? "LIVE – echtes Geld" : "Sandbox – Testgeld") + ")" : "Noch nicht eingerichtet: Secrets PAYPAL_CLIENT_ID und PAYPAL_SECRET beim Worker fehlen"}</span></span></label>
      <div class="zeile"><label class="check"><input type="checkbox" name="a_ueberweisung" ${z.arten.ueberweisung ? "checked" : ""}> Überweisung</label><label class="check"><input type="checkbox" name="a_bar" ${z.arten.bar ? "checked" : ""}> Bar</label></div>
      <div class="zwei"><label class="feld"><span>Kontoinhaber</span><input name="kontoinhaber" value="${esc(z.kontoinhaber)}"></label><label class="feld"><span>IBAN</span><input name="iban" value="${esc(z.iban)}"></label></div>
      <div class="zwei"><label class="feld"><span>Bank</span><input name="bank" value="${esc(z.bank)}"></label><label class="feld"><span>Zahlungsfrist (Tage)</span><input name="fristTage" type="number" min="0" value="${z.fristTage}"></label></div>
      <label class="feld"><span>Hinweis für Gäste</span><textarea name="hinweis">${esc(z.hinweis)}</textarea></label>
      <button class="knopf primaer">Speichern</button></form>
    <form class="karte formular" data-key="netz"><h3>Internet-Zugang</h3>
      <p class="klein leise" style="margin:0">Steht nach dem Check-in auf dem Handy des Gastes. Das Passwort ist der 5-stellige Code, der beim Check-in erzeugt wird. Das Hallen-Portal prüft ihn bei uns und meldet das Gerät (MAC/IP) zurück.</p>
      <div class="zwei"><label class="feld"><span>Portal-Adresse (optional)</span><input name="portal" value="${esc(e.netz.portal)}" placeholder="http://login.lan"></label>
        <label class="feld"><span>Benutzername ist …</span><select name="benutzer"><option value="nick" ${e.netz.benutzer !== "code" ? "selected" : ""}>der Nickname</option><option value="code" ${e.netz.benutzer === "code" ? "selected" : ""}>die ersten 8 Zeichen des Ticket-Codes</option></select></label></div>
      <label class="feld"><span>Hinweis für Gäste</span><input name="hinweis" value="${esc(e.netz.hinweis)}"></label>
      <div class="zwei"><label class="feld"><span>Max. Geräte je Code (0 = unbegrenzt)</span><input name="maxGeraete" type="number" min="0" max="20" value="${e.netz.maxGeraete ?? 3}"></label>
        <label class="feld"><span>Geräte-Einträge löschen nach (Tagen)</span><input name="aufbewahrungTage" type="number" min="1" max="365" value="${e.netz.aufbewahrungTage ?? 30}"></label></div>
      <button class="knopf primaer">Speichern</button></form>
    <form class="karte formular" data-key="optionen"><h3>Optionen</h3>
      <label class="check"><input type="checkbox" name="gaesteOeffentlich" ${e.gaesteOeffentlich ? "checked" : ""}> Gästeliste und Namen im Sitzplan öffentlich</label>
      <label class="check"><input type="checkbox" name="sitzwahlOffen" ${e.sitzwahlOffen ? "checked" : ""}> Gäste dürfen ihren Platz selbst wählen</label>
      <p class="klein leise" style="margin:0">Regeln für Reservierungsgruppen (Haltefrist, Höchstdauer, Stichtag) stehen unter Verwaltung → Reservierungsgruppen.</p>
      <button class="knopf primaer">Speichern</button></form>
    <form class="karte formular" data-key="highlights"><h3>Highlights (Startseite)</h3>
      <label class="feld"><span>Eine pro Zeile: Icon | Titel | Text</span><textarea name="t" style="min-height:150px">${esc(e.highlights.map((h) => [h.icon, h.titel, h.text].join(" | ")).join("\n"))}</textarea></label>
      <button class="knopf primaer">Speichern</button></form>
    <form class="karte formular" data-key="faq"><h3>FAQ</h3>
      <label class="feld"><span>Je Eintrag: erste Zeile Frage, darunter Antwort. Einträge mit einer Leerzeile trennen.</span><textarea name="t" style="min-height:260px">${esc(e.faq.map((f) => f.f + "\n" + f.a).join("\n\n"))}</textarea></label>
      <button class="knopf primaer">Speichern</button></form>
    <form class="karte formular" data-key="sponsoren"><h3>Sponsoren</h3>
      <label class="feld"><span>Einer pro Zeile: Name | Link | Logo-Adresse</span><textarea name="t">${esc(e.sponsoren.map((x) => [x.name, x.url, x.logo].join(" | ")).join("\n"))}</textarea></label>
      <button class="knopf primaer">Speichern</button></form>
    <form class="karte formular" data-key="texte"><h3>Texte</h3>
      ${[["anfahrt", "Anfahrt"], ["agb", "Teilnahmebedingungen"], ["datenschutz", "Datenschutz"], ["impressum", "Impressum"]].map(([k, l]) => `<label class="feld"><span>${l}</span><textarea name="${k}" style="min-height:120px">${esc(e.texte[k])}</textarea></label>`).join("")}
      <button class="knopf primaer">Speichern</button></form></div>`;

  const sammeln = {
    seite: (v) => [["seite", { titel: v.titel, slogan: v.slogan, headerInfo: v.headerInfo, socials: Object.fromEntries(["discord", "twitch", "youtube", "instagram", "facebook"].map((k) => [k, v["so_" + k].trim()])) }]],
    zahlung: (v) => [["zahlung", { arten: { paypal_direkt: v.a_paypal_direkt, paypal: false, ueberweisung: v.a_ueberweisung, bar: v.a_bar }, paypal: z.paypal, paypalMe: z.paypalMe, kontoinhaber: v.kontoinhaber, iban: v.iban, bank: v.bank, fristTage: Number(v.fristTage) || 0, hinweis: v.hinweis }]],
    netz: (v) => [["netz", { ssid: "", wlanPasswort: "", portal: v.portal.trim(), benutzer: v.benutzer, hinweis: v.hinweis, maxGeraete: Number(v.maxGeraete), aufbewahrungTage: Number(v.aufbewahrungTage) }]],
    optionen: (v) => [["gaesteOeffentlich", v.gaesteOeffentlich], ["sitzwahlOffen", v.sitzwahlOffen]],
    highlights: (v) => [["highlights", v.t.split("\n").map((z) => z.split("|").map((x) => x.trim())).filter((z) => z[1]).map(([icon, titel, text]) => ({ icon, titel, text: text || "" }))]],
    faq: (v) => [["faq", v.t.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => { const [f, ...a] = b.split("\n"); return { f: f.trim(), a: a.join("\n").trim() }; })]],
    sponsoren: (v) => [["sponsoren", v.t.split("\n").map((z) => z.split("|").map((x) => x.trim())).filter((z) => z[0]).map(([name, url, logo]) => ({ name, url: url || "", logo: logo || "" }))]],
    texte: (v) => [["texte", { anfahrt: v.anfahrt, agb: v.agb, datenschutz: v.datenschutz, impressum: v.impressum }]],
  };
  $$("form[data-key]", box).forEach((f) => (f.onsubmit = (ev) => {
    ev.preventDefault();
    mitSperre($("button", f), async () => {
      for (const [key, wert] of sammeln[f.dataset.key](formDaten(f))) await api("adminEinstellungSpeichern", { key, wert });
      toast("Gespeichert.", "ok");
      neuLaden().catch(fehler);
    });
  }));
}

// ---------------------------------------------------------------------------
async function benutzer(box) {
  const { benutzer: bs } = await api("adminBenutzer");
  box.innerHTML = kopf(`Benutzer <span class="leise">(${bs.length})</span>`) + `
    <input data-q placeholder="Suchen …" style="max-width:320px;margin-bottom:14px">
    <div class="tabelle-wrap"><table><thead><tr><th>Nick</th><th>Name</th><th>E-Mail</th><th>Geburtstag</th><th>Ticket</th><th>Rolle</th><th title="Darf sich in der AgeLan-App in den Streamplan eintragen">Streamer</th><th></th></tr></thead><tbody id="b-liste"></tbody></table></div>`;
  const zeichnen = () => {
    const q = $("[data-q]", box).value.trim().toLowerCase();
    const anzahl = box.querySelector("h1 .leise, h2 .leise");
    if (anzahl) anzahl.textContent = `(${bs.length})`;
    $("#b-liste", box).innerHTML = bs.filter((u) => !q || [u.nick, u.vorname, u.nachname, u.email].join(" ").toLowerCase().includes(q)).map((u) => `<tr>
      <td><b>${esc(u.nick)}</b>${u.gesperrt ? ` <span class="abzeichen rot">gesperrt</span>` : ""}${u.vorOrt ? ` <span class="abzeichen" title="An der Tür von der Orga angelegt">vor Ort</span>` : ""}</td><td>${esc(u.vorname)} ${esc(u.nachname)}</td><td class="klein">${esc(u.email.endsWith("@vor-ort.invalid") ? "–" : u.email)}</td><td class="klein">${esc(u.geburtsdatum)}</td>
      <td>${u.ticket ? `<span class="abzeichen ${u.ticket === "bezahlt" ? "gruen" : "gold"}">${esc(u.ticket)}</span>` : `<button class="knopf klein geist" data-ticket="${u.id}">+ Ticket</button>`}</td>
      <td><select data-rolle="${u.id}" style="width:auto;padding:5px 8px">${[["user", "Gast"], ["admin", "Orga"]].map(([k, l]) => `<option value="${k}" ${u.rolle === k ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><input type="checkbox" data-streamer="${u.id}" ${u.streamer ? "checked" : ""}></td>
      <td style="white-space:nowrap"><button class="knopf klein" data-pw="${u.id}">Passwort neu</button> <button class="knopf klein geist" data-sperren="${u.id}">${u.gesperrt ? "Entsperren" : "Sperren"}</button>${u.rolle !== "admin" ? ` <button class="knopf klein rot" data-loeschen="${u.id}">Löschen</button>` : ""}</td></tr>`).join("");
    $$("[data-rolle]", box).forEach((s) => (s.onchange = async () => {
      const ziel = bs.find((u) => u.id === Number(s.dataset.rolle));
      if (s.value === "admin" && !(await bestaetigen(`${ziel.nick} zur Orga machen? Die Orga hat vollen Zugriff auf alles – auch auf Zahlungen, Einstellungen und Konten.`, { ja: "Zur Orga machen", gefahr: true }))) { s.value = ziel.rolle; return; }
      try { await api("adminBenutzerAendern", { userId: Number(s.dataset.rolle), rolle: s.value }); bs.find((u) => u.id === Number(s.dataset.rolle)).rolle = s.value; toast("Rolle geändert.", "ok"); } catch (e) { fehler(e); zeichnen(); }
    }));
    $$("[data-streamer]", box).forEach((c) => (c.onchange = async () => {
      try { await api("adminBenutzerAendern", { userId: Number(c.dataset.streamer), streamer: c.checked }); bs.find((u) => u.id === Number(c.dataset.streamer)).streamer = c.checked; toast("Gespeichert.", "ok"); } catch (e) { fehler(e); zeichnen(); }
    }));
    $$("[data-pw]", box).forEach((b) => (b.onclick = async () => {
      const u = bs.find((x) => x.id === Number(b.dataset.pw));
      if (!(await bestaetigen(`Neues Passwort für ${u.nick} erzeugen? Das alte gilt dann nicht mehr.`, { ja: "Erzeugen" }))) return;
      mitSperre(b, async () => {
        const r = await api("adminBenutzerAendern", { userId: u.id, passwortZuruecksetzen: true });
        modal("Neues Passwort", `<p>Gib ${esc(u.nick)} dieses Passwort weiter. Es wird nur jetzt angezeigt.</p><p class="mono gold" style="font-size:1.5rem;letter-spacing:.1em">${esc(r.neuesPasswort)}</p>`);
      });
    }));
    $$("[data-sperren]", box).forEach((b) => (b.onclick = () => mitSperre(b, async () => {
      const u = bs.find((x) => x.id === Number(b.dataset.sperren));
      await api("adminBenutzerAendern", { userId: u.id, gesperrt: !u.gesperrt });
      u.gesperrt = !u.gesperrt; zeichnen();
    })));
    $$("[data-loeschen]", box).forEach((b) => (b.onclick = async () => {
      const u = bs.find((x) => x.id === Number(b.dataset.loeschen));
      if (!(await bestaetigen(`Konto ${u.nick} (${u.vorname} ${u.nachname}) endgültig löschen? Das lässt sich nicht rückgängig machen.`, { ja: "Löschen", gefahr: true }))) return;
      mitSperre(b, async () => {
        try { await api("adminBenutzerLoeschen", { userId: u.id }); bs.splice(bs.indexOf(u), 1); toast(u.nick + " gelöscht.", "ok"); zeichnen(); } catch (e) { fehler(e); }
      });
    }));
    $$("[data-ticket]", box).forEach((b) => (b.onclick = () => mitSperre(b, async () => {
      const u = bs.find((x) => x.id === Number(b.dataset.ticket));
      const { tickettypen: ts } = await api("adminTickettypen", { lanId });
      const m = modal("Ticket für " + u.nick, `<form class="formular">
        <label class="feld"><span>Ticketsorte</span><select name="typId">${ts.map((t) => `<option value="${t.id}">${esc(t.name)} (${euro(t.preisCent)})</option>`).join("")}</select></label>
        <div class="zwei"><label class="feld"><span>Zahlart</span><select name="zahlart">${Object.entries(ZAHLARTEN).map(([k, l]) => `<option value="${k}" ${k === "bar" ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="feld"><span>Preis (€, leer = Standard)</span><input name="preis" type="number" step="0.01" min="0"></label></div>
        <label class="check"><input type="checkbox" name="bezahlt" checked> schon bezahlt</label>
        <div class="fehler-text"></div><button class="knopf primaer">Ticket anlegen</button></form>`);
      const f = $("form", m.el);
      f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
        const v = formDaten(f);
        try {
          await api("adminTicketAnlegen", { lanId, userId: u.id, typId: Number(v.typId), zahlart: v.zahlart, bezahlt: v.bezahlt, preisCent: v.preis === "" ? null : Math.round(Number(v.preis) * 100) });
          m.schliessen(); toast("Ticket angelegt.", "ok"); benutzer(box);
        } catch (err) { $(".fehler-text", f).textContent = err.message; }
      }); };
    })));
  };
  $("[data-q]", box).oninput = zeichnen;
  zeichnen();
}

// ---------------------------------------------------------------------------
async function protokoll(box) {
  const { eintraege } = await api("adminProtokoll");
  box.innerHTML = kopf("Protokoll") + `<div class="tabelle-wrap"><table><thead><tr><th>Wann</th><th>Wer</th><th>Aktion</th><th>Details</th></tr></thead><tbody>
    ${eintraege.map((e) => `<tr><td class="klein leise" style="white-space:nowrap">${esc(zeit(e.at))}</td><td>${esc(e.nick || "–")}</td><td><span class="abzeichen">${esc(e.aktion)}</span></td><td class="klein mono">${esc(e.details)}</td></tr>`).join("")}
  </tbody></table></div>`;
}
