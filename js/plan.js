// Sitzplan als SVG zeichnen – gemeinsam für die öffentliche Ansicht und den Editor.
import { esc } from "./ui.js?v=68";

export const U = 30; // Pixel je Rastereinheit (Zoom 1)

const STATUS_TEXT = { frei: "Frei", belegt: "Belegt", gruppe: "Von Gruppe vorgemerkt", gesperrt: "Gesperrt", ausbau: "Noch nicht freigeschaltet" };
const statusText = (s) => (s.status === "ausbau" ? `Folgt in Stage ${s.stufe || 2}` : STATUS_TEXT[s.status] || "");

export function dekoSvg(d, klasse = "") {
  const x = d.x * U, y = d.y * U, w = d.w * U, h = d.h * U;
  return `<g class="deko t-${esc(d.typ)} f-${esc(d.farbe || "grau")} ${klasse}" data-deko="${esc(d.id)}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}"></rect>
    ${d.text ? `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${esc(d.text)}</text>` : ""}</g>`;
}

// teil: "oben"/"unten" = Hälfte eines Doppeltischs. Die beiden Plätze stoßen dann ohne
// Lücke aneinander und wirken wie ein Block; zwischen den Tischen bleibt die normale Lücke.
export function sitzSvg(s, klassen = "", teil = "") {
  // Tisch: beide Hälften berühren sich in der Mitte, zum nächsten Tisch bleiben 6 px Luft.
  const g = U - 4, h = teil ? U - 3 : g, oben = teil === "oben" ? s.y * U + 3 : teil === "unten" ? s.y * U : s.y * U + 2;
  return `<g class="sitz s-${esc(s.status || "frei")} ${s.meins ? "meins" : ""} ${s.meineGruppe && !s.meins ? "meinegruppe" : ""} ${klassen}"
      data-sitz="${esc(s.id)}" transform="translate(${s.x * U + 2},${oben})">
    <rect width="${g}" height="${h}" rx="5"></rect>
    <text x="${g / 2}" y="${h / 2 + 3}" text-anchor="middle">${esc(s.label)}</text></g>`;
}

// Fläche, die wirklich gebraucht wird: nie kleiner als alle Plätze und Flächen –
// sonst werden Plätze unten/rechts abgeschnitten, wenn die eingestellte Größe zu klein ist.
export function planGroesse(plan, sitze) {
  const deko = plan.deko || [];
  return {
    breite: Math.ceil(Math.max(plan.breite || 0, ...sitze.map((s) => s.x + 1), ...deko.map((d) => d.x + d.w))),
    hoehe: Math.ceil(Math.max(plan.hoehe || 0, ...sitze.map((s) => s.y + 1), ...deko.map((d) => d.y + d.h))),
  };
}

// Doppeltische: zwei Plätze derselben Reihe mit den Nummern 1+2, 3+4, … die direkt
// untereinander liegen (A1 über A2). Liefert id -> "oben" | "unten".
export function tischTeile(sitze) {
  const teile = new Map();
  const nachName = new Map(sitze.map((s) => [String(s.label).toUpperCase(), s]));
  for (const s of sitze) {
    const m = String(s.label).toUpperCase().match(/^(.*?)(\d+)$/);
    if (!m || Number(m[2]) % 2 !== 1) continue;
    const partner = nachName.get(m[1] + (Number(m[2]) + 1));
    if (partner && Math.abs(partner.x - s.x) < 0.01 && Math.abs(partner.y - s.y - 1) < 0.01) {
      teile.set(s.id, "oben"); teile.set(partner.id, "unten");
    }
  }
  return teile;
}

export function planSvg(plan, sitze, { zoom = 1, raster = false, klassen = () => "", extra = "", svgKlasse = "" } = {}) {
  const g = planGroesse(plan, sitze);
  const w = g.breite * U, h = g.hoehe * U;
  let linien = "";
  if (raster) {
    for (let i = 0; i <= g.breite; i++) linien += `<line x1="${i * U}" y1="0" x2="${i * U}" y2="${h}"/>`;
    for (let i = 0; i <= g.hoehe; i++) linien += `<line x1="0" y1="${i * U}" x2="${w}" y2="${i * U}"/>`;
  }
  return `<svg class="${svgKlasse}" xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 ${w + 12} ${h + 12}" width="${(w + 12) * zoom}" height="${(h + 12) * zoom}">
    <rect x="-6" y="-6" width="${w + 12}" height="${h + 12}" fill="transparent"></rect>
    ${raster ? `<g class="editor-raster">${linien}</g>` : `<rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="rgba(255,255,255,.015)" stroke="rgba(255,255,255,.06)"></rect>`}
    ${(plan.deko || []).map((d) => dekoSvg(d, klassen(d, true))).join("")}
    ${(() => { const teile = tischTeile(sitze); return sitze.map((s) => sitzSvg(s, klassen(s, false), teile.get(s.id) || "")).join(""); })()}
    ${extra}
  </svg>`;
}

