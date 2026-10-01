"""Versionsnummer für alle eigenen JS/CSS-Dateien hochzählen (Cache-Busting).

GitHub Pages liefert mit max-age=600 aus – ohne neue ?v= sehen Besucher bis
zu 10 Minuten (bei ES-Modulen oft länger) die alte Fassung. Nach JEDER
Änderung an js/, css/ oder backend/worker.js ausführen:

    python pflege/version.py
"""
import pathlib, re

wurzel = pathlib.Path(__file__).resolve().parent.parent
dateien = [wurzel / "index.html", *sorted((wurzel / "js").glob("*.js"))]
muster = re.compile(r'((?:\./|\.\./|js/|css/)[\w/.-]+\.(?:js|css))(\?v=(\d+))?(?=["\'])')

alt = 0
for d in dateien:
    for m in muster.finditer(d.read_text(encoding="utf-8")):
        if m.group(3):
            alt = max(alt, int(m.group(3)))
neu = alt + 1
for d in dateien:
    text = d.read_text(encoding="utf-8")
    d.write_text(muster.sub(lambda m: m.group(1) + "?v=" + str(neu), text), encoding="utf-8")
print("Version", neu)
