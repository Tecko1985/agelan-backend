// Sitzplan-Editor: Plätze setzen, Blöcke einfügen, verschieben, umbenennen,
// sperren, Flächen/Texte/Wände zeichnen. Gespeichert wird der ganze Plan.
import { api } from "./api.js?v=35";
import { esc, $, $$, toast, fehler, modal, bestaetigen, mitSperre, formDaten } from "./ui.js?v=35";
import { planSvg, U } from "./plan.js?v=35";
import { beimVerlassen, vorVerlassen } from "./app.js?v=35";

const WERKZEUGE = [
  ["auswahl", "↖ Auswählen", "Klicken/Ziehen wählt aus, gewählte Elemente ziehen verschiebt sie"],
  ["setzen", "＋ Platz", "Klicken oder Ziehen setzt einzelne Plätze"],
  ["block", "▦ Block", "Klicke dorthin, wo ein Tischblock beginnen soll"],
  ["flaeche", "▭ Fläche", "Rechteck ziehen: Bühne, Catering, Eingang …"],
  ["text", "T Text", "Rechteck ziehen für eine Beschriftung"],
  ["wand", "▬ Wand", "Rechteck ziehen für Wände und Säulen"],
];
const FARBEN = ["grau", "gold", "rot", "gruen", "blau"];
const neueId = () => Math.random().toString(36).slice(2, 11);

// Der gerade offene Editor (höchstens einer): für die Rückfrage bei ungespeicherten
// Änderungen und zum Abbau der Listener an window/document.
let offen = null;

export async function verlassenErlaubt() {
  if (!offen || !offen.st.geaendert || !offen.container.isConnected) return true;
  return bestaetigen("Der Sitzplan hat ungespeicherte Änderungen. Trotzdem verlassen und die Änderungen verwerfen?", { ja: "Verwerfen", gefahr: true });
}

export function schliessen() {
  if (offen) offen.abbau();
}

