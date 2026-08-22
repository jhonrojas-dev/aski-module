# Aski — Odoo connector module (`aski_connector`)

Módulo puente para publicar en el **Odoo App Store** (apps.odoo.com). Hace dos
cosas, y las dos van de lo mismo: acercar Aski al Odoo del cliente sin que tenga
que teclear URL / base de datos / API key a mano.

1. **Conectar la app móvil** — un asistente genera un código (QR) que la app Aski
   escanea. Cero configuración manual.
2. **Chatear dentro de Odoo** — un panel de chat (OWL) bajo *Aski → Chat* y una
   burbuja en la barra superior. Misma cuenta, mismo monedero y **mismo motor**
   que la app y la web: no es un producto aparte, es otro canal. Incluye
   historial, exportar a PDF, análisis profundo (si el plan lo incluye) y alta de
   cuenta sin salir de Odoo.

- Compatible **Odoo 14 → 19** (Community y Enterprise).
- **Una rama por serie** (`14.0` … `19.0`). El Python es idéntico en las seis; lo
  que cambia por serie es la capa web: `attrs` en las vistas (14–16), OWL 1 en el
  widget (14–15) y el modelo de seguridad de la 19 (`res.groups.privilege`).
  ⚠️ Todo arreglo se porta a las **seis** ramas, no solo a la más nueva.
- El módulo **no saca datos de Odoo por su cuenta**: el chat habla con el backend
  de Aski usando el token personal del propio usuario, igual que la app. La
  lectura del ERP la hace Aski por el **API externo estándar** (XML-RPC) con una
  **API key** de Odoo (`res.users.apikeys`, estándar desde la 14) generada para el
  usuario actual y revocable cuando quieras.

## Estructura

```
aski_connector/
  __manifest__.py                    # build_releases estampa la version por serie
  models/
    aski_common.py                   # base de la API, co-marca, cifrado, API keys
    aski_connect_wizard.py           # asistente del QR (app movil)
    aski_chat_connect_wizard.py      # alta / inicio de sesion / token (chat)
    aski_account_link.py             # cuenta conectada + todas las llamadas al chat
  views/
    aski_connect_views.xml           # asistente 2 pasos (intro -> QR)
    aski_chat_views.xml              # ajustes del chat + accion del widget + menus
  security/
    aski_security.xml                # grupo "Use the Aski chat"
    ir.model.access.csv
  static/src/chat/                   # widget OWL: js + xml + scss
  static/src/systray/                # burbuja flotante de la barra superior
  static/description/                # ficha de la tienda (index.html, icono, capturas)
  i18n/                              # de, es, fr, it, nl, pt_BR
build_releases.py                    # empaqueta 1 .zip por serie (14.0 ... 19.0)
```

## Verificar los cambios (las 6 versiones)

Instancias QA locales en `aski-app/infra/odoo-qa` (puertos 8514–8519, `admin` /
`aski-qa`). Se levantan **de una en una**:

```bash
docker compose -f aski-app/infra/odoo-qa/docker-compose.yml up -d odoo19
docker exec aski-qa-odoo19 odoo -u aski_connector -d aski19 --stop-after-init --no-http
```

Y se comprueba en el navegador de verdad, no leyendo el código
(`~/Documents/aski-pw`, requiere Playwright):

```bash
node aski_connector_ui_check.mjs 19    # bundle vivo, widget montado, consola limpia
node aski_connector_states.mjs 19      # los 4 estados + XSS + cajon + modo profundo
```

`aski_connector_states.mjs` intercepta las llamadas ORM, así que fuerza cada
estado (incluido el de error) **sin** backend y sin gastar créditos.

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
