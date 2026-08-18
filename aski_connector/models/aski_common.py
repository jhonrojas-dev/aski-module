# -*- coding: utf-8 -*-
import base64
import hashlib
import io
import json
import logging

from odoo import _, api, models
from odoo.exceptions import UserError
from odoo.tools import config

_logger = logging.getLogger(__name__)

try:
    from cryptography.fernet import Fernet, InvalidToken
except Exception:  # pragma: no cover
    Fernet = None
    InvalidToken = Exception

# Backend real de Aski (mismo motor determinista + narrador + wallet que usa
# la app Android) — no es una instancia de cliente, es la infraestructura
# propia del producto (igual que api.anthropic.com en jjro_ai_engine).
ASKI_API_BASE = "https://api.aski.dev"


class AskiCreditsError(UserError):
    """Se acabaron los creditos.

    Clase propia y no un UserError normal porque el chat necesita distinguir
    ESTE fallo: es el unico en el que ofrecer "recargar" ayuda. El resto
    (ERP caido, token vencido, permisos) no se arregla pagando, y el boton
    empujaba a gastar dinero en vano. Odoo serializa el nombre de la clase en
    `data.name` de la respuesta RPC, asi que el widget lo reconoce sin tener que
    leer el texto del mensaje —que ademas esta traducido a seis idiomas—.
    """


def aski_api_base(env):
    """URL del backend. Es SIEMPRE la de produccion salvo que el administrador
    del servidor la sobreescriba, cosa que solo hace falta para probar contra un
    backend local o de staging sin tocar codigo:

      - `aski_connector_api_base` en odoo.conf (server-side), o
      - el parametro de sistema `aski_connector.api_base`.

    Ambas vias exigen ser administrador del sistema, que es quien ya controla la
    instancia entera — no abre nada que no estuviera abierto.
    """
    base = (config.get("aski_connector_api_base") or "").strip()
    if not base:
        try:
            base = (env["ir.config_parameter"].sudo().get_param(
                "aski_connector.api_base") or "").strip()
        except Exception:  # noqa: BLE001
            base = ""
    return (base or ASKI_API_BASE).rstrip("/")


# ---------------------------------------------------------------------------
# Que direccion de ESTE Odoo se le da a Aski
# ---------------------------------------------------------------------------
# Aski consulta el Odoo del cliente DESDE INTERNET. Hasta ahora la direccion
# salia siempre de `web.base.url`, que el cliente nunca teclea y que en muchas
# instalaciones conserva el default de Odoo (`http://localhost:8069`) o el valor
# de la instancia de la que se restauro la base — muy comun en bases duplicadas
# o neutralizadas para pruebas. Con esa direccion el backend se conecta contra si
# mismo: la conexion se creaba "bien" y TODAS las preguntas fallaban despues
# (caso 2026-08-18).
#
# La senal mas fiable es la peticion en curso: la direccion con la que el usuario
# esta entrando a Odoo AHORA MISMO le funciona por definicion. Se prueba primero
# esa, luego `web.base.url`, y solo si ninguna sirve se le pide al usuario. Asi el
# caso normal sigue siendo cero configuracion.

_HOST_PRIVADO_SUFIJOS = (
    ".local", ".localhost", ".internal", ".intranet", ".lan",
    ".home.arpa", ".test", ".invalid", ".example",
)
_HOST_PRIVADO_EXACTO = ("localhost", "ip6-localhost", "ip6-loopback")


def aski_url_host(url):
    """Host (sin esquema, puerto ni credenciales) de una URL, en minusculas."""
    try:
        from urllib.parse import urlsplit
        return (urlsplit((url or "").strip()).hostname or "").strip().rstrip(".").lower()
    except Exception:  # noqa: BLE001
        return ""


def aski_is_private_url(url):
    """True si esa direccion solo existe dentro de la red del cliente y por tanto
    Aski no puede alcanzarla. Mismo criterio que aplica el backend al guardar la
    conexion; se repite aqui para avisar ANTES de mandar nada."""
    raw = (url or "").strip()
    if not raw.lower().startswith(("http://", "https://")):
        return True
    host = aski_url_host(raw)
    if not host:
        return True
    if host in _HOST_PRIVADO_EXACTO or host.endswith(_HOST_PRIVADO_SUFIJOS):
        return True
    try:
        import ipaddress
        ip = ipaddress.ip_address(host)
    except ValueError:
        # No es una IP: una etiqueta unica (`odoo`, `servidor`) no existe en el
        # DNS publico, solo en el interno de esa red.
        return "." not in host
    except Exception:  # noqa: BLE001
        return False
    return bool(ip.is_loopback or ip.is_private or ip.is_link_local
                or ip.is_reserved or ip.is_unspecified or ip.is_multicast)


