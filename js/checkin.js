// Check-in: QR-Code scannen (oder Name suchen), Ticket prüfen, einchecken.
// Kein Etikett mehr: Die Internet-Zugangsdaten erscheinen danach auf dem Handy
// des Gastes (Ticket-QR scannen → Ticket-Seite, oder im Konto).
import { api } from "./api.js?v=40";
import { zustand, neuLaden, istOrga, beimVerlassen } from "./app.js?v=40";
import { esc, $, $$, euro, zeit, codeGruppen, toast, fehler, mitSperre } from "./ui.js?v=40";

// jsQR (1.4.0, UMD, setzt window.jsQR) liegt lokal neben diesem Modul.
const JSQR = new URL("./jsqr.js?v=40", import.meta.url).href;
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

// QR-Erkennung. BarcodeDetector (Android/Chrome) zuerst, sonst bzw. zusätzlich jsQR.
// Manche Android-Geräte melden BarcodeDetector, erkennen damit aber nichts –
// deshalb läuft jsQR immer als Rückfall mit. jsQR bekommt ein verkleinertes Bild:
// abwechselnd den Mittelteil (der Rahmen) und das ganze Bild.
export async function qrErkenner() {
  let detector = null;
  if ("BarcodeDetector" in window) {
    try {
      const formate = window.BarcodeDetector.getSupportedFormats ? await window.BarcodeDetector.getSupportedFormats() : ["qr_code"];
      if (formate.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch (e) { detector = null; }
  }
  if (!window.jsQR) { try { await skriptLaden(JSQR); } catch (e) { /* unten geprüft */ } }
  if (!detector && !window.jsQR) throw new Error("QR-Erkennung konnte nicht geladen werden. Bitte über die Suche einchecken.");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let bild = 0;
  const erkennen = async (quelle, breite, hoehe) => {
    if (!breite || !hoehe) return "";
    if (detector) {
      try {
        const codes = await detector.detect(quelle);
        if (codes.length) return codes[0].rawValue;
      } catch (e) { detector = null; } // kaputter Detector → nur noch jsQR
    }
    if (!window.jsQR) return "";
    const ganz = bild++ % 2 === 1;
    const seite = Math.min(breite, hoehe) * 0.8;
    const [sx, sy, sw, sh] = ganz ? [0, 0, breite, hoehe] : [(breite - seite) / 2, (hoehe - seite) / 2, seite, seite];
    const f = Math.min(1, (ganz ? 960 : 720) / Math.max(sw, sh));
    canvas.width = Math.round(sw * f); canvas.height = Math.round(sh * f);
    ctx.drawImage(quelle, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const r = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: ganz ? "attemptBoth" : "dontInvert" });
    return r ? r.data : "";
  };
  return { erkennen, art: () => (detector ? "BarcodeDetector + jsQR" : "jsQR") };
}

// Aus Kamera- oder Handscanner-Text den Ticket-Code holen. Handscanner mit
// falschem Tastaturlayout machen aus "/" und ":" andere Zeichen – die 32 hex
// Zeichen des Codes bleiben aber gleich.
export function scanText(roh) {
  const m = String(roh || "").match(/(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i);
  return m ? m[1].toLowerCase() : String(roh || "").trim();
}

const KAMERA_KEY = "agelan-checkin-kamera";

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
        <div class="zeile klein leiser" style="justify-content:space-between"><span id="c-technik"></span>
          <select id="c-kameras" class="versteckt" style="width:auto;max-width:100%" title="Kamera wählen"></select></div>
        <p class="klein leise" style="margin:0">Handscanner: einfach scannen, ein Klick ins Suchfeld ist nicht nötig.</p>
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

  const suchen = async (roh) => {
    const eingabe = scanText(roh);
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
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Der Browser erlaubt hier keinen Kamerazugriff (nur über https).");
        let gewaehlt = "";
        try { gewaehlt = localStorage.getItem(KAMERA_KEY) || ""; } catch (e) { /* privat */ }
        const wunsch = { width: { ideal: 1280 }, height: { ideal: 720 } };
        try {
          s = await navigator.mediaDevices.getUserMedia({ video: gewaehlt ? { ...wunsch, deviceId: { exact: gewaehlt } } : { ...wunsch, facingMode: { ideal: "environment" } }, audio: false });
        } catch (e) {
          if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw e;
          s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); // ältere Geräte: ohne Wünsche
        }
      } catch (e) {
        throw new Error(e && e.name === "NotAllowedError"
          ? "Kamera-Zugriff wurde verweigert. Bitte in den Browser-Einstellungen für diese Seite erlauben."
          : "Kamera nicht verfügbar: " + (e && e.message));
      }
      if (veraltet()) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      // Dauer-Autofokus, wo das Gerät es kann (Android) – sonst bleibt der QR oft unscharf.
      try {
        const spur = s.getVideoTracks()[0];
        const kann = spur.getCapabilities ? spur.getCapabilities() : {};
        if (kann.focusMode && kann.focusMode.includes("continuous")) await spur.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      } catch (e) { /* egal */ }
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.srcObject = s;
      try { await video.play(); } catch (e) { throw new Error("Kamerabild lässt sich nicht abspielen: " + e.message); }
      if (veraltet()) return;
      const erkenner = await qrErkenner();
      if (veraltet()) return;
      laeuft = true;
      knopf.textContent = "Kamera stoppen";
      hinweis.textContent = "QR-Code in den Rahmen halten";
      $("#c-technik", main).textContent = `${erkenner.art()} · ${video.videoWidth}×${video.videoHeight}`;
      kamerasZeigen(s).catch(() => { /* Auswahl ist nur Komfort */ });
      const schleife = async () => {
        if (!laeuft || veraltet()) return;
        try {
          let text = "";
          if (video.readyState >= 2) text = await erkenner.erkennen(video, video.videoWidth, video.videoHeight);
          // Derselbe Code wird nicht erneut gesucht, solange seine Karte sichtbar ist.
          if (text && text !== angezeigt && !veraltet()) {
            angezeigt = text;
            if (navigator.vibrate) navigator.vibrate(80);
            await suchen(text);
            // Auf dem Handy steht das Ergebnis unter dem Kamerabild – hinscrollen.
            if (matchMedia("(max-width: 900px)").matches) ergebnis.scrollIntoView({ behavior: "smooth", block: "start" });
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
  // Mehrere Kameras (Laptop + USB-Webcam, Handy vorne/hinten): Auswahl anbieten.
  // Die Namen gibt der Browser erst nach der Kamera-Freigabe heraus.
  const auswahl = $("#c-kameras", main);
  const kamerasZeigen = async (s) => {
    const geraete = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    if (geraete.length < 2) { auswahl.classList.add("versteckt"); return; }
    const aktiv = (s.getVideoTracks()[0].getSettings() || {}).deviceId || "";
    auswahl.innerHTML = geraete.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === aktiv ? "selected" : ""}>${esc(d.label || "Kamera " + (i + 1))}</option>`).join("");
    auswahl.classList.remove("versteckt");
  };
  auswahl.onchange = async () => {
    try { localStorage.setItem(KAMERA_KEY, auswahl.value); } catch (e) { /* privat */ }
    if (laeuft) { stoppen(); knopf.click(); }
  };

  // ---- Handscanner ----
  // USB-/Bluetooth-Scanner tippen wie eine Tastatur, nur viel schneller als ein
  // Mensch, und schließen mit Enter ab. Schnelle Folge + Enter = Scan, egal wo
  // gerade der Cursor steht. Was der Scanner dabei in ein Feld getippt hat,
  // wird wieder entfernt.
  let puffer = "", zuletztTaste = 0, feld = null, feldVorher = "";
  const taste = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const jetzt = performance.now();
    if (e.key === "Enter" || e.key === "Tab") { // manche Scanner schließen mit Tab ab
      const schnell = puffer.length >= 16 && jetzt - zuletztTaste < 120;
      const text = puffer;
      puffer = "";
      if (!schnell) return;
      e.preventDefault();
      e.stopPropagation();
      if (feld && feld.isConnected) feld.value = feldVorher;
      angezeigt = "";
      suchen(text).then(() => { if (matchMedia("(max-width: 900px)").matches) ergebnis.scrollIntoView({ behavior: "smooth", block: "start" }); });
      return;
    }
    if (e.key.length !== 1) return; // Shift usw.
    if (jetzt - zuletztTaste > 60) {
      // neue Folge – merken, wie das Feld vorher aussah
      puffer = "";
      const a = document.activeElement;
      feld = a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") ? a : null;
      feldVorher = feld ? feld.value : "";
    }
    puffer += e.key;
    zuletztTaste = jetzt;
  };
  document.addEventListener("keydown", taste, true);

  beimVerlassen(() => { verlassen = true; laeuft = false; kameraStoppen(); document.removeEventListener("keydown", taste, true); }, main);
  if (param) { $("#c-suche", main).q.value = param; suchen(param); }
}
