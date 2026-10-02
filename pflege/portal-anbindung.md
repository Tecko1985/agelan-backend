# Anbindung des Hallen-Portals (portal.lan) an die AGE-LAN-Website

Für das Netzwerk-Team. Ziel: Gäste melden sich im Portal mit **Nickname + 5-stelligem Code** an. Den Code bekommen sie beim Check-in auf der AGE-LAN-Website. Das Portal fragt bei der Website nach, ob der Code stimmt, und meldet dabei MAC und IP des Geräts mit. So weiß die Orga später, welches Gerät zu welchem Gast und Platz gehört (Missbrauch, fremder DHCP- oder DNS-Server usw.).

## Ablauf

1. Gast wird eingecheckt. Die Website erzeugt einen Code (5 Zeichen, A–Z ohne I/O, 2–9) und zeigt ihn dem Gast auf dem Handy.
2. Gast öffnet portal.lan und gibt Nutzername (= Nickname) und Code ein.
3. Das Portal ruft per HTTPS die Website auf (siehe unten). Nur ausgehend, eingehend muss nichts geöffnet werden.
4. Antwort `ok: true` heißt: freischalten. Bei `ok: false` steht in `meldung` ein Text für den Gast.

Die Coupons von den Bechern können parallel weiterlaufen. Kennt die Website den Code nicht, prüft das Portal wie bisher selbst.

## Einfacher Endpunkt `/check_otp` (so eingebaut im Portal)

```
POST https://agelan-backend.michel-brunner.workers.dev/check_otp
Content-Type: application/json

{"username": "tecko", "otp": "ABC12"}
```

Die Antwort kommt immer mit HTTP 200 und JSON. Der eigentliche Status steht im Body:

| Body | Bedeutung |
|---|---|
| `{"status": "200", "message": "Ok"}` | freischalten |
| `{"status": "403", "message": "Nutzername oder Code falsch."}` | falscher Code, unbekannter Nick, nicht eingecheckt, gesperrt, zu viele Geräte (Text passt jeweils) |
| `{"status": "429", "message": "…"}` | zu viele Fehlversuche (je Nick 10, je Absender-IP 100 in 10 Minuten) |
| `{"status": "400", "message": "…"}` | kein JSON bzw. `username`/`otp` fehlen |
| `{"status": "405", "message": "Nur POST"}` | falsche Methode |

- **Groß/klein:** Beim Nutzernamen und beim Code ist das egal.
- **Optional:** `"mac"` und `"ip"` können mitgeschickt werden. Dann erscheinen sie in der Verwaltung unter „Internet & Geräte“ und das Geräte-Limit greift.
- **Ohne Geheimnis:** Der Endpunkt braucht kein gemeinsames Geheimnis. Gegen Durchprobieren schützen die Fehlversuch-Grenzen.

## Erweiterte Schnittstelle (mit Geheimnis, MAC/IP Pflicht)

```
POST https://agelan-backend.michel-brunner.workers.dev/api
Content-Type: application/json

{ "aktion": "portalAnmeldung", "geheimnis": "<PORTAL_SECRET>",
  "nutzer": "Tecko", "code": "K7RMX", "mac": "bc:fc:e7:06:31:5f", "ip": "10.95.41.236" }
```

| Antwort | Bedeutung |
|---|---|
| `200 {"ok":true,"nick":"Tecko","platz":"A1","ticketId":12}` | freischalten |
| `200 {"ok":false,"meldung":"Nutzername oder Code falsch.","grund":"falscher Code"}` | nicht freischalten, `meldung` anzeigen |
| `400` | MAC fehlt oder ist ungültig |
| `403` | falsches Geheimnis |
| `429` | zu viele Versuche mit falschem Geheimnis |
| `503` | auf der Website ist noch kein `PORTAL_SECRET` gesetzt |

