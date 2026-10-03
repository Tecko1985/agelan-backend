import { api, tokenSetzen } from "./api.js?v=30";
import { zustand, neuLaden, abmelden, route, gehe } from "./app.js?v=30";
import { esc, $, $$, euro, zeitraum, codeGruppen, toast, fehler, modal, bestaetigen, formDaten, mitSperre, qrSvg, drucken, ticketLink, zugangHtml, kopierenVerdrahten, sichereUrl, berlinDatum } from "./ui.js?v=30";

// ---------------------------------------------------------------------------
// Anmelden / Registrieren
// ---------------------------------------------------------------------------
function anmeldeFormular(modus) {
  if (modus === "registrieren") {
    return `<form class="formular" data-form="registrieren">
      <label class="feld"><span>Nickname *</span><input name="nick" required maxlength="24" autocomplete="username"></label>
      <div class="zwei"><label class="feld"><span>Vorname *</span><input name="vorname" required autocomplete="given-name"></label>
        <label class="feld"><span>Nachname *</span><input name="nachname" required autocomplete="family-name"></label></div>
      <div class="zwei"><label class="feld"><span>E-Mail *</span><input name="email" type="email" required autocomplete="email"></label>
        <label class="feld"><span>Geburtsdatum *</span><input name="geburtsdatum" type="date" required></label></div>
      <div class="zwei"><label class="feld"><span>Passwort * (min. 8 Zeichen)</span><input name="passwort" type="password" required minlength="8" autocomplete="new-password"></label>
        <label class="feld"><span>Discord (optional)</span><input name="discord" maxlength="60"></label></div>
      <label class="check"><input type="checkbox" name="datenschutz"> <span>Ich habe die <a href="#/seite/datenschutz" target="_blank">Datenschutzerklärung</a> gelesen.</span></label>
      <div class="fehler-text"></div>
      <button class="knopf primaer voll gross">Konto anlegen</button>
      <div class="klein leise" style="text-align:center">Schon ein Konto? <a href="#" data-wechsel="login">Anmelden</a></div>
    </form>`;
  }
  return `<form class="formular" data-form="login">
    <label class="feld"><span>Nickname oder E-Mail</span><input name="kennung" required autocomplete="username"></label>
    <label class="feld"><span>Passwort</span><input name="passwort" type="password" required autocomplete="current-password"></label>
    <div class="fehler-text"></div>
    <button class="knopf primaer voll gross">Anmelden</button>
    <div class="klein leise" style="text-align:center">Neu hier? <a href="#" data-wechsel="registrieren">Konto anlegen</a><br>
      Passwort vergessen? Melde dich bei der Orga – sie setzt es dir zurück.</div>
  </form>`;
}

function formularVerdrahten(root, nachher) {
  const form = $("form", root);
  $$("[data-wechsel]", root).forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    root.innerHTML = anmeldeFormular(a.dataset.wechsel);
    formularVerdrahten(root, nachher);
  }));
  form.onsubmit = (e) => {
    e.preventDefault();
    const knopf = $("button", form);
    const fehlerFeld = $(".fehler-text", form);
    fehlerFeld.textContent = "";
    mitSperre(knopf, async () => {
      try {
        const r = await api(form.dataset.form, formDaten(form));
        tokenSetzen(r.token);
        await neuLaden();
        toast(form.dataset.form === "login" ? "Willkommen zurück, " + r.nutzer.nick + "!" : "Konto angelegt – willkommen, " + r.nutzer.nick + "!", "ok");
        nachher();
      } catch (err) { fehlerFeld.textContent = err.message; }
    });
  };
}

export function anmeldenDialog(modus = "login", nachher = () => route()) {
  const box = document.createElement("div");
  box.innerHTML = anmeldeFormular(modus);
  const m = modal(modus === "login" ? "Anmelden" : "Konto anlegen", box);
  formularVerdrahten(box, () => { m.schliessen(); nachher(); });
}

