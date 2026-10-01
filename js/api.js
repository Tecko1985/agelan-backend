import { API_URL } from "./config.js?v=2";

const TOKEN_KEY = "agelan-token";
const params = new URLSearchParams(location.search);
export const istDemo = !API_URL || params.has("demo");

let demoWorker = null;

export function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
}
export function tokenSetzen(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* privat */ }
}

export async function api(aktion, daten = {}) {
  const t = token();
  const req = new Request((istDemo ? "https://demo.invalid" : API_URL.replace(/\/$/, "")) + "/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) },
    body: JSON.stringify({ aktion, ...daten }),
  });
  let res;
  try {
    if (istDemo) {
      if (!demoWorker) demoWorker = (await import("./demo.js?v=2")).starten();
      res = await (await demoWorker).fetch(req);
    } else {
      res = await fetch(req);
    }
  } catch (e) {
    throw new Error("Keine Verbindung zum Server. Bitte nochmal versuchen.");
  }
  const j = await res.json().catch(() => ({ error: "Antwort nicht lesbar (" + res.status + ")" }));
  if (!res.ok) {
    if (res.status === 401) tokenSetzen("");
    const e = new Error(j.error || "Fehler " + res.status);
    e.status = res.status;
    throw e;
  }
  return j;
}
