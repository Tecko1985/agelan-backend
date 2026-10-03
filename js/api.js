import { API_URL } from "./config.js?v=28";

const TOKEN_KEY = "agelan-token";
const params = new URLSearchParams(location.search);
export const istDemo = !API_URL || params.has("demo");

let demoWorker = null;

export function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
}
// Zählt jede Aktion, die Daten ändern kann. neuLaden() nutzt das, um gerade
// geladene Daten wiederzuverwenden, solange sich nichts geändert hat.
const NUR_LESEN = new Set(["oeffentlich", "ich", "sitzplan", "gaeste", "news", "ticketSeite", "preisVorschau", "checkinSuchen", "appToken",
  "adminTickets", "adminGruppen", "adminTickettypen", "adminGutscheine", "adminLans", "adminEinstellungen", "adminBenutzer",
  "adminProtokoll", "adminNetz", "adminVorlagen", "adminPortalTest"]);
export let datenStand = 0;

export function tokenSetzen(t) {
  datenStand++;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* privat */ }
}

// Anmeldung der eingebetteten AgeLan-App (Klon, Präfix "klon:") mit entfernen.
export const APP_KONTO_KEY = "klon:agelan_konto";
export const APP_TAB_KEY = "klon:agelan_tab";
export function appAnmeldungEntfernen() {
  try { localStorage.removeItem(APP_KONTO_KEY); localStorage.removeItem(APP_TAB_KEY); } catch (e) { /* privat */ }
}

export async function api(aktion, daten = {}) {
  const t = token();
  const req = new Request((istDemo ? "https://demo.invalid" : API_URL.replace(/\/$/, "")) + "/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) },
    body: JSON.stringify({ aktion, ...daten }),
  });
  if (!NUR_LESEN.has(aktion)) datenStand++;
  let res;
  try {
    if (istDemo) {
      if (!demoWorker) demoWorker = (await import("./demo.js?v=28")).starten();
      res = await (await demoWorker).fetch(req);
    } else {
      res = await fetch(req);
    }
  } catch (e) {
    throw new Error("Keine Verbindung zum Server. Bitte nochmal versuchen.");
  }
  if (!NUR_LESEN.has(aktion)) datenStand++; // auch nach der Antwort: Ladevorgänge währenddessen gelten als veraltet
  const j = await res.json().catch(() => ({ error: "Antwort nicht lesbar (" + res.status + ")" }));
  if (!res.ok) {
    if (res.status === 401) { tokenSetzen(""); appAnmeldungEntfernen(); }
    const e = new Error(j.error || "Fehler " + res.status);
    e.status = res.status;
    throw e;
  }
  return j;
}