// ---------------------------------------------------------------------------
// Ticket kaufen
// ---------------------------------------------------------------------------
export async function kaufen(typId) {
  if (!zustand.ich) {
    toast("Melde dich zuerst an oder lege ein Konto an.");
    anmeldenDialog("registrieren", () => kaufen(typId));
    return;
  }
  if (zustand.ich.ticket) { location.hash = "#/konto"; toast("Du hast schon ein Ticket für diese LAN."); return; }
  const d = zustand.daten;
  const typ = d.tickettypen.find((t) => t.id === typId);
  if (!typ) return;
  const za = d.einstellungen.zahlung;
  const arten = [["paypal", "PayPal (Freunde & Familie)"], ["ueberweisung", "Überweisung"], ["bar", "Bar bei der Orga / Abendkasse"]].filter(([k]) => za.arten[k]);
  const m = modal("Ticket bestellen", `<form class="formular">
    <div class="karte" style="padding:16px"><div class="zeile zwischen"><div><b>${esc(typ.name)}</b><div class="klein leise">${esc(d.lan.name)} · ${esc(zeitraum(d.lan.start, d.lan.ende))}</div></div>
      <b class="gold">${euro(typ.preisCent)}</b></div></div>
    ${typ.extras.length ? `<div><div class="klein leise" style="margin-bottom:6px">Extras</div><div class="wahl">${typ.extras.map((x) => `<label><input type="checkbox" name="extra" value="${esc(x.name)}"> <span style="flex:1">${esc(x.name)}</span><b>+${euro(x.preisCent)}</b></label>`).join("")}</div></div>` : ""}
    <div><div class="klein leise" style="margin-bottom:6px">Zahlart</div><div class="wahl">${arten.map(([k, t], i) => `<label><input type="radio" name="zahlart" value="${k}" ${i === 0 ? "checked" : ""}> <span>${t}</span></label>`).join("")}</div></div>
    <div class="zeile" style="align-items:end"><label class="feld" style="flex:1"><span>Gutschein-Code (optional)</span><input name="gutschein" autocomplete="off"></label><button type="button" class="knopf" data-pruefen>Prüfen</button></div>
    <label class="feld"><span>Hinweis an die Orga (optional)</span><textarea name="notiz" maxlength="300" placeholder="z. B. „Ich möchte neben … sitzen“" style="min-height:60px"></textarea></label>
    <label class="check"><input type="checkbox" name="agb"> <span>Ich akzeptiere die <a href="#/seite/agb" target="_blank">Teilnahmebedingungen</a>. Unter 18? Dann bringe ich den unterschriebenen Muttizettel mit.</span></label>
    <div class="summe"><span>Gesamt</span><b data-summe>${euro(typ.preisCent)}</b></div>
    <div class="fehler-text"></div>
    <button class="knopf primaer gross voll" data-kaufen>Verbindlich bestellen</button>
  </form>`);
  const form = $("form", m.el);
  const daten = () => ({ typId, extras: $$("[name=extra]:checked", form).map((x) => x.value), gutschein: form.gutschein.value.trim() });
  const vorschau = async () => {
    try {
      const p = await api("preisVorschau", daten());
      $("[data-summe]", form).innerHTML = (p.rabattCent ? `<span class="klein leise" style="text-decoration:line-through;margin-right:8px">${euro(p.summeCent)}</span>` : "") + euro(p.endCent);
      $(".fehler-text", form).textContent = "";
      if (p.couponText) toast("Gutschein: " + p.couponText, "ok");
    } catch (e) { $(".fehler-text", form).textContent = e.message; }
  };
  $$("[name=extra]", form).forEach((c) => (c.onchange = vorschau));
  $("[data-pruefen]", form).onclick = vorschau;
  form.onsubmit = (e) => {
    e.preventDefault();
    mitSperre($("[data-kaufen]", form), async () => {
      try {
        await api("ticketKaufen", { ...daten(), zahlart: (form.querySelector("[name=zahlart]:checked") || {}).value, agb: form.agb.checked, notiz: form.notiz.value });
        m.schliessen();
        toast("Ticket bestellt.", "ok");
        gehe("#/konto");
      } catch (err) { $(".fehler-text", form).textContent = err.message; }
    });
  };
}

