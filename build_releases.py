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
import subprocess
import sys
import tarfile
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


def _export_branch(series, dest_parent):
    """Extrae el modulo desde la RAMA de esa serie (origin/<serie>.0), no desde
    el directorio de trabajo.

    ⚠️ Esto NO es un detalle: las series NO comparten el mismo frontend.
      * 16-19 -> OWL 2 (import de "@odoo/owl", t-out, registries de wowl)
      * 15    -> OWL 1.4 sobre wowl (owl global, t-raw, assets_qweb)
      * 14    -> OWL 1.4 sobre el web client legacy (odoo.define, ComponentWrapper,
                 SystrayMenu/action_registry, assets por XML)
    Empaquetar todas las series desde una sola copia (lo que hacia antes) meteria
    el codigo OWL 2 en los zips de 14/15 -> el chat NO cargaria ahi. Cada rama es
    la fuente de verdad de su serie.
    """
    ref = f"origin/{series}.0"
    try:
        subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref],
                       cwd=HERE, check=True, stdout=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        sys.exit(f"No existe la rama {ref}. Corre `git fetch origin` primero.")
    os.makedirs(dest_parent, exist_ok=True)
    tar_path = os.path.join(dest_parent, "m.tar")
    with open(tar_path, "wb") as fh:
        subprocess.run(["git", "archive", ref, "aski_connector"],
                       cwd=HERE, check=True, stdout=fh)
    with tarfile.open(tar_path) as tf:
        tf.extractall(dest_parent)
    os.remove(tar_path)
    return os.path.join(dest_parent, "aski_connector")


def main(series_list):
    subprocess.run(["git", "fetch", "-q", "origin"], cwd=HERE, check=False)
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)
    for series in series_list:
        stage = os.path.join(DIST, f"build-{series}")
        dest = _export_branch(series, stage)
        # la version ya viene estampada en la rama; se re-estampa por si acaso
        mf = os.path.join(dest, "__manifest__.py")
        with open(mf, "r", encoding="utf-8") as fh:
            cur = re.search(r'"version"\s*:\s*"([^"]+)"', fh.read()).group(1)
        parts = cur.split(".")
        modver = ".".join(parts[2:]) if len(parts) == 5 else cur
        _stamp_manifest(mf, series, modver)
        zip_path = os.path.join(DIST, f"aski_connector-{series}.0.zip")
        _zip_dir(dest, zip_path)
        shutil.rmtree(stage)
        print(f"  OK  {series}.0.{modver}  (de origin/{series}.0)  ->  "
              f"{os.path.relpath(zip_path, HERE)}")
    print("\nListo. Sube cada .zip a la rama/serie correspondiente en "
          "https://apps.odoo.com (o usa el repo en GitHub conectado a la tienda).")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a in SERIES]
    main(args or SERIES)