// Kurzinfo zu einem Platz (Tooltip und Info-Zeile beim Antippen)
export function sitzInfo(s) {
  return `<b>Platz ${esc(s.label)}</b> · ${esc(STATUS_TEXT[s.status] || "")}${s.nick ? " · " + esc(s.nick) : ""}${s.gruppe ? " · " + esc(s.gruppe) : ""}${s.meins ? " · Dein Platz" : ""}`;
}

// Große Info-Karte über dem Plan: Platz, wer dort sitzt, Status, Gruppe.
const STATUS_FARBE = { frei: "gruen", belegt: "rot", gruppe: "blau", gesperrt: "", ausbau: "" };
const STATUS_KURZ = { frei: "Frei", belegt: "Belegt", gruppe: "Von Gruppe vorgemerkt", gesperrt: "Gesperrt" };
export function sitzKarte(s) {
  if (!s) return `<div class="platz-karte leer"><span class="leise">Fahre über einen Platz oder tippe ihn an – hier steht dann, wer dort sitzt.</span></div>`;
  const wer = s.meins ? "Dein Platz" : s.nick || (s.status === "frei" ? "Noch frei" : s.status === "gruppe" ? "Vorgemerkt" : s.status === "gesperrt" ? "Nicht buchbar" : s.status === "ausbau" ? "Kommt später dazu" : "Vergeben");
  return `<div class="platz-karte s-${esc(s.status || "frei")}${s.meins ? " meins" : ""}">
    <div class="pk-sitz">${esc(s.label)}</div>
    <div class="pk-text"><div class="pk-nick">${esc(wer)}</div>
      <div class="pk-meta"><span class="abzeichen ${STATUS_FARBE[s.status] || ""}">${esc(s.status === "ausbau" ? statusText(s) : STATUS_KURZ[s.status] || "")}</span>${s.gruppe ? `<span class="pk-gruppe">Gruppe <b>${esc(s.gruppe)}</b></span>` : ""}</div></div></div>`;
}

// Tooltip beim Überfahren eines Sitzes
export function tooltipAnbinden(container, sitzVonId) {
  let tip = document.querySelector(".plan-tooltip");
  if (!tip) { tip = document.createElement("div"); tip.className = "plan-tooltip versteckt"; document.body.appendChild(tip); }
  container.addEventListener("pointermove", (e) => {
    const g = e.target.closest("[data-sitz]");
    if (!g || e.pointerType === "touch") { tip.classList.add("versteckt"); return; }
    const s = sitzVonId(g.dataset.sitz);
    if (!s) return;
    tip.innerHTML = `<div class="tip-kopf"><b class="tip-sitz">${esc(s.label)}</b>${s.nick ? `<span class="tip-nick">${esc(s.nick)}</span>` : ""}</div>
      <span class="leise">${esc(statusText(s))}</span>${s.gruppe ? `<br>Gruppe ${esc(s.gruppe)}` : ""}${s.meins ? "<br><b>Dein Platz</b>" : ""}`;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 250) + "px";
    tip.style.top = e.clientY + 14 + "px";
    tip.classList.remove("versteckt");
  });
  container.addEventListener("pointerleave", () => tip.classList.add("versteckt"));
}

export function legendeHtml(mitAusbau = false) {
  return `<div class="legende">${mitAusbau ? `<div><i class="l-ausbau"></i>Folgt in einer späteren Stage</div>` : ""}
    <div><i class="l-frei"></i>Frei</div><div><i class="l-belegt"></i>Belegt</div><div><i class="l-tisch"></i>Doppeltisch – zusammenhängende Plätze (A1 + A2)</div>
    <div><i class="l-gruppe"></i>Von einer Gruppe vorgemerkt</div><div><i class="l-meinegruppe"></i>Meine Gruppe</div><div><i class="l-meins"></i>Mein Platz</div><div><i class="l-gesperrt"></i>Gesperrt</div></div>`;
}