def aski_request_base_url():
    """Direccion con la que el navegador esta llegando a este Odoo, o "".

    `request` no existe fuera de una peticion web (cron, `odoo shell`, tests), y
    detras de un proxy inverso solo refleja el host externo si Odoo corre en
    modo proxy — por eso es una CANDIDATA, nunca la verdad absoluta.
    """
    try:
        from odoo.http import request
        return (request.httprequest.host_url or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def aski_url_candidates(env, override=""):
    """Direcciones a probar, de mas a menos fiable y sin repetir.

    Lo que el usuario escribe manda: si lo tecleo, es porque las automaticas no
    servian. La ultima es `web.base.url` aunque parezca privada, para que el caso
    raro en que el backend SI puede alcanzarla (Aski desplegado dentro de la
    misma red) siga funcionando y sea el backend quien decida.
    """
    base_url = ""
    try:
        base_url = (env["ir.config_parameter"].sudo().get_param("web.base.url") or "").strip()
    except Exception:  # noqa: BLE001
        base_url = ""
    crudas = [(override or "").strip(), aski_request_base_url(), base_url]
    fuera = [u.rstrip("/") for u in crudas if u and not aski_is_private_url(u)]
    if base_url:
        fuera.append(base_url.rstrip("/"))
    vistas, orden = set(), []
    for u in fuera:
        if u.lower() not in vistas:
            vistas.add(u.lower())
            orden.append(u)
    return orden


# Lockup "Aski x <socio>". Se genera aqui, en un solo sitio, porque lo pintan
# tanto el asistente de conexion como la pantalla de ajustes. Los estilos van EN
# LINEA a proposito: un campo Html de un formulario no arrastra el CSS del
# modulo de forma fiable, y este bloque tiene que verse igual siempre.
#
# Las reglas de pintado (placa detras de un logo oscuro, mas alto si el logo es
# vertical) las decide el BACKEND y viajan en logo_is_light / logo_is_tall, para
# que Odoo, la app y la web muestren exactamente lo mismo.
_COBRAND_NAVY = "#152642"
_COBRAND_GOLD = "#E8C058"


def aski_cobrand_html(env, name, logo_url="", is_light=False, is_tall=False):
    """Markup del lockup, o cadena vacia si no hay socio que presentar."""
    from markupsafe import Markup
    from odoo.tools import html_escape

    name = (name or "").strip()
    if not name:
        return ""
    logo = ""
    if logo_url:
        src = logo_url if logo_url.startswith("http") else aski_api_base(env) + logo_url
        # Logo claro: sin placa (el navy ya le da contraste). Oscuro: con placa,
        # o desaparece contra el fondo.
        plate = ("" if is_light
                 else "background:#fff;border-radius:5px;padding:3px 6px;")
        logo = (
            '<img src="%s" alt="" style="max-height:%dpx;max-width:190px;'
            'object-fit:contain;flex-shrink:0;display:block;%s"/>'
            % (html_escape(src), 68 if is_tall else 46, plate)
        )
    return Markup(
        '<div style="background:%s;border-radius:10px;padding:9px 12px;'
        'display:flex;align-items:center;gap:12px;">'
        '<div style="flex:1;min-width:0;">'
        '<div style="display:flex;align-items:center;gap:7px;">'
        '<span style="color:%s;font-weight:800;font-size:15px;">Aski</span>'
        '<span style="color:rgba(255,255,255,.5);font-weight:600;">&#215;</span>'
        '<span style="color:#fff;font-weight:800;font-size:15px;">%s</span>'
        '</div>'
        '<div style="color:rgba(255,255,255,.78);font-size:11.5px;margin-top:3px;">'
        '%s</div></div>%s</div>'
        % (_COBRAND_NAVY, _COBRAND_GOLD, html_escape(name),
           html_escape(_("Aski's technology, delivered by your partner.")), logo)
    )


def aski_cobrand_html_current(env):
    """Lockup que toca mostrar AHORA, mirando primero la cuenta conectada.

    Existe para poder guardar el markup en un campo normal en vez de calcularlo
    al vuelo: un campo Html COMPUTADO y no almacenado no le llega al cliente web
    en las series viejas (Odoo 16 lo descarta del formulario entero), mientras
    que un valor por defecto o guardado llega siempre.
    """
    link = env["aski.account.link"]._active_link(env.user)
    if link and link.partner_managed and link.partner_show_cobrand and link.partner_name:
        return aski_cobrand_html(
            env, name=link.partner_name, logo_url=link.partner_logo_url,
            is_light=link.partner_logo_is_light, is_tall=link.partner_logo_is_tall)
    return aski_cobrand_html_from_code(env)


def aski_cobrand_html_from_code(env):
    """Lockup resuelto por el codigo configurado en la instancia (caso FRIO:
    aun no hay cuenta conectada). Vacio si no hay codigo o la API no responde."""
    data = aski_partner_branding(env)
    if not data:
        return ""
    return aski_cobrand_html(
        env, name=data["name"], logo_url=data["logo_url"],
        is_light=data["logo_is_light"], is_tall=data["logo_is_tall"])


# Marca del socio resuelta por su codigo, cacheada en memoria del worker.
# {codigo: (momento, datos_o_None)}. Se cachea TAMBIEN el fallo para que un
# codigo mal escrito no dispare una peticion cada vez que alguien abre el
# dialogo. La marca de un socio cambia muy de vez en cuando -> 15 min sobra.
_BRANDING_CACHE = {}
_BRANDING_TTL = 900


def aski_partner_branding(env, code=None):
    """Nombre y logo PUBLICOS del socio dueño del codigo, o None.

    Sirve para presentar la co-marca ANTES de que exista cuenta conectada (con
    la cuenta ya conectada esto no hace falta: /billing/me trae los mismos
    datos). Nunca revienta: si la API no responde, el dialogo simplemente sale
    sin co-marca.
    """
    import time

    import requests

    code = (code if code is not None else (aski_partner_code(env) or "")).strip().upper()
    if not code:
        return None
    hit = _BRANDING_CACHE.get(code)
    if hit and (time.time() - hit[0]) < _BRANDING_TTL:
        return hit[1]
    data = None
    try:
        resp = requests.get(
            "%s/partner/by-code/%s" % (aski_api_base(env), code), timeout=6)
        if resp.status_code == 200:
            body = resp.json()
            # Si el socio apago la co-marca presenta el servicio como propio:
            # no se pinta el lockup "Aski x <socio>".
            if body.get("show_cobrand", True):
                data = {
                    "name": body.get("name") or "",
                    "logo_url": body.get("logo_url") or "",
                    "logo_is_light": bool(body.get("logo_is_light")),
                    "logo_is_tall": bool(body.get("logo_is_tall")),
                }
    except Exception as e:  # noqa: BLE001
        _logger.debug("Aski: no se pudo resolver la marca del socio: %s", e)
        # El fallo de red NO se cachea: al reintentar puede haber vuelto.
        return None
    _BRANDING_CACHE[code] = (time.time(), data)
    return data


def aski_partner_code(env):
    """Codigo del socio (reseller) preconfigurado en ESTA instancia, si lo hay.

    Existe porque en la practica quien instala el modulo suele ser el propio
    socio, montandolo en el Odoo de su cliente. Dejandolo aqui, el codigo viaja
    solo al darse de alta: el cliente no tiene que teclearlo (ni acordarse), que
    era justo donde se perdia la atribucion del socio.

    Se lee de `aski_connector_partner_code` en odoo.conf o del parametro de
    sistema `aski_connector.partner_code`. Vacio = no se preselecciona nada y el
    campo queda libre, como antes.

    No es un candado: un administrador de la instancia puede cambiarlo o
    borrarlo. Para blindar de verdad la relacion, el socio debe ASIGNARLE el plan
    al cliente desde su panel (ahi la cuenta queda gestionada por el socio y no
    puede comprar directo).
    """
    code = (config.get("aski_connector_partner_code") or "").strip()
    if not code:
        try:
            code = (env["ir.config_parameter"].sudo().get_param(
                "aski_connector.partner_code") or "").strip()
        except Exception:  # noqa: BLE001
            code = ""
    # Mismo alfabeto que `invite_code` del backend: [A-Z0-9], hasta 16.
    return "".join(c for c in code.upper() if c.isalnum() and c.isascii())[:16]


class AskiKeyMixin(models.AbstractModel):
    """Helpers compartidos por los DOS flujos de conexion de Aski: el QR para
    la app movil (`aski.connect.wizard`) y el pairing por token para el chat
    embebido (`aski.chat.connect.wizard`). Evita duplicar la generacion/rotacion
    de la API key de Odoo y el cifrado en reposo entre ambos."""
    _name = "aski.key.mixin"
    _description = "Aski - shared connection helpers"

    # ------------------------------------------------------------------
    # API key de Odoo (res.users.apikeys) — usada por AMBOS flujos para que
    # el backend de Aski pueda hacer XML-RPC contra esta instancia como el
    # usuario actual.
    # ------------------------------------------------------------------
    def _aski_generate_api_key(self, name):
        """Genera una API key de Odoo (scope 'rpc') para EL USUARIO ACTUAL, con
        la que el backend de Aski hace XML-RPC contra esta instancia como ese
        usuario (sin escalar permisos).

        Se genera bajo `sudo()`, y esto es imprescindible para que funcione con
        CUALQUIER usuario (no solo un administrador) en CUALQUIER instancia:

        1. Desde Odoo 18, un usuario que NO pertenece al grupo Ajustes solo
           puede crear una API key CON fecha de expiracion
           (`res.users.apikeys._check_expiration_date` lanza "The API key must
           have an expiration date"); unicamente un usuario de sistema puede
           crear una key PERSISTENTE. Sin `sudo()`, un usuario normal (p.ej. un
           vendedor conectando su propia cuenta en modo 'per_user') no podia
           conectar. Y la key TIENE que ser persistente: la usa el backend de
           forma continua, una que caduque cortaria la conexion sin aviso.
           `sudo()` pone el entorno en modo superusuario -> `env.is_system()` es
           True -> se admite la key sin caducidad. Es el patron que la propia
           doc de `_generate` sanciona ("must be called in sudo to use a
           duration greater than that allowed by the user's privileges").
        2. `sudo()` eleva el privilegio PERO NO cambia el `uid`: la key se
           inserta a nombre de `self.env.user` (el usuario actual), no del
           superusuario. Asi el RPC de Aski sigue entrando COMO ese usuario y
           solo ve lo que el ve — nada de escalada de permisos.

        La firma de `_generate` cambio entre series (Odoo 18 agrego
        `expiration_date`), por eso se prueba de forma defensiva."""
        api_keys = self.env["res.users.apikeys"].sudo()
        try:
            # Odoo 18+: (scope, name, expiration_date). False = persistente.
            return api_keys._generate("rpc", name, False)
        except TypeError:
            # Odoo 16/17: (scope, name), sin concepto de expiracion.
            return api_keys._generate("rpc", name)

    def _aski_revoke_previous(self, name):
        """Revoca codigos previos con el mismo nombre del usuario actual para no
        acumular (best-effort)."""
        try:
            keys = self.env["res.users.apikeys"].sudo().search([
                ("user_id", "=", self.env.user.id),
                ("name", "=", name),
            ])
            if keys:
                keys.unlink()
        except Exception:  # noqa: BLE001
            _logger.info("Aski: no se pudieron revocar codigos previos", exc_info=True)

    def _aski_make_qr(self, content):
        """Devuelve un PNG (base64) con el QR, o False si `qrcode` no esta."""
        try:
            import qrcode  # incluido en las dependencias de Odoo (TOTP/2FA)
        except Exception:  # noqa: BLE001
            _logger.info("Aski: libreria 'qrcode' no disponible; se omite el QR")
            return False
        try:
            img = qrcode.make(content)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return base64.b64encode(buf.getvalue())
        except Exception:  # noqa: BLE001
            _logger.warning("Aski: no se pudo generar el QR", exc_info=True)
            return False

    # ------------------------------------------------------------------
    # Cifrado en reposo (mismo patron que jjro_ai_engine: Fernet con secreto
    # en odoo.conf o, si no esta, uno auto-generado en ir.config_parameter).
    # ------------------------------------------------------------------
    @api.model
    def _aski_fernet(self):
        if Fernet is None:
            return None
        secret = config.get("aski_connector_secret")
        if not secret:
            icp = self.env["ir.config_parameter"].sudo()
            secret = icp.get_param("aski_connector.secret")
            if not secret:
                secret = Fernet.generate_key().decode()
                icp.set_param("aski_connector.secret", secret)
        try:
            Fernet(secret.encode())
            key = secret.encode()
        except Exception:
            key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
        return Fernet(key)

    def _aski_encrypt(self, plain):
        if not plain:
            return False
        f = self._aski_fernet()
        if not f:
            return plain  # cryptography no disponible - degrada a texto plano
        return f.encrypt(plain.encode()).decode()

    def _aski_decrypt(self, token):
        if not token:
            return ""
        f = self._aski_fernet()
        if not f:
            return token
        try:
            return f.decrypt(token.encode()).decode()
        except (InvalidToken, Exception):
            return token
