// Sitzplan als SVG zeichnen – gemeinsam für die öffentliche Ansicht und den Editor.
import { esc } from "./ui.js?v=40";

export const U = 30; // Pixel je Rastereinheit (Zoom 1)

const STATUS_TEXT = { frei: "Frei", belegt: "Belegt", gruppe: "Von Gruppe vorgemerkt", gesperrt: "Gesperrt" };

export function dekoSvg(d, klasse = "") {
  const x = d.x * U, y = d.y * U, w = d.w * U, h = d.h * U;
  return `<g class="deko t-${esc(d.typ)} f-${esc(d.farbe || "grau")} ${klasse}" data-deko="${esc(d.id)}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}"></rect>
    ${d.text ? `<text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${esc(d.text)}</text>` : ""}</g>`;
}

export function sitzSvg(s, klassen = "") {
  const g = U - 4;
  return `<g class="sitz s-${esc(s.status || "frei")} ${s.meins ? "meins" : ""} ${s.meineGruppe && !s.meins ? "meinegruppe" : ""} ${klassen}"
      data-sitz="${esc(s.id)}" transform="translate(${s.x * U + 2},${s.y * U + 2})">
    <rect width="${g}" height="${g}" rx="5"></rect>
    <text x="${g / 2}" y="${g / 2 + 3}" text-anchor="middle">${esc(s.label)}</text></g>`;
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

// Doppeltische: Je zwei direkt nebeneinander liegende Plätze bilden einen Tisch;
// untereinander liegende Tische derselben Spalten werden zu einer Tischreihe verbunden.
export function tischeSvg(sitze) {
  const reihen = new Map();
  for (const s of sitze) { const k = s.y; if (!reihen.has(k)) reihen.set(k, []); reihen.get(k).push(s); }
  const paare = [];
  for (const [y, liste] of reihen) {
    liste.sort((a, b) => a.x - b.x);
    for (let i = 0; i < liste.length - 1; i++) {
      if (Math.abs(liste[i + 1].x - liste[i].x - 1) < 0.01) { paare.push({ x: liste[i].x, y }); i++; }
    }
  }
  // senkrecht zusammenhängende Paare (gleiche Spalten) zu einem Tisch zusammenfassen
  paare.sort((a, b) => a.x - b.x || a.y - b.y);
  const tische = [];
  for (const p of paare) {
    const t = tische.find((t) => Math.abs(t.x - p.x) < 0.01 && Math.abs(t.bis + 1 - p.y) < 0.01);
    if (t) t.bis = p.y; else tische.push({ x: p.x, von: p.y, bis: p.y });
  }
  return tische.map((t) => {
    const x = t.x * U - 4, y = t.von * U - 4, w = 2 * U + 8, h = (t.bis - t.von + 1) * U + 8;
    return `<g class="tisch"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"></rect><line x1="${x + w / 2}" y1="${y + 4}" x2="${x + w / 2}" y2="${y + h - 4}"></line></g>`;
  }).join("");
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
    ${tischeSvg(sitze)}
    ${sitze.map((s) => sitzSvg(s, klassen(s, false))).join("")}
    ${extra}
  </svg>`;
}

// Kurzinfo zu einem Platz (Tooltip und Info-Zeile beim Antippen)
export function sitzInfo(s) {
  return `<b>Platz ${esc(s.label)}</b> · ${esc(STATUS_TEXT[s.status] || "")}${s.nick ? " · " + esc(s.nick) : ""}${s.gruppe ? " · " + esc(s.gruppe) : ""}${s.meins ? " · Dein Platz" : ""}`;
}

// Große Info-Karte über dem Plan: Platz, wer dort sitzt, Status, Gruppe.
const STATUS_FARBE = { frei: "gruen", belegt: "rot", gruppe: "blau", gesperrt: "" };
const STATUS_KURZ = { frei: "Frei", belegt: "Belegt", gruppe: "Von Gruppe vorgemerkt", gesperrt: "Gesperrt" };
export function sitzKarte(s) {
  if (!s) return `<div class="platz-karte leer"><span class="leise">Fahre über einen Platz oder tippe ihn an – hier steht dann, wer dort sitzt.</span></div>`;
  const wer = s.meins ? "Dein Platz" : s.nick || (s.status === "frei" ? "Noch frei" : s.status === "gruppe" ? "Vorgemerkt" : s.status === "gesperrt" ? "Nicht buchbar" : "Vergeben");
  return `<div class="platz-karte s-${esc(s.status || "frei")}${s.meins ? " meins" : ""}">
    <div class="pk-sitz">${esc(s.label)}</div>
    <div class="pk-text"><div class="pk-nick">${esc(wer)}</div>
      <div class="pk-meta"><span class="abzeichen ${STATUS_FARBE[s.status] || ""}">${esc(STATUS_KURZ[s.status] || "")}</span>${s.gruppe ? `<span class="pk-gruppe">Gruppe <b>${esc(s.gruppe)}</b></span>` : ""}</div></div></div>`;
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
      <span class="leise">${esc(STATUS_TEXT[s.status] || "")}</span>${s.gruppe ? `<br>Gruppe ${esc(s.gruppe)}` : ""}${s.meins ? "<br><b>Dein Platz</b>" : ""}`;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 250) + "px";
    tip.style.top = e.clientY + 14 + "px";
    tip.classList.remove("versteckt");
  });
  container.addEventListener("pointerleave", () => tip.classList.add("versteckt"));
}

export function legendeHtml() {
  return `<div class="legende">
    <div><i class="l-frei"></i>Frei</div><div><i class="l-belegt"></i>Belegt</div><div><i class="l-tisch"></i>Doppeltisch (zwei Plätze gegenüber)</div>
    <div><i class="l-gruppe"></i>Von einer Gruppe vorgemerkt</div><div><i class="l-meinegruppe"></i>Meine Gruppe</div><div><i class="l-meins"></i>Mein Platz</div><div><i class="l-gesperrt"></i>Gesperrt</div></div>`;
}