export async function editor(container, lanId) {
  schliessen();
  const daten = await api("sitzplan", { lanId });
  if (!container.isConnected) return;
  schliessen();
  const st = {
    plan: { breite: daten.plan.breite, hoehe: daten.plan.hoehe, deko: (daten.plan.deko || []).map((d) => ({ ...d })) },
    sitze: daten.sitze.map((s) => ({ id: s.id, label: s.label, x: s.x, y: s.y, gesperrt: s.gesperrt != null ? s.gesperrt : s.status === "gesperrt", belegt: s.status === "belegt" || s.status === "reserviert", nick: s.nick })),
    auswahl: new Set(), werkzeug: "auswahl", zoom: 1, verlauf: [], geaendert: false,
  };
  const ac = new AbortController();
  const ich = {
    st, container,
    abbau: () => {
      ac.abort();
      if (offen === ich) { offen = null; vorVerlassen(null); }
    },
  };
  offen = ich;
  vorVerlassen(verlassenErlaubt);
  // Neu laden/Tab schließen mit ungespeicherten Änderungen: Browser fragt nach.
  window.addEventListener("beforeunload", (e) => { if (st.geaendert) { e.preventDefault(); e.returnValue = ""; } }, { signal: ac.signal });

  container.innerHTML = `
    <div class="editor-leiste">
      <div class="gruppe">${WERKZEUGE.map(([k, l, t]) => `<button class="werkzeug" data-w="${k}" title="${esc(t)}">${l}</button>`).join("")}</div>
      <div class="gruppe"><button class="werkzeug" data-a="undo" title="Rückgängig (Strg+Z)">↶</button><button class="werkzeug" data-a="alle" title="Alles auswählen">Alle</button>
        <button class="werkzeug" data-a="zoom-" title="Verkleinern">−</button><button class="werkzeug" data-a="zoom+" title="Vergrößern">+</button></div>
      <div class="gruppe"><label class="klein leise">Breite <input data-gr="breite" type="number" min="4" max="200" style="width:64px;padding:5px"></label>
        <label class="klein leise">Höhe <input data-gr="hoehe" type="number" min="4" max="200" style="width:64px;padding:5px"></label></div>
      <div class="gruppe"><button class="knopf klein primaer" data-a="speichern">Speichern</button><button class="knopf klein geist" data-a="verwerfen">Verwerfen</button></div>
    </div>
    <div class="plan-layout">
      <div class="plan-buehne" id="e-buehne" style="max-height:72vh"></div>
      <aside class="stapel"><div class="karte" id="e-eigenschaften"></div>
        <div class="karte klein leise"><b style="color:var(--text)">Tipps</b><br>Shift+Klick: Auswahl erweitern · Pfeiltasten: verschieben · Entf: löschen · Strg+Z: rückgängig.
          Vergebene Plätze (rot umrandet in der Liste) lassen sich verschieben und umbenennen, aber nicht löschen.</div></aside>
    </div>`;
  const buehne = $("#e-buehne", container);
  $$("[data-gr]", container).forEach((i) => { i.value = st.plan[i.dataset.gr]; });

  const merken = () => {
    st.verlauf.push(JSON.stringify({ plan: st.plan, sitze: st.sitze }));
    if (st.verlauf.length > 60) st.verlauf.shift();
    st.geaendert = true;
  };
  const elementVon = (id) => st.sitze.find((s) => s.id === id) || st.plan.deko.find((d) => d.id === id);

  let vorschau = ""; // Gummiband/Rechteck während des Ziehens
  const zeichnen = () => {
    const sitzeAnsicht = st.sitze.map((s) => ({ ...s, status: s.gesperrt ? "gesperrt" : s.belegt ? "belegt" : "frei" }));
    buehne.innerHTML = planSvg(st.plan, sitzeAnsicht, {
      zoom: st.zoom, raster: true, svgKlasse: "editor-svg w-" + st.werkzeug, extra: vorschau,
      klassen: (x) => (st.auswahl.has(x.id) ? "gewaehlt" : ""),
    });
    $$("[data-w]", container).forEach((b) => b.classList.toggle("an", b.dataset.w === st.werkzeug));
    eigenschaften();
  };

  // ---- Koordinaten ----
  const punkt = (e) => {
    const svg = $("svg", buehne);
    const p = svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    return { x: q.x / U, y: q.y / U };
  };
  const zelleFrei = (x, y, ohne = new Set()) => !st.sitze.some((s) => !ohne.has(s.id) && Math.abs(s.x - x) < 0.9 && Math.abs(s.y - y) < 0.9);

  const naechsterName = () => {
    const nums = st.sitze.map((s) => s.label.match(/^P(\d+)$/)).filter(Boolean).map((m) => Number(m[1]));
    return "P" + ((nums.length ? Math.max(...nums) : 0) + 1);
  };

  // ---- Maus/Touch ----
  let zug = null;
  buehne.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = punkt(e);
    const ziel = e.target.closest("[data-sitz],[data-deko]");
    const zielId = ziel ? ziel.dataset.sitz || ziel.dataset.deko : null;
    e.preventDefault();
    if (st.werkzeug === "auswahl") {
      if (zielId) {
        if (e.shiftKey) { st.auswahl.has(zielId) ? st.auswahl.delete(zielId) : st.auswahl.add(zielId); zeichnen(); return; }
        if (!st.auswahl.has(zielId)) { st.auswahl = new Set([zielId]); }
        const start = [...st.auswahl].map((id) => { const el = elementVon(id); return el ? { el, x: el.x, y: el.y } : null; }).filter(Boolean);
        zug = { art: "schieben", p0: p, start, bewegt: false };
      } else {
        if (!e.shiftKey) st.auswahl.clear();
        zug = { art: "band", p0: p, p1: p };
      }
      zeichnen();
    } else if (st.werkzeug === "setzen") {
      merken();
      zug = { art: "malen" };
      setzenBei(p);
    } else if (st.werkzeug === "block") {
      blockDialog(Math.floor(p.x), Math.floor(p.y));
    } else {
      zug = { art: "rechteck", p0: p, p1: p };
    }
  });

  const setzenBei = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= st.plan.breite || y >= st.plan.hoehe || !zelleFrei(x, y)) return;
    st.sitze.push({ id: neueId(), label: naechsterName(), x, y, gesperrt: false, belegt: false });
    zeichnen();
  };

  const rechteckSvg = (a, b) => {
    const x = Math.min(a.x, b.x) * U, y = Math.min(a.y, b.y) * U, w = Math.abs(a.x - b.x) * U, h = Math.abs(a.y - b.y) * U;
    return `<rect class="auswahl-rahmen" x="${x}" y="${y}" width="${w}" height="${h}"></rect>`;
  };

  window.addEventListener("pointermove", (e) => {
    if (!zug || !buehne.isConnected) return;
    const p = punkt(e);
    if (zug.art === "schieben") {
      const dx = Math.round((p.x - zug.p0.x) * 2) / 2, dy = Math.round((p.y - zug.p0.y) * 2) / 2;
      if (!zug.bewegt && (dx || dy)) { merken(); zug.bewegt = true; }
      zug.start.forEach((s) => { s.el.x = Math.max(0, s.x + dx); s.el.y = Math.max(0, s.y + dy); });
      zeichnen();
    } else if (zug.art === "malen") {
      setzenBei(p);
    } else if (zug.art === "band" || zug.art === "rechteck") {
      zug.p1 = p;
      vorschau = rechteckSvg(zug.p0, zug.p1);
      zeichnen();
    }
  }, { signal: ac.signal });

  window.addEventListener("pointerup", () => {
    if (!zug || !buehne.isConnected) { zug = null; return; }
    const z = zug; zug = null; vorschau = "";
    if (z.art === "band") {
      const x1 = Math.min(z.p0.x, z.p1.x), x2 = Math.max(z.p0.x, z.p1.x), y1 = Math.min(z.p0.y, z.p1.y), y2 = Math.max(z.p0.y, z.p1.y);
      if (x2 - x1 > 0.2 || y2 - y1 > 0.2) {
        st.sitze.forEach((s) => { if (s.x + 0.5 >= x1 && s.x + 0.5 <= x2 && s.y + 0.5 >= y1 && s.y + 0.5 <= y2) st.auswahl.add(s.id); });
        st.plan.deko.forEach((d) => { if (d.x >= x1 && d.x + d.w <= x2 && d.y >= y1 && d.y + d.h <= y2) st.auswahl.add(d.id); });
      }
      zeichnen();
    } else if (z.art === "rechteck") {
      const r = (v) => Math.round(v * 2) / 2;
      const x = r(Math.min(z.p0.x, z.p1.x)), y = r(Math.min(z.p0.y, z.p1.y));
      let w = r(Math.abs(z.p0.x - z.p1.x)), h = r(Math.abs(z.p0.y - z.p1.y));
      if (w < 0.5) w = st.werkzeug === "wand" ? 0.5 : 3;
      if (h < 0.5) h = st.werkzeug === "wand" ? 0.5 : 1;
      merken();
      const d = { id: neueId(), typ: st.werkzeug, x, y, w, h, text: st.werkzeug === "wand" ? "" : st.werkzeug === "text" ? "Text" : "Bereich", farbe: st.werkzeug === "flaeche" ? "gold" : "grau" };
      st.plan.deko.push(d);
      st.auswahl = new Set([d.id]);
      st.werkzeug = "auswahl";
      zeichnen();
      const feld = $("#e-eigenschaften [name=text]", container);
      if (feld) { feld.focus(); feld.select(); }
    } else zeichnen();
  }, { signal: ac.signal });

  // ---- Tastatur ----
  const taste = (e) => {
    if (!buehne.isConnected) { ich.abbau(); return; }
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector(".modal-hg")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); rueckgaengig(); return; }
    if (!st.auswahl.size) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); loeschen(); return; }
    if (e.key === "Escape") { st.auswahl.clear(); zeichnen(); return; }
    const schritt = e.shiftKey ? 1 : 0.5;
    const d = { ArrowLeft: [-schritt, 0], ArrowRight: [schritt, 0], ArrowUp: [0, -schritt], ArrowDown: [0, schritt] }[e.key];
    if (d) {
      e.preventDefault(); merken();
      st.auswahl.forEach((id) => { const el = elementVon(id); if (el) { el.x = Math.max(0, el.x + d[0]); el.y = Math.max(0, el.y + d[1]); } });
      zeichnen();
    }
  };
  document.addEventListener("keydown", taste, { signal: ac.signal });

  const rueckgaengig = () => {
    const alt = st.verlauf.pop();
    if (!alt) return;
    const o = JSON.parse(alt);
    st.plan = o.plan; st.sitze = o.sitze;
    st.auswahl = new Set([...st.auswahl].filter((id) => elementVon(id)));
    zeichnen();
  };

  const loeschen = () => {
    const belegt = st.sitze.filter((s) => st.auswahl.has(s.id) && s.belegt);
    if (belegt.length) toast("Vergebene Plätze bleiben stehen: " + belegt.map((s) => s.label).join(", "), "fehler");
    merken();
    st.sitze = st.sitze.filter((s) => !st.auswahl.has(s.id) || s.belegt);
    st.plan.deko = st.plan.deko.filter((d) => !st.auswahl.has(d.id));
    st.auswahl.clear();
    zeichnen();
  };

  // ---- Eigenschaften-Leiste ----
  const eigenschaften = () => {
    const box = $("#e-eigenschaften", container);
    const sitze = st.sitze.filter((s) => st.auswahl.has(s.id));
    const deko = st.plan.deko.filter((d) => st.auswahl.has(d.id));
    const alle = st.sitze.length, gesperrt = st.sitze.filter((s) => s.gesperrt).length;
    if (!sitze.length && !deko.length) {
      box.innerHTML = `<h3>Plan</h3><dl class="daten-liste"><dt>Plätze</dt><dd><b>${alle}</b> (${alle - gesperrt} buchbar)</dd><dt>Vergeben</dt><dd>${st.sitze.filter((s) => s.belegt).length}</dd>
        <dt>Elemente</dt><dd>${st.plan.deko.length}</dd></dl><p class="klein leise" style="margin-top:10px">Nichts ausgewählt. ${st.geaendert ? `<b class="gold">Ungespeicherte Änderungen.</b>` : ""}</p>`;
      return;
    }
    if (deko.length === 1 && !sitze.length) {
      const d = deko[0];
      box.innerHTML = `<h3>${d.typ === "wand" ? "Wand" : d.typ === "text" ? "Text" : "Fläche"}</h3><div class="formular">
        <label class="feld"><span>Beschriftung</span><input name="text" value="${esc(d.text)}" maxlength="60"></label>
        <label class="feld"><span>Art</span><select name="typ">${[["flaeche", "Fläche"], ["text", "Nur Text"], ["wand", "Wand"]].map(([k, l]) => `<option value="${k}" ${d.typ === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="feld"><span>Farbe</span><select name="farbe">${FARBEN.map((f) => `<option ${d.farbe === f ? "selected" : ""}>${f}</option>`).join("")}</select></label>
        <div class="zwei"><label class="feld"><span>Breite</span><input name="w" type="number" step="0.5" min="0.5" value="${d.w}"></label><label class="feld"><span>Höhe</span><input name="h" type="number" step="0.5" min="0.5" value="${d.h}"></label></div>
        <button class="knopf klein rot" data-loeschen>Löschen</button></div>`;
      $$("input, select", box).forEach((i) => (i.onchange = () => {
        merken();
        d[i.name] = i.type === "number" ? Math.max(0.5, Number(i.value) || 1) : i.value;
        zeichnen();
      }));
      $("[data-loeschen]", box).onclick = loeschen;
      return;
    }
    if (sitze.length === 1 && !deko.length) {
      const s = sitze[0];
      box.innerHTML = `<h3>Platz ${esc(s.label)}</h3><div class="formular">
        ${s.belegt ? `<div class="abzeichen rot">Vergeben${s.nick ? " an " + esc(s.nick) : ""}</div>` : ""}
        <label class="feld"><span>Name</span><input name="label" value="${esc(s.label)}" maxlength="12"></label>
        <label class="check"><input type="checkbox" name="gesperrt" ${s.gesperrt ? "checked" : ""}> Gesperrt (nicht buchbar)</label>
        <div class="klein leise">Position: ${s.x} / ${s.y}</div>
        ${s.belegt ? "" : `<button class="knopf klein rot" data-loeschen>Löschen</button>`}</div>`;
      const lab = $("[name=label]", box);
      lab.onchange = () => {
        const v = lab.value.trim();
        if (!v) { lab.value = s.label; return; }
        if (st.sitze.some((x) => x !== s && x.label.toLowerCase() === v.toLowerCase())) { toast("„" + v + "“ gibt es schon.", "fehler"); lab.value = s.label; return; }
        merken(); s.label = v; zeichnen();
      };
      $("[name=gesperrt]", box).onchange = (e) => { merken(); s.gesperrt = e.target.checked; zeichnen(); };
      const l = $("[data-loeschen]", box); if (l) l.onclick = loeschen;
      return;
    }
    box.innerHTML = `<h3>${sitze.length} Plätze${deko.length ? " + " + deko.length + " Elemente" : ""}</h3><div class="stapel">
      ${sitze.length ? `<button class="knopf klein voll" data-nummer>🔢 Neu benennen …</button>
        <div class="zeile"><button class="knopf klein" data-sperren="1">Sperren</button><button class="knopf klein" data-sperren="0">Entsperren</button></div>
        <button class="knopf klein voll" data-kopie>⧉ Duplizieren (rechts daneben)</button>` : ""}
      <button class="knopf klein rot voll" data-loeschen>Löschen</button></div>`;
    $("[data-loeschen]", box).onclick = loeschen;
    $$("[data-sperren]", box).forEach((b) => (b.onclick = () => { merken(); sitze.forEach((s) => (s.gesperrt = b.dataset.sperren === "1")); zeichnen(); }));
    const nr = $("[data-nummer]", box); if (nr) nr.onclick = () => nummerDialog(sitze);
    const kp = $("[data-kopie]", box); if (kp) kp.onclick = () => duplizieren(sitze);
  };

  // ---- Dialoge ----
  const buchstabe = (start, i) => {
    const code = start.toUpperCase().charCodeAt(0) - 65 + i;
    return (code >= 26 ? String.fromCharCode(65 + Math.floor(code / 26) - 1) : "") + String.fromCharCode(65 + (code % 26));
  };

  const blockDialog = (x0, y0) => {
    const m = modal("Tischblock einfügen", `<form class="formular">
      <p class="klein leise">Beginnt bei Feld ${x0} / ${y0}. Jede Spalte bekommt einen Buchstaben, jede Reihe eine Nummer – wie A1, A2, B1 …</p>
      <div class="zwei"><label class="feld"><span>Spalten (Plätze nebeneinander)</span><input name="spalten" type="number" min="1" max="60" value="2"></label>
        <label class="feld"><span>Reihen</span><input name="reihen" type="number" min="1" max="100" value="12"></label></div>
      <div class="zwei"><label class="feld"><span>Erster Buchstabe</span><input name="buchstabe" maxlength="1" value="${buchstabe("A", new Set(st.sitze.map((s) => s.label.replace(/\d+$/, ""))).size)}"></label>
        <label class="feld"><span>Erste Nummer</span><input name="nummer" type="number" min="0" value="1"></label></div>
      <div class="zwei"><label class="feld"><span>Plätze je Tischgruppe</span><input name="gruppe" type="number" min="1" max="20" value="2"></label>
        <label class="feld"><span>Abstand zwischen Tischgruppen</span><input name="abstand" type="number" min="0" max="10" step="0.5" value="1"></label></div>
      <label class="check"><input type="checkbox" name="umgekehrt"> Nummern von unten nach oben</label>
      <div class="fehler-text"></div><button class="knopf primaer">Einfügen</button></form>`);
    const f = $("form", m.el);
    f.onsubmit = (e) => {
      e.preventDefault();
      const d = formDaten(f);
      const spalten = Number(d.spalten), reihen = Number(d.reihen), gr = Number(d.gruppe) || spalten, abst = Number(d.abstand) || 0;
      const neu = [];
      for (let c = 0; c < spalten; c++) {
        const x = x0 + c + Math.floor(c / gr) * abst;
        for (let r = 0; r < reihen; r++) {
          const nr = Number(d.nummer) + (d.umgekehrt ? reihen - 1 - r : r);
          neu.push({ id: neueId(), label: buchstabe(d.buchstabe || "A", c) + nr, x, y: y0 + r, gesperrt: false, belegt: false });
        }
      }
      const vorhanden = new Set(st.sitze.map((s) => s.label.toLowerCase()));
      const doppelt = neu.filter((s) => vorhanden.has(s.label.toLowerCase()));
      if (doppelt.length) { $(".fehler-text", f).textContent = "Diese Namen gibt es schon: " + doppelt.slice(0, 8).map((s) => s.label).join(", ") + (doppelt.length > 8 ? " …" : ""); return; }
      const kollision = neu.filter((s) => !zelleFrei(s.x, s.y));
      if (kollision.length) { $(".fehler-text", f).textContent = "Dort stehen schon Plätze – andere Stelle wählen."; return; }
      merken();
      st.sitze.push(...neu);
      const maxX = Math.max(...neu.map((s) => s.x)) + 2, maxY = Math.max(...neu.map((s) => s.y)) + 2;
      st.plan.breite = Math.max(st.plan.breite, maxX); st.plan.hoehe = Math.max(st.plan.hoehe, maxY);
      $$("[data-gr]", container).forEach((i) => { i.value = st.plan[i.dataset.gr]; });
      st.auswahl = new Set(neu.map((s) => s.id));
      st.werkzeug = "auswahl";
      m.schliessen();
      zeichnen();
    };
  };

  const nummerDialog = (sitze) => {
    const m = modal("Plätze neu benennen", `<form class="formular">
      <label class="feld"><span>Schema</span><select name="schema">
        <option value="raster">Buchstabe je Spalte + Nummer je Reihe (A1, A2, B1 …)</option>
        <option value="fortlaufend">Präfix + fortlaufende Nummer (P1, P2, P3 …)</option></select></label>
      <div class="zwei"><label class="feld"><span>Erster Buchstabe / Präfix</span><input name="praefix" value="A" maxlength="6"></label>
        <label class="feld"><span>Erste Nummer</span><input name="start" type="number" value="1"></label></div>
      <div class="fehler-text"></div><button class="knopf primaer">Umbenennen</button></form>`);
    const f = $("form", m.el);
    f.onsubmit = (e) => {
      e.preventDefault();
      const d = formDaten(f);
      const start = Number(d.start) || 0;
      const neu = new Map();
      if (d.schema === "raster") {
        const xs = [...new Set(sitze.map((s) => s.x))].sort((a, b) => a - b);
        const ys = [...new Set(sitze.map((s) => s.y))].sort((a, b) => a - b);
        sitze.forEach((s) => neu.set(s, buchstabe(d.praefix || "A", xs.indexOf(s.x)) + (start + ys.indexOf(s.y))));
      } else {
        [...sitze].sort((a, b) => a.y - b.y || a.x - b.x).forEach((s, i) => neu.set(s, (d.praefix || "") + (start + i)));
      }
      const andere = new Set(st.sitze.filter((s) => !neu.has(s)).map((s) => s.label.toLowerCase()));
      const doppelt = [...neu.values()].filter((l) => andere.has(l.toLowerCase()));
      if (doppelt.length) { $(".fehler-text", f).textContent = "Kollidiert mit vorhandenen Namen: " + doppelt.slice(0, 8).join(", "); return; }
      merken();
      neu.forEach((l, s) => (s.label = l));
      m.schliessen();
      zeichnen();
    };
  };

  const duplizieren = (sitze) => {
    const minX = Math.min(...sitze.map((s) => s.x)), maxX = Math.max(...sitze.map((s) => s.x));
    const dx = maxX - minX + 2;
    const kopie = sitze.map((s) => ({ id: neueId(), label: s.label + "'", x: s.x + dx, y: s.y, gesperrt: s.gesperrt, belegt: false }));
    if (kopie.some((s) => !zelleFrei(s.x, s.y))) { toast("Rechts daneben ist kein Platz.", "fehler"); return; }
    merken();
    st.sitze.push(...kopie);
    st.plan.breite = Math.max(st.plan.breite, Math.max(...kopie.map((s) => s.x)) + 2);
    $$("[data-gr]", container).forEach((i) => { i.value = st.plan[i.dataset.gr]; });
    st.auswahl = new Set(kopie.map((s) => s.id));
    zeichnen();
    toast("Kopiert – jetzt mit „Neu benennen“ sinnvolle Namen vergeben.");
  };

  // ---- Leiste ----
  $$("[data-w]", container).forEach((b) => (b.onclick = () => { st.werkzeug = b.dataset.w; zeichnen(); }));
  $$("[data-gr]", container).forEach((i) => (i.onchange = () => { merken(); st.plan[i.dataset.gr] = Math.min(200, Math.max(4, Number(i.value) || 10)); zeichnen(); }));
  $$("[data-a]", container).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    if (a === "undo") rueckgaengig();
    else if (a === "alle") { st.auswahl = new Set([...st.sitze.map((s) => s.id), ...st.plan.deko.map((d) => d.id)]); zeichnen(); }
    else if (a === "zoom-" || a === "zoom+") { st.zoom = Math.min(2.5, Math.max(0.4, st.zoom + (a === "zoom+" ? 0.2 : -0.2))); zeichnen(); }
    else if (a === "verwerfen") { if (!st.geaendert || await bestaetigen("Alle ungespeicherten Änderungen verwerfen?", { ja: "Verwerfen", gefahr: true })) { ich.abbau(); editor(container, lanId); } }
    else if (a === "speichern") mitSperre(b, async () => {
      const r = await api("adminPlanSpeichern", { lanId, plan: st.plan, sitze: st.sitze.map(({ id, label, x, y, gesperrt }) => ({ id, label, x, y, gesperrt })) });
      st.geaendert = false;
      toast("Sitzplan gespeichert – " + r.sitze + " Plätze.", "ok");
      eigenschaften();
    });
  }));

  // Seitenwechsel: Listener abbauen (ist der Container schon weg, sofort).
  beimVerlassen(ich.abbau, container);
  zeichnen();
}
