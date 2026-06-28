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
MODULE_VERSION = "1.0.0"  # tu version interna del modulo (no la serie de Odoo)
SERIES = ["14", "15", "16", "17", "18", "19"]


def _stamp_manifest(path, series):
    with open(path, "r", encoding="utf-8") as fh:
        txt = fh.read()
    new = f'"version": "{series}.0.{MODULE_VERSION}"'
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
        _stamp_manifest(os.path.join(dest, "__manifest__.py"), series)
        zip_path = os.path.join(DIST, f"aski_connector-{series}.0.zip")
        _zip_dir(dest, zip_path)
        shutil.rmtree(stage)
        print(f"  OK  {series}.0  ->  {os.path.relpath(zip_path, HERE)}")
    print("\nListo. Sube cada .zip a la rama/serie correspondiente en "
          "https://apps.odoo.com (o usa el repo en GitHub conectado a la tienda).")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a in SERIES]
    main(args or SERIES)
