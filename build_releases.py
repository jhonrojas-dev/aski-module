#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Empaqueta el modulo `aski_connector` para CADA serie de Odoo (14 -> 19).

La tienda de Odoo (apps.odoo.com) determina la serie por el prefijo de la
version del manifest (p.ej. "16.0.x.y.z") y/o por la rama a la que subes. Este
script copia el modulo una vez por serie, estampa la version correcta en
__manifest__.py y genera un .zip listo para subir.

Uso:
    py -X utf8 build_releases.py
    py -X utf8 build_releases.py 16 17        # solo esas series

Salida:  dist/aski_connector-<serie>.0.zip  (uno por serie)
"""
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "aski_connector")
DIST = os.path.join(HERE, "dist")
SERIES = ["14", "15", "16", "17", "18", "19"]


def _module_version():
    """Version interna del modulo, LEIDA del manifest (no hardcodeada aqui).

    Antes era una constante `MODULE_VERSION = "1.0.0"` que se quedo congelada
    mientras el manifest avanzaba a 1.1.x: los zips salian estampados como
    `<serie>.0.1.0.0`, o sea una version MAS VIEJA que la publicada -> la tienda
    los habria tomado como una regresion. Con una sola fuente de verdad no puede
    volver a desincronizarse."""
    manifest = os.path.join(SRC, "__manifest__.py")
    with open(manifest, "r", encoding="utf-8") as fh:
        m = re.search(r'"version"\s*:\s*"([^"]+)"', fh.read())
    if not m:
        sys.exit("No pude leer 'version' del manifest")
    ver = m.group(1)
    # Si ya viniera estampada como "18.0.1.2.0", quedarse con la parte del modulo.
    parts = ver.split(".")
    if len(parts) == 5:
        return ".".join(parts[2:])
    return ver


def _stamp_manifest(path, series, module_version):
    with open(path, "r", encoding="utf-8") as fh:
        txt = fh.read()
    new = f'"version": "{series}.0.{module_version}"'
    txt2 = re.sub(r'"version"\s*:\s*"[^"]*"', new, txt, count=1)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(txt2)


def _zip_dir(folder, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(folder):
            for f in files:
                if f.endswith((".pyc",)) or "__pycache__" in root:
                    continue
                full = os.path.join(root, f)
                # arcname relativo al padre de la carpeta (incluye 'aski_connector/')
                arc = os.path.relpath(full, os.path.dirname(folder))
                zf.write(full, arc)


def main(series_list):
    if not os.path.isdir(SRC):
        sys.exit(f"No encuentro el modulo en {SRC}")
    module_version = _module_version()
    print(f"Version del modulo (del manifest): {module_version}\n")
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)
    for series in series_list:
        stage = os.path.join(DIST, f"build-{series}")
        dest = os.path.join(stage, "aski_connector")
        shutil.copytree(
            SRC, dest,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        _stamp_manifest(os.path.join(dest, "__manifest__.py"), series, module_version)
        zip_path = os.path.join(DIST, f"aski_connector-{series}.0.zip")
        _zip_dir(dest, zip_path)
        shutil.rmtree(stage)
        print(f"  OK  {series}.0.{module_version}  ->  {os.path.relpath(zip_path, HERE)}")
    print("\nListo. Sube cada .zip a la rama/serie correspondiente en "
          "https://apps.odoo.com (o usa el repo en GitHub conectado a la tienda).")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a in SERIES]
    main(args or SERIES)
