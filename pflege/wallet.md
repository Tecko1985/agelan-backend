# Ticket in die Wallet (Apple / Google)

Der Worker erzeugt die Pässe selbst:

| Adresse | Ergebnis |
|---|---|
| `https://agelan-backend.michel-brunner.workers.dev/wallet/apple/<ticket-code>` | `.pkpass`-Datei, das iPhone fragt „Zur Wallet hinzufügen?“ |
| `https://agelan-backend.michel-brunner.workers.dev/wallet/google/<ticket-code>` | Weiterleitung zu „In Google Wallet speichern“ |

- **Ticket-Code:** `<ticket-code>` sind die 32 Hex-Zeichen des Tickets, wie im Ticket-QR.
- **Später in der E-Mail:** Die Links kann man genau so in die Bestätigungs-E-Mail setzen.
- **Inhalt des Passes:** Gast (Nick), Platz, Termin, Ticketsorte und Zahlungsstatus. Der QR-Code ist **derselbe wie auf dem Ticket**: Der Check-in-Scanner erkennt ihn, und für den Gast öffnet er nach dem Check-in die Internet-Zugangsdaten.
- **Knöpfe auf der Website:** Im Konto unter „Dein Ticket“ und auf der Ticket-Seite erscheinen die Knöpfe automatisch, sobald die Secrets unten gesetzt sind. Fehlen sie, sieht niemand einen Knopf.
- **Keine Aktualisierung:** Ändern sich Platz oder Zahlungsstatus später, aktualisiert sich ein schon gespeicherter Pass nicht. Dann den Pass erneut hinzufügen. Automatische Updates bräuchten einen zusätzlichen Apple-Webservice bzw. die Google-API, das kann man später nachrüsten.

Alle Werte kommen als **Secret** in den Worker `agelan-backend` (Cloudflare → Worker → Einstellungen → Variablen und Geheimnisse). Bitte als Secret anlegen, nicht als Text-Variable, sonst überschreibt sie das nächste Hochladen.

## Apple Wallet

Dafür ist ein **Apple-Developer-Konto** nötig (99 €/Jahr).

1. **Pass Type ID anlegen:** developer.apple.com → Certificates, IDs & Profiles → Identifiers → **Pass Type IDs**, z. B. `pass.de.age-lan.ticket`.
2. **Zertifikat erzeugen:** Zur Pass Type ID ein Zertifikat erstellen. Apple will dafür eine CSR, die geht in Git Bash so:
   ```bash
   openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr -subj "/CN=AGE-LAN Pass"
   ```
   Die CSR hochladen und `pass.cer` herunterladen.
3. **In PEM umwandeln:**
   ```bash
   openssl x509 -inform DER -in pass.cer -out pass.pem
   ```
4. **Apple-WWDR-Zwischenzertifikat** **G4** von apple.com/certificateauthority herunterladen und ebenso umwandeln:
   ```bash
   openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
   ```
5. **Secrets setzen:**

   | Secret | Inhalt |
   |---|---|
   | `APPLE_PASS_TYPE_ID` | z. B. `pass.de.age-lan.ticket` |
   | `APPLE_TEAM_ID` | Team-ID aus dem Developer-Konto (10 Zeichen) |
   | `APPLE_PASS_CERT` | kompletter Inhalt von `pass.pem` |
   | `APPLE_PASS_KEY` | kompletter Inhalt von `pass.key` (`BEGIN PRIVATE KEY` oder `BEGIN RSA PRIVATE KEY`) |
   | `APPLE_WWDR_CERT` | kompletter Inhalt von `wwdr.pem` |

`pass.key` ist geheim, also nicht ins Git, nicht in den Chat und nicht per Mail.

## Google Wallet

Kostenlos, braucht aber ein Google-Konto.

1. **Issuer-Konto anlegen:** pay.google.com/business/console → Google Wallet API, die **Issuer-ID** notieren (lange Zahl).
2. **Dienstkonto anlegen:** console.cloud.google.com → Projekt anlegen → „Google Wallet API“ aktivieren → IAM → **Dienstkonto** anlegen → Schlüssel als **JSON** herunterladen.
3. **Dienstkonto berechtigen:** In der Wallet-Console unter „Users“ die E-Mail des Dienstkontos als Developer hinzufügen.
4. **Secrets setzen:**

   | Secret | Inhalt |
   |---|---|
   | `GOOGLE_WALLET_ISSUER_ID` | die Issuer-ID |
   | `GOOGLE_WALLET_KEY` | kompletter Inhalt der JSON-Datei |

Solange Google das Konto nicht für den Live-Betrieb freigegeben hat, funktioniert „Speichern“ nur für Test-Nutzer, die in der Console eingetragen sind. Die Freigabe beantragt man dort mit Beispiel-Screenshots.

## Getestet

Mit einem selbst erzeugten Test-Zertifikat geprüft:
- `.pkpass`: ZIP-Aufbau, `manifest.json` (SHA-1 aller Dateien) und PKCS#7-Signatur, Prüfung mit `openssl cms -verify`.
- Google-JWT: RS256-Signatur, Prüfung mit `openssl dgst -verify`.

Mit echten Apple- oder Google-Konten ist es noch nicht getestet.