// ---------------------------------------------------------------------------
// Ticket-Darstellung (Bildschirm + Druck)
// ---------------------------------------------------------------------------
export function ticketHtml(t) {
  const lan = t.lan;
  const bezahlt = t.status === "bezahlt";
  return `<div class="lan-ticket">
    <div class="t-band"><span>${esc(lan.name)}</span><span>${esc(zeitraum(lan.start, lan.ende)).toUpperCase()}</span></div>
    <div class="t-koerper">
      <div>
        <div class="t-logo"><img src="img/wappen.jpg" alt=""><div><b>LAN-Ticket</b><span>${esc(t.typ.name)} · ${euro(t.preisCent)}</span></div>
          <div class="t-stempel ${bezahlt ? "bezahlt" : "offen"}">${bezahlt ? "BEZAHLT" : "OFFEN"}</div></div>
        <div class="t-klein">Gast</div>
        <div class="t-nick">${esc(t.nutzer.nick)}</div>
        <div class="t-klein">${esc(t.nutzer.vorname)} ${esc(t.nutzer.nachname)} · Zahlung: ${esc(t.zahlartText)}</div>
        <div style="margin-top:14px" class="t-typ">Beinhaltet</div>
        <ul>${t.typ.features.map((f) => `<li>${esc(f)}</li>`).join("")}${t.extras.map((x) => `<li>${esc(x.name)}</li>`).join("")}</ul>
      </div>
      <div class="t-qr"><div class="qr">${qrSvg(ticketLink(t.code))}<img src="img/wappen.jpg" alt=""></div>
        <div class="t-code">${esc(codeGruppen(t.code))}</div>
        <div class="t-klein" style="margin-top:4px;max-width:210px">Nach dem Check-in mit dem Handy scannen – dort stehen deine Internet-Zugangsdaten.</div></div>
    </div>
    <div class="t-fuss">
      <div><div class="t-klein">Ort</div><b>${esc(lan.ort)}</b><br>${esc(lan.adresse)}</div>
      <div><div class="t-klein">Gruppe</div><b>${esc(t.gruppe || "–")}</b></div>
      <div style="text-align:right"><div class="t-klein">Platz</div><div class="t-sitz">${esc(t.sitz || (t.typ.mitSitz ? "?" : "Gast"))}</div></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Konto-Seite
// ---------------------------------------------------------------------------
export async function render(main) {
  await neuLaden();
  if (!zustand.ich) {
    main.innerHTML = `<div class="wrap" style="max-width:560px"><div class="seitenkopf"><span class="ueberzeile">Mein Konto</span><h1>Willkommen</h1>
      <p>Mit deinem Konto kaufst du Tickets, wählst deinen Platz und gründest Reservierungsgruppen.</p></div><div class="karte glanz" id="anmelde-box"></div></div>`;
    const box = $("#anmelde-box", main);
    box.innerHTML = anmeldeFormular("login");
    formularVerdrahten(box, () => route());
    return;
  }
  const { nutzer: u, ticket: t, gruppe: g, alter } = zustand.ich;
  const d = zustand.daten;
  const za = d.einstellungen.zahlung;

  let ticketTeil, ticketUnten = "";
  if (!t) {
    ticketTeil = `<div class="karte glanz"><h2>Noch kein Ticket</h2><p class="leise">Für die ${esc(d.lan.name)} hast du noch kein Ticket.</p>
      <a class="knopf primaer gross" href="#/tickets">Ticket kaufen</a></div>`;
  } else {
    const schritte = [["Bestellt", true], ["Bezahlt", t.status === "bezahlt"], ["Platz", !!t.sitz || !t.typ.mitSitz], ["Eingecheckt", !!t.checkinAt]];
    const jetzt = schritte.findIndex(([, f]) => !f);
    const kurz = t.code.slice(0, 8).toUpperCase();
    ticketTeil = `
      <div class="karte">
        <div class="karte-kopf"><div><span class="ueberzeile">Mein Ticket</span><h2 style="margin:0">${esc(t.typ.name)}</h2></div>
          ${t.status === "bezahlt" ? `<span class="abzeichen gruen">✓ Bezahlt</span>` : `<span class="abzeichen gold">Zahlung offen</span>`}</div>
        <div class="status-schritte">${schritte.map(([l, f], i) => `<div class="${f ? "fertig" : i === jetzt ? "jetzt" : ""}">${f ? "✓ " : ""}${l}</div>`).join("")}</div>
        ${t.status === "offen" ? zahlInfo(t, za, kurz) : ""}
        ${t.typ.mitSitz && !t.sitz ? `<div class="karte" style="border-color:var(--rand2);margin-top:12px"><b>Such dir deinen Platz aus!</b><p class="leise klein" style="margin:4px 0 10px">Freie Plätze findest du im Sitzplan.</p><a class="knopf primaer" href="#/sitzplan">Zum Sitzplan</a></div>` : ""}
        ${t.sitz ? `<p style="margin-top:14px">Dein Platz: <a class="abzeichen gold" href="#/sitzplan/${encodeURIComponent(t.sitz)}">${esc(t.sitz)}</a> ${t.checkinAt ? "" : `<a class="klein" href="#/sitzplan" style="margin-left:6px">ändern</a>`}</p>` : ""}
        <a class="knopf klein geist" href="#/packliste" style="margin-top:14px">Packliste: Was brauche ich für die LAN?</a>
        ${alter != null && alter < 18 ? `<div class="karte" style="margin-top:12px;border-color:var(--gold)">Du bist zur LAN unter 18. Bitte bring den unterschriebenen Muttizettel und deine volljährige Aufsichtsperson mit.</div>` : ""}
      </div>`;
    ticketUnten = `<div class="abschnitt-kopf" style="margin-top:36px"><div><span class="ueberzeile">Zum Vorzeigen beim Einlass</span><h2 style="margin:0">Dein Ticket</h2></div>
        <div class="zeile"><button class="knopf primaer" data-drucken>Drucken / als PDF</button>
        ${t.status === "offen" ? `<button class="knopf geist" data-storno>Bestellung stornieren</button>` : ""}</div></div>
      <div style="max-width:900px">${ticketHtml(t)}</div>`;
  }

  main.innerHTML = `<div class="wrap">
    <div class="seitenkopf zeile zwischen" style="align-items:end"><div><span class="ueberzeile">Mein Konto</span><h1 style="margin:0">Hallo, ${esc(u.nick)}</h1></div>
      <button class="knopf geist" data-abmelden>Abmelden</button></div>
    <div class="konto-raster" style="margin-top:18px">
      <div class="stapel">${t && t.zugang ? zugangHtml(t.zugang) : ""}${ticketTeil}</div>
      <div class="stapel">
        ${gruppeHtml(g)}
        <div class="karte"><h3>Meine Daten</h3>
          <dl class="daten-liste"><dt>Name</dt><dd>${esc(u.vorname)} ${esc(u.nachname)}</dd><dt>E-Mail</dt><dd>${esc(u.email)}</dd>
          <dt>Geburtstag</dt><dd>${esc(u.geburtsdatum)}</dd>${u.discord ? `<dt>Discord</dt><dd>${esc(u.discord)}</dd>` : ""}
          ${u.rolle !== "user" ? `<dt>Rolle</dt><dd><span class="abzeichen gold">${u.rolle === "admin" ? "Veranstalter" : "Orga"}</span></dd>` : ""}</dl>
          <div class="zeile" style="margin-top:14px"><button class="knopf klein" data-daten>Daten ändern</button>
          ${u.rolle !== "admin" ? `<button class="knopf klein geist" data-veranstalter>Veranstalter werden</button>` : ""}</div></div>
      </div>
    </div>${ticketUnten}</div>`;

  $("[data-abmelden]", main).onclick = abmelden;
  kopierenVerdrahten(main);
  const druck = $("[data-drucken]", main);
  if (druck) druck.onclick = () => drucken(`<div style="max-width:190mm;margin:0 auto">${ticketHtml(t)}</div>`, "A4");
  const storno = $("[data-storno]", main);
  if (storno) storno.onclick = async () => {
    if (!(await bestaetigen("Willst du deine Bestellung wirklich stornieren? Dein Platz wird frei.", { ja: "Stornieren", gefahr: true }))) return;
    mitSperre(storno, async () => { await api("ticketStornieren"); toast("Bestellung storniert."); render(main); });
  };
  $$("[data-zahlart]", main).forEach((s) => (s.onchange = async () => {
    try { await api("zahlartAendern", { zahlart: s.value }); toast("Zahlart geändert.", "ok"); render(main); } catch (e) { fehler(e); }
  }));
  $("[data-daten]", main).onclick = () => datenDialog(u, main);
  const ver = $("[data-veranstalter]", main);
  if (ver) ver.onclick = () => {
    const m = modal("Veranstalter werden", `<form class="formular"><p class="leise">Mit dem Veranstalter-Passwort wird dein Konto zum Veranstalter-Konto.</p>
      <label class="feld"><span>Veranstalter-Passwort</span><input name="pw" type="password"></label><div class="fehler-text"></div><button class="knopf primaer">Freischalten</button></form>`);
    const f = $("form", m.el);
    f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
      try { await api("veranstalterWerden", { passwort: f.pw.value }); m.schliessen(); toast("Du bist jetzt Veranstalter.", "ok"); render(main); } catch (err) { $(".fehler-text", f).textContent = err.message; }
    }); };
  };
  gruppeVerdrahten(main, g);
}

function zahlInfo(t, za, kurz) {
  const arten = [["paypal", "PayPal (Freunde)"], ["ueberweisung", "Überweisung"], ["bar", "Bar"]].filter(([k]) => za.arten[k]);
  let wie = "";
  if (t.zahlart === "paypal") {
    wie = `<dl class="daten-liste"><dt>PayPal an</dt><dd><b>${esc(za.paypal || "wird noch bekanntgegeben")}</b></dd><dt>Betrag</dt><dd><b>${euro(t.preisCent)}</b></dd>
      <dt>Verwendungszweck</dt><dd class="mono">${esc(t.nutzer.nick)} ${kurz}</dd></dl>
      ${sichereUrl(za.paypalMe) ? `<a class="knopf klein" style="margin-top:10px" target="_blank" rel="noopener" href="${esc(sichereUrl(za.paypalMe).replace(/\/$/, "") + "/" + (t.preisCent / 100).toFixed(2))}">Mit PayPal.me bezahlen</a>` : ""}`;
  } else if (t.zahlart === "ueberweisung") {
    wie = `<dl class="daten-liste"><dt>Empfänger</dt><dd>${esc(za.kontoinhaber || "–")}</dd><dt>IBAN</dt><dd class="mono">${esc(za.iban || "wird noch bekanntgegeben")}</dd>
      ${za.bank ? `<dt>Bank</dt><dd>${esc(za.bank)}</dd>` : ""}<dt>Betrag</dt><dd><b>${euro(t.preisCent)}</b></dd><dt>Verwendungszweck</dt><dd class="mono">${esc(t.nutzer.nick)} ${kurz}</dd></dl>`;
  } else {
    wie = `<p>Du zahlst <b>${euro(t.preisCent)}</b> bar bei der Orga oder an der Abendkasse. Bis zur Zahlung ist dein Platz nur reserviert.</p>`;
  }
  const frist = za.fristTage ? new Date(t.createdAt + za.fristTage * 864e5).toLocaleDateString("de-DE") : "";
  return `<div class="karte" style="margin-top:12px;background:rgba(232,182,76,.06);border-color:var(--rand2)">
    <div class="zeile zwischen" style="margin-bottom:10px"><b>So bezahlst du</b>
      <select data-zahlart style="width:auto">${arten.map(([k, l]) => `<option value="${k}" ${k === t.zahlart ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    ${wie}
    <p class="klein leise" style="margin:10px 0 0">${esc(za.hinweis)}${frist && t.zahlart !== "bar" ? " Bitte bezahle bis " + frist + "." : ""}</p></div>`;
}

function datenDialog(u, main) {
  const m = modal("Meine Daten", `<form class="formular">
    <div class="zwei"><label class="feld"><span>Vorname</span><input name="vorname" value="${esc(u.vorname)}"></label><label class="feld"><span>Nachname</span><input name="nachname" value="${esc(u.nachname)}"></label></div>
    <div class="zwei"><label class="feld"><span>E-Mail</span><input name="email" type="email" value="${esc(u.email)}"></label><label class="feld"><span>Geburtsdatum</span><input name="geburtsdatum" type="date" value="${esc(u.geburtsdatum)}"></label></div>
    <label class="feld"><span>Discord</span><input name="discord" value="${esc(u.discord)}"></label>
    <hr style="margin:6px 0"><div class="klein leise">Passwort ändern (optional)</div>
    <div class="zwei"><label class="feld"><span>Bisheriges Passwort</span><input name="passwortAlt" type="password" autocomplete="current-password"></label>
      <label class="feld"><span>Neues Passwort</span><input name="passwortNeu" type="password" autocomplete="new-password"></label></div>
    <div class="fehler-text"></div><button class="knopf primaer">Speichern</button></form>`);
  const f = $("form", m.el);
  f.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", f), async () => {
    try {
      const r = await api("kontoAendern", formDaten(f));
      if (r.token) tokenSetzen(r.token);
      m.schliessen(); toast("Gespeichert.", "ok"); render(main);
    } catch (err) { $(".fehler-text", f).textContent = err.message; }
  }); };
}

