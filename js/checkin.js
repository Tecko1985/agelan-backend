// Check-in: QR-Code scannen (oder Name suchen), Ticket prüfen, einchecken.
// Kein Etikett mehr: Die Internet-Zugangsdaten erscheinen danach auf dem Handy
// des Gastes (Ticket-QR scannen → Ticket-Seite, oder im Konto).
import { api } from "./api.js?v=11";
import { zustand, neuLaden, istOrga, beimVerlassen } from "./app.js?v=11";
import { esc, $, $$, euro, zeit, codeGruppen, toast, fehler, mitSperre } from "./ui.js?v=11";

// jsQR (1.4.0, UMD, setzt window.jsQR) liegt lokal neben diesem Modul.
const JSQR = new URL("./jsqr.js?v=11", import.meta.url).href;
function alterAm(geb, stichtag) {
  if (!geb) return null;
  const [gj, gm, gt] = geb.split("-").map(Number);
  const [sj, sm, st] = (stichtag || new Date().toISOString().slice(0, 10)).split("-").map(Number);
  let a = sj - gj;
  if (sm < gm || (sm === gm && st < gt)) a--;
  return a;
}

let stream = null;
let generation = 0; // jeder Stopp macht laufende Starts ungültig
function kameraStoppen() {
  generation++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function skriptLaden(src) {
  return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => { s.remove(); no(new Error("Skript nicht geladen")); }; document.head.appendChild(s); });
}

