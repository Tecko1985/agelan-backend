# 🏰 agelan-backend – Website, Tickets, Sitzplan und Check-in für die AGE-LAN

Nachfolger für age-lan.de bzw. das alte Dota-LAN-Admin-Panel. Später soll das unter **age-lan.de** laufen.

| Teil | Was |
|---|---|
| **Website** | Start mit Countdown und Belegung, Die LAN, News, Tickets, Sitzplan (live), Gästeliste, FAQ, Texte (Anfahrt/AGB/Datenschutz/Impressum) |
| **Konto** | Registrieren (Nick, Name, E-Mail, Geburtsdatum, Discord), Login, Daten ändern |
| **Tickets** | Ticketsorten mit Kontingent, Zeitraum, Extras und Gutscheinen. Bezahlt wird per PayPal (Checkout, sofort bestätigt), Überweisung oder bar; Überweisung und bar bestätigt die Orga |
| **QR-Ticket** | Druckbares Ticket mit QR-Code (`AGELAN:<32 hex>`), Code in Vierergruppen wie beim alten Ticket |
| **Sitzplan** | Gäste wählen selbst; Reservierungsgruppen mit Code, vorgemerkten Plätzen und Haltefrist |
| **Sitzplan-Editor** | Plätze setzen, Tischblöcke einfügen, verschieben, umbenennen, sperren; Flächen, Texte und Wände zeichnen |
| **Check-in** | QR-Code mit Handy-Kamera, Webcam (Kamera wählbar) oder USB-Handscanner scannen oder Gast suchen, Status prüfen (bezahlt? U18?), Bar-Zahlung kassieren, einchecken. Kein Drucker: Der Ticket-QR ist ein Link – der Gast scannt ihn nach dem Check-in mit dem Handy und sieht seine **Internet-Zugangsdaten (OTP)** |
| **Verwaltung** | Übersicht, Gäste & Zahlungen (Filter, CSV), Gruppen, Internet & Geräte (Portal-Anmeldungen, Suche nach MAC/IP), Ticketsorten, Gutscheine, News, LANs, Einstellungen, Benutzer (Rollen, Passwort zurücksetzen, Ticket anlegen), Protokoll |

Rollen: **Gast** · **Orga** (Check-in, Zahlungen bestätigen) · **Veranstalter** (alles).

## Aufbau

```
index.html, css/, js/, img/   statische Website (GitHub Pages o. ä.)
backend/worker.js             Cloudflare Worker + D1 – EIN Endpunkt POST /api {aktion, …}
js/demo.js                    Demo-Modus: derselbe Worker läuft im Browser auf sql.js
```

## Nach jeder Änderung: Version hochzählen

`python pflege/version.py` setzt in `index.html` und allen `js/*.js` dieselbe neue `?v=`-Nummer. Ohne das sehen Besucher bis zu 10 Minuten (GitHub-Pages-Cache) die alte Fassung. Alle Importe müssen dieselbe Nummer tragen, sonst lädt der Browser ein Modul doppelt (zwei getrennte Zustände).

## Demo / lokal testen

`?demo` in der Adresse (oder `API_URL = ""` in `js/config.js`) heißt **Demo-Modus**. Der echte Worker läuft dann im Browser, die Datenbank liegt im localStorage.
Demo-Login: **Orga / demo1234** (Veranstalter). „Demo zurücksetzen“ im gelben Band stellt die Beispieldaten wieder her.

Preview-Eintrag `agelan-backend` (Port 8792) in `Tools/.claude/launch.json`.

## Live schalten (Cloudflare)

Stand: D1-Datenbank **`agelan-backend`** (ID `0f5d0df7-f716-4635-bba5-f4919ed3195b`, Westeuropa) ist angelegt, Schema eingespielt.
Website: https://tecko1985.github.io/agelan-backend/ (GitHub Pages, Branch main). Demo dort: `?demo` anhängen.

1. **D1-Datenbank** – erledigt (siehe oben). Das Schema legt der Worker sonst beim ersten Aufruf selbst an.
2. **Worker** `agelan-backend` anlegen und den Inhalt von `backend/worker.js` einfügen (ES-Modul) → Adresse `https://agelan-backend.michel-brunner.workers.dev`.
3. Beim Worker unter *Einstellungen → Bindungen*:
   - D1-Bindung **`DB`** → die Datenbank
   - Secret **`TOKEN_SECRET`** = langer Zufallswert
   - Secret **`ADMIN_SETUP`** = Veranstalter-Passwort. Damit macht sich ein Konto unter „Konto → Veranstalter werden“ zum Veranstalter.
   - Secret **`PORTAL_SECRET`** = gemeinsames Geheimnis mit dem Hallen-Portal (siehe `pflege/portal-anbindung.md`)
   - Variable **`ORIGINS`** = `https://tecko1985.github.io,https://age-lan.de,https://www.age-lan.de`
4. `js/config.js` zeigt schon auf die Worker-Adresse. Lokal testen ohne Worker: `?demo` an die Adresse hängen.
5. Konto anlegen → „Veranstalter werden“ → unter Einstellungen Zahlungsdaten, Texte (Impressum/Datenschutz/AGB) und Socials pflegen, Termin der LAN setzen.

## Offen

- **Internet-Freischaltung:** Code (5 Zeichen) entsteht beim Check-in. Das Hallen-Portal (portal.lan, DotA-LAN-Team) soll ihn per `portalAnmeldung` bei uns prüfen und MAC/IP mitschicken, siehe `pflege/portal-anbindung.md`. Unsere Seite ist fertig; offen sind das Secret `PORTAL_SECRET` und die Änderung im Portal.
- **Konto in der AgeLan-App** (Essen/Turniere) mit diesem Konto verbinden.
- Passwort-vergessen per E-Mail (aktuell: Orga setzt das Passwort zurück).
- Übernahme der alten Konten/Gäste von age-lan.de.