// ---------------------------------------------------------------------------
// Reservierungsgruppe
// ---------------------------------------------------------------------------
function gruppeHtml(g) {
  if (!g) {
    const e = (zustand.daten && zustand.daten.einstellungen) || {};
    const gruenden = e.gruppenErlaubt !== false;
    return `<div class="karte"><h3>Reservierungsgruppe</h3><p class="leise klein">${gruenden
      ? `Mit Freunden zusammen sitzen? Gründe eine Gruppe, merke einen Block Plätze vor und gib den Code weiter. Eine Gruppe hält ihre Plätze ${e.gruppeHalteTage || 21} Tage.`
      : "Neue Gruppen sind gerade nicht möglich. Mit einem Code kannst du einer bestehenden Gruppe beitreten."}</p>
      ${gruenden ? `<form class="zeile" data-gruppe-neu style="margin-bottom:10px"><input name="name" placeholder="Name der Gruppe" maxlength="30" style="flex:1;min-width:160px"><button class="knopf primaer">Gründen</button></form>` : ""}
      <form class="zeile" data-gruppe-bei><input name="code" placeholder="Gruppen-Code" maxlength="10" style="flex:1;min-width:160px;text-transform:uppercase"><button class="knopf">Beitreten</button></form></div>`;
  }
  return `<div class="karte glanz"><div class="karte-kopf"><div><span class="ueberzeile">Reservierungsgruppe</span><h3 style="margin:0">${esc(g.name)}</h3></div>
      <span class="abzeichen ${g.aktiv ? "blau" : "rot"}">${g.aktiv ? "Plätze " + g.fuellung : "abgelaufen"}</span></div>
    <dl class="daten-liste"><dt>Code</dt><dd><b class="mono gold" style="font-size:1.15rem;letter-spacing:.15em">${esc(g.code)}</b> <button class="knopf klein geist" data-kopieren="${esc(g.code)}">Kopieren</button></dd>
      <dt>Leitung</dt><dd>${esc(g.leitung)}</dd>
      <dt>Vorgemerkt</dt><dd>${g.sitze.length ? g.sitze.map((s) => `<span class="abzeichen ${s.besetzt ? "rot" : "blau"}">${esc(s.label)}</span>`).join(" ") : `<span class="leise">noch keine Plätze</span>`}</dd>
      <dt>Hält bis</dt><dd>${esc(berlinDatum(g.ablauf))}</dd></dl>
    <div style="margin-top:12px"><div class="klein leise" style="margin-bottom:6px">Mitglieder</div>
      ${g.mitglieder.map((m) => `<div class="zeile zwischen" style="padding:6px 0;border-bottom:1px dashed var(--rand)"><span>${esc(m.nick)}${m.id === g.leitungId ? ` <span class="klein leise">(Leitung)</span>` : ""}</span>
        <span class="zeile">${m.sitz ? `<span class="abzeichen gold">${esc(m.sitz)}</span>` : ""}${m.ticket ? "" : `<span class="abzeichen">kein Ticket</span>`}
        ${g.istLeitung && m.id !== g.leitungId ? `<button class="knopf klein geist" data-rauswerfen="${m.id}" title="Aus der Gruppe nehmen">Entfernen</button>` : ""}</span></div>`).join("")}</div>
    <div class="zeile" style="margin-top:14px">
      ${g.istLeitung ? `<a class="knopf klein primaer" href="#/sitzplan/~gruppe">Plätze vormerken</a><button class="knopf klein" data-neuer-code>Neuer Code</button>` : ""}
      <button class="knopf klein geist" data-verlassen>Gruppe verlassen</button></div></div>`;
}