export async function render(main, param) {
  await neuLaden();
  if (!istOrga()) { main.innerHTML = `<div class="wrap"><div class="leer" style="margin-top:40px">Der Check-in ist nur für die Orga. <a href="#/konto">Anmelden</a></div></div>`; return; }
  const lan = zustand.daten.lan;
  const zuletzt = [];

  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf zeile zwischen" style="align-items:end"><div><span class="ueberzeile">${esc(lan.name)}</span><h1 style="margin:0">Check-in</h1></div>
      <span class="leise klein">Nach dem Check-in sieht der Gast seine Internet-Zugangsdaten auf dem Handy.</span></div>
    <div class="raster raster-2" style="margin-top:18px;align-items:start">
      <div class="stapel">
        <div class="scanner" id="c-scanner"><video playsinline muted></video><div class="rahmen"></div><div class="hinweis" id="c-hinweis">Kamera starten, um QR-Codes zu scannen</div></div>
        <div class="zeile"><button class="knopf primaer" id="c-kamera">Kamera starten</button>
          <form id="c-suche" class="zeile" style="flex:1"><input name="q" placeholder="Code, Nick, Name oder Platz …" style="flex:1;min-width:160px" autocomplete="off"><button class="knopf">Suchen</button></form></div>
        <div class="karte"><h3>Zuletzt eingecheckt</h3><div id="c-zuletzt" class="leise klein">Noch niemand in dieser Sitzung.</div></div>
      </div>
      <div id="c-ergebnis"><div class="leer">Scanne ein Ticket oder suche nach einem Gast.</div></div>
    </div></div>`;


  const ergebnis = $("#c-ergebnis", main);
  const LEER = `<div class="leer">Scanne ein Ticket oder suche nach einem Gast.</div>`;
  let angezeigt = ""; // zuletzt gescannter Code, solange seine Ergebniskarte sichtbar ist
  const weiterVerdrahten = () => {
    const w = $("[data-weiter]", ergebnis);
    if (w) w.onclick = () => { angezeigt = ""; ergebnis.innerHTML = LEER; };
  };

  const zeigen = (t, hinweis = "") => {
    const alter = alterAm(t.nutzer.geburtsdatum, t.lan.start);
    const warnungen = [];
    if (t.status === "storniert") warnungen.push("Ticket ist STORNIERT.");
    if (t.lanId !== lan.id) warnungen.push("Ticket gehört zu einer anderen LAN (" + t.lan.name + ").");
    if (t.status === "offen") warnungen.push(`Noch nicht bezahlt – ${euro(t.preisCent)} (${t.zahlartText}).`);
    if (t.checkinAt && !hinweis.startsWith("Eingecheckt")) warnungen.push(`Bereits eingecheckt am ${zeit(t.checkinAt)} von ${t.checkinVon}.`);
    if (alter != null && alter < 18) warnungen.push(`Unter 18 (${alter} J.) – Muttizettel und Aufsichtsperson prüfen!`);
    if (t.typ.mitSitz && !t.sitz) warnungen.push("Hat noch keinen Sitzplatz.");
    const art = t.status === "storniert" || t.lanId !== lan.id ? "fehler" : warnungen.length ? "warnung" : "ok";
    ergebnis.innerHTML = `<div class="karte ergebnis ${art}">
      ${hinweis ? `<div class="abzeichen gold" style="margin-bottom:10px">${esc(hinweis)}</div>` : ""}
      <div class="karte-kopf"><div><div class="ueberzeile">${esc(t.typ.name)}</div><h2 style="margin:0">${esc(t.nutzer.nick)}</h2>
        <div class="leise">${esc(t.nutzer.vorname)} ${esc(t.nutzer.nachname)}${alter != null ? " · " + alter + " J." : ""}</div></div>
        <div style="text-align:right"><div class="klein leise">Platz</div><div class="gross-sitz">${esc(t.sitz || "–")}</div></div></div>
      ${warnungen.length ? `<div class="stapel" style="margin-bottom:14px">${warnungen.map((w) => `<div class="abzeichen ${art === "fehler" ? "rot" : "gold"}" style="white-space:normal;font-size:.85rem;padding:8px 12px">${esc(w)}</div>`).join("")}</div>`
        : `<div class="abzeichen gruen" style="font-size:.9rem;padding:8px 12px;margin-bottom:14px">✓ Alles in Ordnung</div>`}
      <dl class="daten-liste">
        <dt>Status</dt><dd>${t.status === "bezahlt" ? `<span class="gruen">Bezahlt</span> (${esc(t.zahlartText)}${t.bezahltVon ? ", " + esc(t.bezahltVon) : ""})` : esc(t.status)}</dd>
        <dt>Gruppe</dt><dd>${esc(t.gruppe || "–")}</dd>
        <dt>Internet</dt><dd>${t.otp ? `<span class="mono"><b>${esc(t.otp)}</b></span> <span class="klein leise">– steht beim Gast auf dem Handy</span>` : `<span class="leise">Zugang wird beim Check-in erzeugt</span>`}</dd>
        ${t.notiz ? `<dt>Hinweis Gast</dt><dd>${esc(t.notiz)}</dd>` : ""}
        <dt>Code</dt><dd class="mono klein">${esc(codeGruppen(t.code))}</dd></dl>
      <label class="feld" style="margin-top:14px"><span>Orga-Notiz</span><input id="c-notiz" value="${esc(t.orgaNotiz)}" placeholder="z. B. Muttizettel liegt vor"></label>
      <div class="zeile" style="margin-top:16px">
        ${t.status === "storniert" || t.lanId !== lan.id ? "" : t.status === "offen"
          ? `<button class="knopf gruen gross" data-bar>${euro(t.preisCent)} bar kassiert + einchecken</button>`
          : t.checkinAt ? "" : `<button class="knopf gruen gross" data-checkin>✓ Einchecken</button>`}
        <button class="knopf geist" data-weiter>Weiter</button>
      </div></div>`;
    weiterVerdrahten();
    const ausfuehren = (knopf, jetztBezahlt) => mitSperre(knopf, async () => {
      const r = await api("checkin", { ticketId: t.id, jetztBezahlt, zahlart: "bar", orgaNotiz: $("#c-notiz", ergebnis).value });
      toast(t.nutzer.nick + " ist eingecheckt ✓", "ok");
      zuletzt.unshift(r.ticket);
      zuletztZeichnen();
      zeigen(r.ticket, "Eingecheckt – der Gast scannt jetzt seinen Ticket-QR mit dem Handy und sieht die Zugangsdaten");
    });
    const ck = $("[data-checkin]", ergebnis); if (ck) ck.onclick = () => ausfuehren(ck, false);
    const bar = $("[data-bar]", ergebnis); if (bar) bar.onclick = () => ausfuehren(bar, true);
  };

  const zuletztZeichnen = () => {
    $("#c-zuletzt", main).innerHTML = zuletzt.slice(0, 12).map((t) => `<div class="zeile zwischen" style="padding:5px 0;border-bottom:1px dashed var(--rand)">
      <span><b style="color:var(--text)">${esc(t.nutzer.nick)}</b> · ${esc(t.sitz || "–")}</span><span>${esc(zeit(t.checkinAt).split(", ")[1] || "")}</span></div>`).join("");
  };

  const suchen = async (eingabe) => {
    try {
      const r = await api("checkinSuchen", { code: eingabe });
      if (!r.treffer.length) {
        ergebnis.innerHTML = `<div class="karte ergebnis fehler"><h3>Nichts gefunden</h3><p class="leise">Kein Ticket zu „${esc(eingabe)}“.</p>
          <button class="knopf geist" data-weiter>Weiter</button></div>`;
        weiterVerdrahten();
        return;
      }
      if (r.treffer.length === 1) { zeigen(r.treffer[0]); return; }
      ergebnis.innerHTML = `<div class="karte"><h3>${r.treffer.length} Treffer</h3>${r.treffer.map((t, i) => `<button class="knopf voll" style="justify-content:space-between;margin-bottom:6px" data-i="${i}">
        <span>${esc(t.nutzer.nick)} <span class="leise">(${esc(t.nutzer.vorname)} ${esc(t.nutzer.nachname)})</span></span><span>${t.checkinAt ? "✓ " : ""}${esc(t.sitz || "–")}</span></button>`).join("")}</div>`;
      $$("[data-i]", ergebnis).forEach((b) => (b.onclick = () => zeigen(r.treffer[Number(b.dataset.i)])));
    } catch (e) { fehler(e); }
  };

  $("#c-suche", main).onsubmit = (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) { angezeigt = ""; suchen(q); } };

  // ---- Kamera ----
  const knopf = $("#c-kamera", main);
  const hinweis = $("#c-hinweis", main);
  const video = $("#c-scanner video", main);
  let laeuft = false, startet = false, verlassen = false;
  const stoppen = (text) => {
    laeuft = false;
    kameraStoppen();
    video.srcObject = null;
    knopf.textContent = "Kamera starten";
    if (text) hinweis.textContent = text;
  };
  knopf.onclick = async () => {
    if (startet) return;
    if (laeuft) { stoppen("Kamera gestoppt"); return; }
    startet = true;
    knopf.disabled = true;
    kameraStoppen();
    const gen = generation;
    // Nach jedem await: Seite verlassen oder Kamera inzwischen gestoppt? Dann nichts mehr anfassen.
    const veraltet = () => verlassen || gen !== generation;
    try {
      let s;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (e) { throw new Error("Kamera nicht verfügbar: " + e.message); }
      if (veraltet()) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      video.srcObject = s;
      try { await video.play(); } catch (e) { throw new Error("Kamerabild lässt sich nicht abspielen: " + e.message); }
      if (veraltet()) return;
      let detector = null;
      if ("BarcodeDetector" in window) { try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { detector = null; } }
      if (!detector && !window.jsQR) {
        try { await skriptLaden(JSQR); } catch (e) { /* unten gemeldet */ }
        if (veraltet()) return;
        if (!window.jsQR) throw new Error("QR-Erkennung konnte nicht geladen werden. Bitte über die Suche einchecken.");
      }
      laeuft = true;
      knopf.textContent = "Kamera stoppen";
      hinweis.textContent = "QR-Code in den Rahmen halten";
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const schleife = async () => {
        if (!laeuft || veraltet()) return;
        try {
          let text = "";
          if (video.readyState >= 2) {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes.length) text = codes[0].rawValue;
            } else {
              canvas.width = video.videoWidth; canvas.height = video.videoHeight;
              ctx.drawImage(video, 0, 0);
              const r = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
              if (r) text = r.data;
            }
          }
          // Derselbe Code wird nicht erneut gesucht, solange seine Karte sichtbar ist.
          if (text && text !== angezeigt && !veraltet()) {
            angezeigt = text;
            if (navigator.vibrate) navigator.vibrate(80);
            await suchen(text);
          }
        } catch (e) { /* Bild verpasst – weiter */ }
        setTimeout(schleife, 180);
      };
      schleife();
    } catch (e) {
      if (!veraltet()) { fehler(e); stoppen("Kamera nicht verfügbar"); }
    } finally {
      startet = false;
      knopf.disabled = false;
    }
  };
  beimVerlassen(() => { verlassen = true; laeuft = false; kameraStoppen(); }, main);
  if (param) { $("#c-suche", main).q.value = param; suchen(param); }
}
