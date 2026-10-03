import { api } from "./api.js?v=24";
import { zustand, neuLaden, beimVerlassen } from "./app.js?v=24";
import { esc, $, $$, toast, fehler, bestaetigen, mitSperre } from "./ui.js?v=24";
import { planSvg, tooltipAnbinden, legendeHtml, sitzInfo, U } from "./plan.js?v=24";

// Handy/Tablet ohne Maus: kein Überfahren, nur Antippen.
const beruehrung = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

export async function render(main, param) {
  await neuLaden();
  let ich = zustand.ich;
  const gruppenModus = param === "~gruppe" && ich && ich.gruppe && ich.gruppe.istLeitung;
  const markiert = param && param !== "~gruppe" ? param : "";
  let daten = await api("sitzplan");
  let gemerkt = null;
  try { gemerkt = sessionStorage.getItem("plan-zoom"); } catch (e) { /* privater Modus */ }
  let zoom = Number(gemerkt) || 1;
  const auswahl = new Set(gruppenModus ? ich.gruppe.sitze.map((s) => s.id) : []);
  const maxSitze = zustand.daten.einstellungen.gruppeMaxSitze;

  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf"><span class="ueberzeile">${esc(daten.lan.name)}</span><h1>Sitzplan</h1>
      <p>${gruppenModus ? `Klicke Plätze an, um sie für <b>${esc(ich.gruppe.name)}</b> vorzumerken (max. ${maxSitze}). Mitglieder deiner Gruppe können sich dann darauf setzen.` : (beruehrung ? "Tippe auf einen Platz für Details." : "Fahre über einen Platz für Details.") + " Mit Ticket " + (beruehrung ? "tippst" : "klickst") + " du einen freien Platz an, um ihn zu nehmen."}</p></div>
    <div class="plan-layout">
      <div>
        <div class="plan-werkzeug">
          <button class="knopf klein" data-zoom="-1">−</button><button class="knopf klein" data-zoom="1">+</button>
          <input id="p-suche" placeholder="Nick oder Platz suchen …" style="max-width:240px">
          <span class="leise klein" id="p-stand"></span>
        </div>
        <div class="plan-info leise klein" id="p-info" aria-live="polite"></div>
        <div class="plan-buehne" id="buehne"></div>
      </div>
      <aside class="stapel" id="seite"></aside>
    </div></div>`;

  const buehne = $("#buehne", main);
  if (!gemerkt) {
    // Ohne gemerkten Zoom: Plan auf die Breite der Bühne einpassen
    zoom = Math.min(1.4, Math.max(0.6, (buehne.clientWidth - 30) / (daten.plan.breite * U + 12)));
  }
  const zeichnen = () => {
    const q = $("#p-suche", main).value.trim().toLowerCase();
    buehne.innerHTML = planSvg(daten.plan, daten.sitze, {
      zoom,
      klassen: (s, istDeko) => {
        if (istDeko) return "";
        const k = [];
        if (auswahl.has(s.id) && gruppenModus) k.push("gewaehlt");
        if ((markiert && s.label.toLowerCase() === markiert.toLowerCase()) || (q.length >= 1 && (s.label.toLowerCase() === q || (q.length >= 2 && s.nick && s.nick.toLowerCase().includes(q))))) k.push("markiert");
        return k.join(" ");
      },
    });
    seiteZeichnen();
    const zahl = (st) => daten.sitze.filter((s) => s.status === st).length;
    $("#p-stand", main).textContent = `${zahl("frei")} frei · ${zahl("reserviert")} reserviert · ${zahl("belegt")} belegt`;
  };

  const seiteZeichnen = () => {
    const t = ich && ich.ticket;
    let meinTeil;
    if (!ich) meinTeil = `<div class="karte"><h3>Platz aussuchen</h3><p class="leise klein">Melde dich an und kaufe ein Ticket, dann kannst du hier deinen Platz wählen.</p><a class="knopf primaer" href="#/tickets">Zu den Tickets</a></div>`;
    else if (gruppenModus) {
      meinTeil = `<div class="karte glanz"><h3>${esc(ich.gruppe.name)}</h3><p class="klein leise">${auswahl.size} von max. ${maxSitze} Plätzen gewählt.</p>
        <div style="margin-bottom:12px">${[...auswahl].map((id) => { const s = daten.sitze.find((x) => x.id === id); return s ? `<span class="abzeichen blau">${esc(s.label)}</span> ` : ""; }).join("")}</div>
        <div class="zeile"><button class="knopf primaer" data-gruppe-speichern>Vormerkung speichern</button><a class="knopf geist" href="#/konto">Fertig</a></div></div>`;
    } else if (!t) meinTeil = `<div class="karte"><h3>Noch kein Ticket</h3><p class="leise klein">Ohne Ticket kannst du dir noch keinen Platz aussuchen.</p><a class="knopf primaer" href="#/tickets">Ticket kaufen</a></div>`;
    else if (!t.typ.mitSitz) meinTeil = `<div class="karte"><h3>Gäste-Ticket</h3><p class="leise klein">Dein Ticket hat keinen PC-Platz.</p></div>`;
    else meinTeil = `<div class="karte glanz"><h3>Dein Platz</h3>${t.sitz ? `<div class="gross-sitz">${esc(t.sitz)}</div><p class="leise klein">Klicke einen anderen freien Platz an, um zu wechseln.</p>
      ${t.checkinAt ? "" : `<button class="knopf klein geist" data-freigeben>Platz freigeben</button>`}` : `<p>Du hast noch keinen Platz. Klicke einen <b class="gruen">grünen</b> Platz an.</p>`}
      ${ich.gruppe ? `<p class="klein leise" style="margin-top:10px">Gruppe <b>${esc(ich.gruppe.name)}</b>: lila umrandete Plätze sind für euch.${ich.gruppe.istLeitung ? ` <a href="#/sitzplan/~gruppe">Plätze vormerken</a>` : ""}</p>` : ""}</div>`;
    $("#seite", main).innerHTML = meinTeil + `<div class="karte"><h3>Legende</h3>${legendeHtml()}</div>`;
    const fr = $("[data-freigeben]", main);
    if (fr) fr.onclick = () => mitSperre(fr, async () => { await api("sitzFreigeben"); await neuLaden(); ich = zustand.ich; daten = await api("sitzplan"); zeichnen(); toast("Platz freigegeben."); });
    const gs = $("[data-gruppe-speichern]", main);
    if (gs) gs.onclick = () => mitSperre(gs, async () => {
      await api("gruppeSitze", { sitzIds: [...auswahl] });
      await neuLaden(); ich = zustand.ich; daten = await api("sitzplan"); zeichnen(); toast("Vormerkung gespeichert.", "ok");
    });
  };

  buehne.addEventListener("click", async (e) => {
    const g = e.target.closest("[data-sitz]");
    if (!g) return;
    if (!ich) { const s = daten.sitze.find((x) => x.id === g.dataset.sitz); if (s) $("#p-info", main).innerHTML = sitzInfo(s); return; }
    const s = daten.sitze.find((x) => x.id === g.dataset.sitz);
    if (!s) return;
    // Ohne Maus gibt es keinen Tooltip – Details stehen dann über dem Plan.
    $("#p-info", main).innerHTML = sitzInfo(s);
    if (gruppenModus) {
      if (auswahl.has(s.id)) auswahl.delete(s.id);
      else {
        const frei = s.status === "frei" || (s.status === "gruppe" && s.meineGruppe) || ((s.status === "belegt" || s.status === "reserviert") && s.meineGruppe);
        if (!frei) { toast("Platz " + s.label + " ist nicht frei."); return; }
        if (auswahl.size >= maxSitze) { toast("Höchstens " + maxSitze + " Plätze."); return; }
        auswahl.add(s.id);
      }
      zeichnen();
      return;
    }
    const t = ich.ticket;
    if (!t || !t.typ.mitSitz || s.meins) return;
    const istOrga = ["orga", "admin"].includes(ich.nutzer.rolle);
    const nehmbar = s.status === "frei" || (s.status === "gruppe" && s.meineGruppe) || (s.status === "orga" && istOrga);
    if (!nehmbar) { toast(s.status === "gruppe" ? "Dieser Platz ist für die Gruppe „" + s.gruppe + "“ vorgemerkt." : s.status === "orga" ? "Platz " + s.label + " ist für die Orga reserviert." : "Platz " + s.label + " ist nicht frei."); return; }
    if (t.checkinAt) { toast("Nach dem Check-in ändert nur die Orga deinen Platz."); return; }
    if (!(await bestaetigen(t.sitz ? `Von ${t.sitz} auf Platz ${s.label} wechseln?` : `Platz ${s.label} nehmen?`, { ja: "Ja, Platz nehmen" }))) return;
    try {
      await api("sitzWaehlen", { sitzId: s.id });
      toast("Platz " + s.label + " gehört dir.", "ok");
      await neuLaden();
      ich = zustand.ich;
      daten = await api("sitzplan");
      zeichnen();
    } catch (err) {
      fehler(err);
      try { daten = await api("sitzplan"); zeichnen(); } catch (e) { /* nächster Versuch beim Live-Abgleich */ }
    }
  });

  $$("[data-zoom]", main).forEach((b) => (b.onclick = () => {
    zoom = Math.min(2.5, Math.max(0.5, zoom + Number(b.dataset.zoom) * 0.25));
    try { sessionStorage.setItem("plan-zoom", zoom); } catch (e) { /* egal */ }
    zeichnen();
  }));
  $("#p-suche", main).oninput = zeichnen;
  tooltipAnbinden(buehne, (id) => daten.sitze.find((s) => s.id === id));
  zeichnen();
  const ziel = $(".markiert", buehne);
  if (ziel) ziel.scrollIntoView({ block: "center", inline: "center" });

  // Live: alle 20 s neu laden (nicht während eine Gruppe auswählt)
  if (!gruppenModus) {
    const iv = setInterval(async () => {
      try { daten = await api("sitzplan"); zeichnen(); } catch (e) { /* nächster Versuch */ }
    }, 20000);
    beimVerlassen(() => clearInterval(iv), main);
  }
}