function gruppeVerdrahten(main, g) {
  const neu = $("[data-gruppe-neu]", main);
  if (neu) neu.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", neu), async () => { await api("gruppeErstellen", { name: neu.name.value }); toast("Gruppe gegründet!", "ok"); render(main); }); };
  const bei = $("[data-gruppe-bei]", main);
  if (bei) bei.onsubmit = (e) => { e.preventDefault(); mitSperre($("button", bei), async () => { await api("gruppeBeitreten", { code: bei.code.value }); toast("Du bist der Gruppe beigetreten.", "ok"); render(main); }); };
  if (!g) return;
  $$("[data-kopieren]", main).forEach((b) => (b.onclick = () => { navigator.clipboard?.writeText(b.dataset.kopieren); toast("Code kopiert."); }));
  const verl = $("[data-verlassen]", main);
  if (verl) verl.onclick = async () => {
    if (!(await bestaetigen(g.istLeitung && g.mitglieder.length === 1 ? "Du bist allein in der Gruppe – sie wird aufgelöst und die vorgemerkten Plätze werden frei." : "Gruppe wirklich verlassen?", { ja: "Verlassen", gefahr: true }))) return;
    mitSperre(verl, async () => { await api("gruppeVerlassen"); render(main); });
  };
  const code = $("[data-neuer-code]", main);
  if (code) code.onclick = () => mitSperre(code, async () => { await api("gruppeNeuerCode"); toast("Neuer Code erzeugt – der alte gilt nicht mehr."); render(main); });
  $$("[data-rauswerfen]", main).forEach((b) => (b.onclick = async () => {
    if (!(await bestaetigen("Dieses Mitglied aus der Gruppe nehmen?", { ja: "Entfernen", gefahr: true }))) return;
    mitSperre(b, async () => { await api("gruppeEntfernen", { userId: Number(b.dataset.rauswerfen) }); render(main); });
  }));
}