- **MAC-Schreibweise:** `aa:bb:cc:dd:ee:ff`, `AA-BB-…` und `aabb.ccdd.eeff` gehen alle.
- **Groß/klein:** Beim Nutzernamen und beim Code ist das egal.
- **Geräte-Limit:** Je Code sind höchstens 3 Geräte erlaubt. Die Zahl lässt sich in der Verwaltung einstellen. Ein Gerät, das schon einmal angemeldet war, kommt immer wieder rein.
- **Fehlversuche:** Nach 10 Fehlversuchen von derselben MAC innerhalb von 10 Minuten lehnt die Website ab.
- **Protokoll:** Jeder Aufruf wird gespeichert, auch Fehlversuche. Die Orga sieht ihn in der Verwaltung unter „Internet & Geräte“ und kann dort nach MAC, IP, Nick oder Platz suchen.

## PHP-Schnipsel

```php
<?php
// Geheimnis NICHT ins Git/öffentliche Verzeichnis – z. B. aus einer Datei außerhalb des Webroots laden.
define('AGELAN_PORTAL_SECRET', trim(file_get_contents('/etc/portal/agelan-secret')));

// Prüft Nutzername + Code bei der AGE-LAN-Website.
// Rückgabe: ['ok' => bool, 'meldung' => string, 'nick' => string, 'erreichbar' => bool]
function agelan_pruefen(string $nutzer, string $code, string $mac, string $ip): array {
    $ch = curl_init('https://agelan-backend.michel-brunner.workers.dev/api');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'aktion' => 'portalAnmeldung', 'geheimnis' => AGELAN_PORTAL_SECRET,
            'nutzer' => $nutzer, 'code' => $code, 'mac' => $mac, 'ip' => $ip,
        ]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT => 5,
    ]);
    $antwort = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $j = json_decode((string)$antwort, true);
    if ($status === 200 && is_array($j)) {
        return ['ok' => !empty($j['ok']), 'meldung' => $j['meldung'] ?? '', 'nick' => $j['nick'] ?? '', 'erreichbar' => true];
    }
    error_log('AGE-LAN-Portalprüfung: HTTP ' . $status . ' ' . ($j['error'] ?? ''));
    return ['ok' => false, 'meldung' => '', 'nick' => '', 'erreichbar' => false];
}

// Im bestehenden POST-Handler (Felder u = Nutzername, p = Token/Code):
// $r = agelan_pruefen($_POST['u'] ?? '', $_POST['p'] ?? '', $mac, $ip);
// if ($r['ok']) {
//     /* Gerät freischalten wie bisher */
// } elseif (/* Becher-Coupon gültig */) {
//     /* wie bisher */
// } else {
//     $fehler = $r['meldung'] ?: 'Nutzername oder Code falsch.';
// }
```

## Einrichtung

1. **Geheimnis erzeugen:** Michel erzeugt ein langes Zufallsgeheimnis, z. B. mit `openssl rand -hex 32`.
2. **Bei Cloudflare eintragen:** Im Cloudflare-Dashboard beim Worker `agelan-backend` unter *Einstellungen → Variablen und Geheimnisse* als **Secret `PORTAL_SECRET`** eintragen.
3. **An das Netzwerk-Team geben:** Dasselbe Geheimnis auf sicherem Weg weitergeben, nicht im öffentlichen Discord.
4. **Code prüfen:** In der Verwaltung unter „Internet & Geräte → Code testen“ lässt sich ohne Portal prüfen, ob ein Code passt.
5. **Datenschutz:** Die Geräte-Einträge löschen sich nach 30 Tagen von selbst (einstellbar). Der Absatz dazu steht in der Datenschutzerklärung unter Punkt 5.

## Tipp gegen fremde DHCP-Server

Am besten verhindert man die Netzstörung gleich an den Switches mit **DHCP Snooping**, sodass nur der Port des echten DHCP-Servers „trusted“ ist. Über die Geräte-Liste findet man dann nur noch heraus, wer es war.
