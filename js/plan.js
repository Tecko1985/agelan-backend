// Sitzplan als SVG zeichnen – gemeinsam für die öffentliche Ansicht und den Editor.
import { esc } from "./ui.js?v=9";

export const U = 30; // Pixel je Rastereinheit (Zoom 1)

const STATUS_TEXT = { frei: "Frei", reserviert: "Reserviert (Zahlung offen)", belegt: "Belegt", gruppe: "Von Gruppe vorgemerkt", gesperrt: "Gesperrt" };

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

export function planSvg(plan, sitze, { zoom = 1, raster = false, klassen = () => "", extra = "", svgKlasse = "" } = {}) {
  const w = plan.breite * U, h = plan.hoehe * U;
  let linien = "";
  if (raster) {
    for (let i = 0; i <= plan.breite; i++) linien += `<line x1="${i * U}" y1="0" x2="${i * U}" y2="${h}"/>`;
    for (let i = 0; i <= plan.hoehe; i++) linien += `<line x1="0" y1="${i * U}" x2="${w}" y2="${i * U}"/>`;
  }
  return `<svg class="${svgKlasse}" xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 ${w + 12} ${h + 12}" width="${(w + 12) * zoom}" height="${(h + 12) * zoom}">
    <rect x="-6" y="-6" width="${w + 12}" height="${h + 12}" fill="transparent"></rect>
    ${raster ? `<g class="editor-raster">${linien}</g>` : `<rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="rgba(255,255,255,.015)" stroke="rgba(255,255,255,.06)"></rect>`}
    ${(plan.deko || []).map((d) => dekoSvg(d, klassen(d, true))).join("")}
    ${sitze.map((s) => sitzSvg(s, klassen(s, false))).join("")}
    ${extra}
  </svg>`;
}

// Kurzinfo zu einem Platz (Tooltip und Info-Zeile beim Antippen)
export function sitzInfo(s) {
  return `<b>Platz ${esc(s.label)}</b> · ${esc(STATUS_TEXT[s.status] || "")}${s.nick ? " · " + esc(s.nick) : ""}${s.gruppe ? " · " + esc(s.gruppe) : ""}${s.meins ? " · Dein Platz" : ""}`;
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
    tip.innerHTML = `<b>Platz ${esc(s.label)}</b><br><span class="leise">${esc(STATUS_TEXT[s.status] || "")}</span>
      ${s.nick ? `<br>${esc(s.nick)}` : ""}${s.gruppe ? `<br>${esc(s.gruppe)}` : ""}${s.meins ? "<br>Dein Platz" : ""}`;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 250) + "px";
    tip.style.top = e.clientY + 14 + "px";
    tip.classList.remove("versteckt");
  });
  container.addEventListener("pointerleave", () => tip.classList.add("versteckt"));
}

export function legendeHtml() {
  return `<div class="legende">
    <div><i class="l-frei"></i>Frei</div><div><i class="l-reserviert"></i>Reserviert (Zahlung offen)</div><div><i class="l-belegt"></i>Belegt</div>
    <div><i class="l-gruppe"></i>Von einer Gruppe vorgemerkt</div><div><i class="l-meinegruppe"></i>Meine Gruppe</div><div><i class="l-meins"></i>Mein Platz</div><div><i class="l-gesperrt"></i>Gesperrt</div></div>`;
}
