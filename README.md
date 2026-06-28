# Aski — Odoo connector module (`aski_connector`)

Módulo puente **ligero** para publicar en el **Odoo App Store** (apps.odoo.com).
Su único trabajo: que un admin conecte su Odoo con la app **Aski** en 1 paso
(escanear un QR), sin teclear URL / base de datos / API key a mano.

- Compatible **Odoo 14 → 19** (Community y Enterprise).
- **Un solo código** para todas las series: sin `attrs`, sin `res.config.settings`
  (esas son las dos cosas que cambian de sintaxis entre 14–16 y 17–19).
- No saca datos de Odoo: solo muestra el código. La app Aski se conecta por el
  **API externo estándar** (XML-RPC) con una **API key** de Odoo (`res.users.apikeys`,
  estándar desde la 14) generada para el usuario actual; revocable cuando quieras.

## Estructura

```
aski_connector/
  __manifest__.py            # version "1.0.0" (build_releases la estampa por serie)
  models/aski_connect_wizard.py
  views/aski_connect_views.xml   # wizard 2 pasos (intro -> QR)
  security/ir.model.access.csv   # solo base.group_system (admin)
  static/description/
    index.html               # ficha de la tienda
    icon.png                 # ícono del módulo/app
    banner.png               # imagen principal de la ficha
build_releases.py            # empaqueta 1 .zip por serie (14.0 ... 19.0)
```

## Probarlo en un Odoo local (dev)

1. Copia `aski_connector/` a tu carpeta de addons (o monta el repo en `addons-path`).
2. Reinicia Odoo con `-u all` o activa modo desarrollador y
   **Apps → Actualizar lista de aplicaciones**.
3. Busca **"Aski"**, instala. Aparece un menú **Aski → Connect**.
4. **Connect → Generate connection code** → debe mostrar el QR + el token.

Requiere la librería `qrcode` (ya viene con Odoo, se usa en 2FA). Si faltara, el
wizard muestra solo el token de texto (sin imagen).

## Empaquetar para la tienda (las 6 versiones)

```bash
py -X utf8 build_releases.py          # genera dist/aski_connector-14.0.zip ... -19.0.zip
py -X utf8 build_releases.py 17 18    # solo algunas series
```

## Publicar en apps.odoo.com

1. Entra a https://apps.odoo.com con tu cuenta odoo.com → **My Apps / Upload**.
2. Sube el `.zip` de cada serie (o conecta este repo de GitHub a la tienda, con
   una rama por serie: `14.0`, `15.0`, …, `19.0`).
3. Completa la ficha: nombre, resumen, descripción (sale de `index.html`),
   capturas, **precio = Free**, licencia **LGPL-3**.
4. Envía a revisión. Odoo valida calidad/guidelines antes de publicar.

> El cobro vive en aski.dev (planes). El módulo es gratis = anzuelo + sello de
> confianza + descubrimiento orgánico.

## Token / QR — formato

El QR contiene: `aski://connect?t=<base64url(json)>` con
`{"v":1,"url":<base_url>,"db":<db>,"login":<login>,"key":<api_key>}`.
La app Aski lo decodifica y crea la conexión Odoo con esos 4 datos.

## Limitación conocida

Los Odoo en **Odoo Online (SaaS de odoo.com)** no permiten instalar módulos de
terceros → para esos usuarios sigue disponible el alta manual (URL + API key) en
la app. El conector sirve a **self-hosted y Odoo.sh**.
