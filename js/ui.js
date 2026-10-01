// Kleine UI-Helfer ohne Framework.

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function euro(cent) {
  const v = (Number(cent) || 0) / 100;
  return v.toLocaleString("de-DE", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + " €";
}

const MONATE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONATE_LANG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export function datum(iso) {
  if (!iso) return "";
  const [j, m, t] = String(iso).slice(0, 10).split("-").map(Number);
  return t + ". " + MONATE[m - 1] + " " + j;
}
export function zeitraum(start, ende) {
  if (!start) return "Termin folgt";
  const [j1, m1, t1] = start.split("-").map(Number);
  if (!ende) return t1 + ". " + MONATE_LANG[m1 - 1] + " " + j1;
  const [j2, m2, t2] = ende.split("-").map(Number);
  if (m1 === m2 && j1 === j2) return t1 + ".–" + t2 + ". " + MONATE_LANG[m1 - 1] + " " + j1;
  return t1 + ". " + MONATE_LANG[m1 - 1] + " – " + t2 + ". " + MONATE_LANG[m2 - 1] + " " + j2;
}
export function zeit(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export function newsDatum(iso) {
  const [j, m, t] = String(iso).split("-").map(Number);
  return { tag: String(t).padStart(2, "0"), monat: MONATE[m - 1], jahr: j };
}
export function codeGruppen(code) {
  return String(code || "").match(/.{1,4}/g)?.join(" / ") || "";
}

export function toast(text, art = "") {
  const t = el(`<div class="toast ${art}">${esc(text)}</div>`);
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), art === "fehler" ? 6000 : 3500);
}
export const fehler = (e) => toast(e && e.message ? e.message : String(e), "fehler");

export function modal(titel, inhaltHtml, { breit = false } = {}) {
  const hg = el(`<div class="modal-hg"><div class="modal ${breit ? "breit" : ""}" role="dialog" aria-modal="true">
    <div class="modal-kopf"><h3>${esc(titel)}</h3><button class="x" aria-label="Schließen">×</button></div>
    <div class="modal-inhalt"></div></div></div>`);
  const inhalt = $(".modal-inhalt", hg);
  if (typeof inhaltHtml === "string") inhalt.innerHTML = inhaltHtml; else inhalt.appendChild(inhaltHtml);
  const schliessen = () => { hg.remove(); document.removeEventListener("keydown", taste); };
  const taste = (e) => { if (e.key === "Escape") schliessen(); };
  hg.addEventListener("mousedown", (e) => { if (e.target === hg) schliessen(); });
  $(".x", hg).onclick = schliessen;
  document.addEventListener("keydown", taste);
  document.body.appendChild(hg);
  const erstes = $("input, select, textarea", inhalt);
  if (erstes) setTimeout(() => erstes.focus(), 30);
  return { el: inhalt, schliessen };
}

export function bestaetigen(text, { ja = "Ja", nein = "Abbrechen", gefahr = false } = {}) {
  return new Promise((ok) => {
    const m = modal("Bitte bestätigen", `<p>${esc(text)}</p><div class="zeile ende">
      <button class="knopf geist" data-n>${esc(nein)}</button><button class="knopf ${gefahr ? "rot" : "primaer"}" data-j>${esc(ja)}</button></div>`);
    $("[data-n]", m.el).onclick = () => { m.schliessen(); ok(false); };
    $("[data-j]", m.el).onclick = () => { m.schliessen(); ok(true); };
  });
}

// Formularfelder einsammeln (name → Wert; Checkboxen → bool)
export function formDaten(form) {
  const d = {};
  for (const f of form.elements) {
    if (!f.name) continue;
    if (f.type === "checkbox") d[f.name] = f.checked;
    else if (f.type === "radio") { if (f.checked) d[f.name] = f.value; }
    else d[f.name] = f.value;
  }
  return d;
}

// Knopf während einer Aktion sperren
export async function mitSperre(knopf, fn) {
  if (knopf.disabled) return;
  const alt = knopf.innerHTML;
  knopf.disabled = true;
  knopf.innerHTML = "…";
  try { return await fn(); } catch (e) { fehler(e); } finally { knopf.disabled = false; knopf.innerHTML = alt; }
}

// Der QR-Code auf dem Ticket ist ein Link auf die Ticket-Seite. Die Orga scannt ihn
// im Check-in, der Gast mit der Handy-Kamera (→ Status, nach dem Check-in Internet-Zugang).
export function ticketLink(code) {
  return location.origin + location.pathname + "#/t/" + code;
}

export function zugangHtml(z) {
  const feld = (label, wert, mono = true) => wert ? `<div class="zugang-feld"><span>${esc(label)}</span><b class="${mono ? "mono" : ""}">${esc(wert)}</b>
    <button class="knopf klein geist" data-kopieren="${esc(wert)}">Kopieren</button></div>` : "";
  return `<div class="karte glanz zugang"><span class="ueberzeile">Du bist eingecheckt</span><h2 style="margin:0 0 6px">🌐 Dein Internet-Zugang</h2>
    <p class="leise klein">${esc(z.hinweis)}</p>
    ${feld("WLAN", z.ssid, false)}${feld("WLAN-Passwort", z.wlanPasswort)}${feld("Benutzer", z.benutzer)}${feld("Passwort", z.passwort)}
    ${z.portal ? `<a class="knopf primaer" style="margin-top:12px" href="${esc(z.portal)}" target="_blank" rel="noopener">Zum Anmelde-Portal</a>` : ""}</div>`;
}

export function kopierenVerdrahten(root) {
  root.querySelectorAll("[data-kopieren]").forEach((b) => (b.onclick = () => {
    navigator.clipboard?.writeText(b.dataset.kopieren);
    toast("Kopiert.");
  }));
}

export function qrSvg(text) {
  if (!window.qrcode) return "";
  const qr = window.qrcode(0, "H");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// Drucken: Inhalt in #druck legen, Seitenformat setzen, drucken, aufräumen.
export function drucken(html, seitenformat = "A4") {
  const d = $("#druck");
  d.innerHTML = html + `<style>@page { size: ${seitenformat}; margin: ${seitenformat === "A4" ? "12mm" : "2mm"}; }</style>`;
  document.body.classList.add("druckt");
  const fertig = () => { document.body.classList.remove("druckt"); d.innerHTML = ""; window.removeEventListener("afterprint", fertig); };
  window.addEventListener("afterprint", fertig);
  // Bilder (Wappen) erst laden lassen
  setTimeout(() => window.print(), 150);
}