// ---------------------------------------------------------------------------
// Ticket-Seite hinter dem QR-Code: #/t/<code>
// ---------------------------------------------------------------------------
export async function renderTicketSeite(main, code) {
  await neuLaden();
  const istOrga = zustand.ich && ["orga", "admin"].includes(zustand.ich.nutzer.rolle);
  let t;
  try { t = (await api("ticketSeite", { code })).ticket; } catch (e) {
    main.innerHTML = `<div class="wrap" style="max-width:560px"><div class="leer" style="margin-top:40px">${esc(e.message)}</div></div>`;
    return;
  }
  const ok = t.status === "bezahlt";
  main.innerHTML = `<div class="wrap" style="max-width:620px"><div class="seitenkopf"><span class="ueberzeile">${esc(t.lan.name)} · ${esc(zeitraum(t.lan.start, t.lan.ende))}</span>
      <h1 style="margin-bottom:6px">${esc(t.nick)}</h1><div class="zeile">
      <span class="abzeichen ${t.status === "storniert" ? "rot" : ok ? "gruen" : "gold"}">${t.status === "storniert" ? "Storniert" : ok ? "✓ Gültiges Ticket" : "Zahlung offen"}</span>
      ${t.eingecheckt ? `<span class="abzeichen gruen">✓ Eingecheckt</span>` : ""}</div></div>
    ${istOrga ? `<div class="karte" style="margin-bottom:16px;border-color:var(--gold)"><b>Orga-Ansicht</b><p class="klein leise" style="margin:4px 0 10px">Du bist als Orga angemeldet.</p>
      <a class="knopf primaer" href="#/checkin/${encodeURIComponent(code)}">Zum Check-in dieses Tickets</a></div>` : ""}
    ${t.zugang ? zugangHtml(t.zugang) : `<div class="karte"><h3>${t.status === "storniert" ? "Dieses Ticket ist storniert." : "Noch nicht eingecheckt"}</h3>
      <p class="leise">${t.status === "storniert" ? "" : "Zeig diesen QR-Code beim Einlass vor. Nach dem Check-in erscheinen hier deine Zugangsdaten fürs Internet – einfach den QR-Code auf deinem Ticket nochmal scannen oder diese Seite neu laden."}</p>
      ${t.eingecheckt || t.status === "storniert" ? "" : `<button class="knopf" data-neu>↻ Neu laden</button>`}</div>`}
    <div class="karte" style="margin-top:16px"><dl class="daten-liste"><dt>Ticket</dt><dd>${esc(t.typ)}</dd>
      ${t.mitSitz ? `<dt>Platz</dt><dd><b class="gold">${esc(t.sitz || "noch keiner")}</b></dd>` : ""}${t.gruppe ? `<dt>Gruppe</dt><dd>${esc(t.gruppe)}</dd>` : ""}
      <dt>Ort</dt><dd>${esc(t.lan.ort)}</dd></dl></div></div>`;
  kopierenVerdrahten(main);
  const neu = $("[data-neu]", main);
  if (neu) neu.onclick = () => renderTicketSeite(main, code);
}
