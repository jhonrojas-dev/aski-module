# -*- coding: utf-8 -*-
"""Conexion de esta base Odoo con una cuenta Aski, para el chat embebido.

Un registro por BASE DE DATOS (no por compania: una base multi-compania sigue
siendo una sola instancia hacia afuera, un solo XML-RPC). El token (PAT) se
pega UNA vez desde la web de Aski (app.aski.dev > Settings > Personal access
tokens) y de ahi en adelante el widget de chat habla con el MISMO backend/
motor/wallet que la app Android — esto no es un producto nuevo, es un canal
nuevo para la misma suscripcion.
"""
import functools
import logging

import requests
from psycopg2 import IntegrityError
from markupsafe import Markup

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

from .aski_common import (
    ASKI_API_BASE,
    ASKI_PAT_PREFIX,
    AskiAgentNotInPlanError,
    AskiCreditsError,
    aski_api_base,
    aski_mensaje_red,
    aski_cobrand_html,
    aski_cobrand_html_from_code,
    aski_partner_code,
)

_logger = logging.getLogger(__name__)

# Separador de parrafo dentro de un mensaje al usuario. Aparte para que el
# texto traducible no arrastre escapes.
PARRAFO = "\n\n"


def _sin_nulos(valor):
    """Cambia None por False en toda la respuesta, por hondo que este.

    ⛔ XML-RPC no sabe serializar None: revienta con "cannot marshal None unless
    allow_none is enabled" y el cliente recibe un fallo del servidor en vez de
    los datos. El widget habla por JSON-RPC y ahi no se nota, asi que el defecto
    solo aparece cuando llama otra cosa —un arnes, un script del cliente, otra
    integracion— y justo cuando el backend devuelve un campo vacio, no siempre.
    Odoo usa False, no None, para "sin valor": esto deja la respuesta en esa
    convencion pase lo que pase.
    """
    if valor is None:
        return False
    if isinstance(valor, dict):
        return {k: _sin_nulos(v) for k, v in valor.items()}
    if isinstance(valor, (list, tuple)):
        return [_sin_nulos(v) for v in valor]
    return valor


def _rpc_seguro(metodo):
    """Deja la respuesta de un metodo llamable por RPC libre de None."""
    @functools.wraps(metodo)
    def envoltura(self, *args, **kwargs):
        return _sin_nulos(metodo(self, *args, **kwargs))
    return envoltura

# Estas peticiones ocurren mientras el usuario mira la pantalla y, sobre todo,
# ocupan un worker de Odoo mientras esperan. `/billing/me` se llama en CADA
# apertura del widget: con 30 s, un backend lento dejaba el chat en "Cargando..."
# medio minuto y un worker bloqueado con el. 10 s es de sobra para un GET que
# normalmente tarda decimas, y el saldo cacheado sirve de red si falla.
_TIMEOUT_FAST = 10
# Conectar/registrar la instancia si puede tardar (el backend valida la conexion
# XML-RPC contra este Odoo antes de responder) y ocurre una sola vez.
_TIMEOUT = 30
# Una pregunta normal.
_TIMEOUT_CHAT = 90
# El analisis profundo encadena varias consultas y tarda decenas de segundos,
# pero NO puede pasar de lo que aguanta Odoo: el worker mata la peticion a los
# `limit_time_real` (120 s por defecto en modo multi-worker) y el usuario veria
# un error de gateway sin explicacion, con el turno ya cobrado. Cortando ANTES
# se le puede decir que hacer. Quien tenga el limite de Odoo mas bajo vera el
# corte de Odoo igual: es su configuracion, no algo que el modulo pueda evitar.
_TIMEOUT_AGENT = 110
# El arranque del chat consulta el ERP del cliente cuando la cache esta fria.
# 45 s es lo que espera la app antes de rendirse, y queda holgadamente por debajo
# del `limit_time_real` de Odoo. Con cache caliente responde en milisegundos.
_TIMEOUT_SUGGESTIONS = 45


class AskiAccountLink(models.Model):
    _name = "aski.account.link"
    _description = "Aski account connected to this Odoo (in-Odoo chat)"
    _inherit = ["aski.key.mixin"]

    company_id = fields.Many2one(
        "res.company", string="Company", required=True,
        default=lambda self: self.env.company)

    pat_enc = fields.Char(string="Aski token (encrypted)", copy=False,
                          groups="base.group_system")
    pat = fields.Char(string="Aski personal access token",
                      compute="_compute_pat", inverse="_inverse_pat",
                      groups="base.group_system",
                      help="Generated in the Aski web app, under Settings > "
                           "Personal access tokens. Encrypted at rest here; "
                           "the plaintext is never stored nor logged.")
    connected = fields.Boolean(string="Connected", compute="_compute_connected", store=True)

    email = fields.Char(string="Aski account", readonly=True)
    credential_id = fields.Integer(string="Aski credential id", readonly=True)
    # Como se llama ESTA conexion dentro de la cuenta Aski. Se guarda al
    # registrarla y se refresca al sincronizar, porque es lo que la cabecera del
    # chat necesita para decir a QUE instancia esta preguntando. Una cuenta con
    # tres Odoo veia tres chats identicos y no habia forma de distinguirlos.
    credential_name = fields.Char(string="Connection name", readonly=True)
    wallet_credits = fields.Integer(string="Credits available", readonly=True)
    plan_name = fields.Char(string="Plan", readonly=True)
    last_synced = fields.Datetime(string="Last synced", readonly=True)
    # El plan de esta cuenta incluye el analisis profundo (modo agente). Lo
    # reporta /billing/me; sirve para NO ofrecer dentro de Odoo un interruptor
    # que el backend va a rechazar con un 403. Si el backend no lo reporta
    # (version anterior), queda en False y el chat se comporta como antes.
    agent_enabled = fields.Boolean(string="Deep analysis included", readonly=True)
    # La cuenta la gestiona un SOCIO (reseller): el plan y los pagos los ve con el,
    # no compra directo (el backend ademas rechaza los endpoints de compra para
    # estas cuentas). Por eso se ocultan los enlaces de precios/compra: mostrarlos
    # llevaria al usuario a un muro. Lo reporta /billing/me a nivel usuario.
    partner_managed = fields.Boolean(
        string="Managed by a partner", readonly=True,
        help="This Aski account is managed by a partner: your plan and payments "
             "are handled by them, so the purchase links are hidden.")

    # `partner_managed` solo se sabe con la cuenta YA conectada (lo reporta
    # /billing/me al sincronizar). Antes de eso, la unica señal de que esta
    # instancia pertenece a un cliente de un socio es el codigo que el socio dejo
    # configurado al instalar. Sirve para no enseñarle precios de lista a quien
    # le compra a un socio: ese precio lo pone el socio, no nosotros.
    has_partner_code = fields.Boolean(compute="_compute_has_partner_code")

    # Marca del socio tal como la ve el cliente en la app y la web. Llega en
    # /billing/me junto con partner_managed, asi que no cuesta una peticion
    # aparte: se guarda al sincronizar para poder pintar el mismo lockup
    # "Aski x <socio>" dentro de Odoo.
    partner_name = fields.Char(string="Partner", readonly=True)
    partner_logo_url = fields.Char(readonly=True)
    partner_logo_is_light = fields.Boolean(readonly=True)
    partner_logo_is_tall = fields.Boolean(readonly=True)
    partner_show_cobrand = fields.Boolean(readonly=True, default=True)

    # Markup del lockup. Campo NORMAL, no computado: un Html computado y no
    # almacenado no le llega al cliente web en las series viejas (Odoo 16
    # descarta el campo del formulario entero, verificado en una instancia real),
    # mientras que un valor guardado o por defecto llega siempre. Se refresca al
    # sincronizar, que es cuando pueden cambiar los datos del socio.
    cobrand_html = fields.Html(
        readonly=True, sanitize=False,
        # OJO: aqui va la variante por CODIGO, nunca la que mira la conexion
        # activa. Resolver la conexion CREA el registro global si no existe, y
        # crearlo vuelve a disparar este default -> recursion infinita al
        # instalar en una base limpia (visto en Odoo 17). El lockup de la cuenta
        # conectada no hace falta aqui: lo escribe _sync_wallet.
        default=lambda self: aski_cobrand_html_from_code(self.env),
        help="Co-brand lockup shown to the partner's clients.")

    seats_summary_html = fields.Html(
        string="Team seats", compute="_compute_seats_summary_html",
        sanitize=False, readonly=True,
        help="Seats in use and people from this Odoo waiting for one.")

    def _compute_seats_summary_html(self):
        """Cuantos asientos hay, y QUIEN de este Odoo esta esperando uno.

        ⛔ Se enseña lo que de verdad se sabe: quien PIDIO un asiento desde este
        Odoo, no «quien abrio el chat». Inventar la segunda cifra seria enseñarle
        al administrador una demanda que nadie ha medido.

        Se calcula al abrir el formulario, con timeout corto y sin levantar: si
        el backend no contesta, la ficha de configuracion tiene que seguir
        abriendose — el resto de sus campos no dependen de esto.
        """
        for rec in self:
            rec.seats_summary_html = False
            # ⛔ La conexion que cuenta es la ACTIVA de quien mira, no la del
            # registro global: en modo «por usuario» el registro global no esta
            # conectado —cada quien conecta la suya— y mirando `rec.connected`
            # este bloque no se enseñaba nunca, justo en el modo por defecto.
            enlace = rec._active_link(self.env.user) or rec
            if not enlace.connected or not enlace.pat_enc:
                continue
            try:
                cabeceras = enlace._headers()
                base = aski_api_base(self.env)
                eq = requests.get(base + "/seats", headers=cabeceras,
                                  timeout=_TIMEOUT_FAST).json() or {}
                peticiones = requests.get(base + "/seats/requests", headers=cabeceras,
                                          timeout=_TIMEOUT_FAST).json() or []
            except Exception:  # noqa: BLE001
                rec.seats_summary_html = (
                    "<p class='text-muted'>%s</p>"
                    % _("We could not read your seats right now."))
                continue

            cap = eq.get("capacity") or {}
            if not cap.get("supported"):
                continue

            partes = ["<p><b>%s</b></p>" % (
                _("%s of %s seats in use")
                .replace("%s", str(cap.get("used") or 0), 1)
                .replace("%s", str(cap.get("total") or 0), 1))]

            pendientes = [x for x in peticiones if (x or {}).get("status") == "pending"]
            if pendientes:
                nombres = ", ".join(
                    str(x.get("requester_erp_login") or x.get("email") or "?")
                    for x in pendientes[:3])
                if len(pendientes) > 3:
                    nombres += " " + (_("and %s more")
                                      .replace("%s", str(len(pendientes) - 3)))
                partes.append("<p>%s<br/><span class='text-muted'>%s</span></p>" % (
                    _("%s people from this Odoo are waiting for a seat.")
                    .replace("%s", str(len(pendientes))),
                    nombres))
                # El precio SOLO si lo ponemos nosotros: a un cliente de socio la
                # tarifa se la pone el socio y el backend le rechaza la compra.
                precio = eq.get("next_seat_price_usd")
                if precio:
                    partes.append(
                        "<p class='text-muted'>%s</p>"
                        % (_("Each extra seat costs US$ %s / month.")
                           .replace("%s", "%.2f" % float(precio))))
            else:
                partes.append("<p class='text-muted'>%s</p>"
                              % _("Nobody from this Odoo is waiting for a seat."))
            rec.seats_summary_html = "".join(partes)

    def _compute_has_partner_code(self):
        configured = bool((aski_partner_code(self.env) or "").strip())
        for rec in self:
            rec.has_partner_code = configured

    # Vacio en el registro GLOBAL/compartido (la conexion del admin); en modo
    # "por usuario" cada usuario tiene su PROPIO registro con este campo puesto.
    user_id = fields.Many2one(
        "res.users", string="User", index=True, ondelete="cascade", copy=False,
        help="Empty on the shared connection; set on each person's own "
             "connection when the access mode is 'Per user'.")
    # Solo se lee del registro GLOBAL. Decide COMO autentica el chat embebido.
    access_mode = fields.Selection(
        selection=[
            ("per_user", "Per user - each person connects their own Aski account"),
            ("shared_group", "Shared - the Aski Chat group uses my connection"),
            ("shared_admin", "Private - only administrators use my connection"),
        ],
        string="Chat access mode", default="per_user", required=True,
        help="How the in-Odoo chat authenticates against Aski:\n"
             "- Shared: everyone in the 'Use the Aski chat' group asks through "
             "this one connection - your account, your data, your credits.\n"
             "- Private: only administrators can use this connection.\n"
             "- Per user: each internal user connects their own Aski account, "
             "so Aski only sees what their own Odoo user can see and each one "
             "spends their own credits.")

    @api.depends("pat_enc")
    def _compute_connected(self):
        for r in self:
            r.connected = bool(r.pat_enc)

    @api.depends("pat_enc")
    def _compute_pat(self):
        for r in self:
            r.pat = r._aski_decrypt(r.pat_enc)

    def _inverse_pat(self):
        for r in self:
            r.pat_enc = r._aski_encrypt(r.pat or "")

    # ------------------------------------------------------------------
    # Modo de acceso + resolucion del link activo (compartido vs por-usuario).
    #
    # Registro GLOBAL (user_id = False): guarda `access_mode` y, en los modos
    # compartidos, el PAT/credencial del admin. Un Odoo multi-compania sigue
    # siendo UNA sola instancia hacia afuera (una URL, un xmlrpc) -> el global es
    # unico por BASE, se ignora company_id.
    #
    # Modo `per_user`: cada usuario tiene su PROPIO registro (user_id = usuario)
    # con su PAT + su credencial; el api_key de esa credencial es el suyo, asi
    # que el RPC de Aski entra a Odoo COMO ese usuario -> solo sus permisos, sin
    # escalada.
    # ------------------------------------------------------------------
    _CHAT_GROUP = "aski_connector.group_aski_chat_user"

    def init(self):
        """UN solo registro global por base, garantizado por la base de datos.

        `_get_global()` hacia search+create sin nada que impidiera que dos
        peticiones simultaneas crearan dos. Y lo llaman el systray y el widget
        en CADA carga de pagina, asi que en un Odoo con varios workers la
        primera visita basta para duplicarlo. Visto en vivo: una base con CINCO
        registros globales, cuatro con un modo de acceso distinto al que
        mandaba. Como se usa el de id mas bajo, los sobrantes son invisibles
        hasta que alguien borra el primero — y entonces el modo de acceso de
        toda la base cambia solo, sin que nadie lo decida.

        Los duplicados SIN token se borran (no son nada: un registro vacio). Si
        alguno tiene token es una conexion de verdad y no se toca: se avisa y se
        deja el indice sin crear, porque perder la conexion de alguien para
        cumplir una restriccion seria peor que la restriccion.
        """
        super().init()
        self.env.cr.execute("""
            DELETE FROM aski_account_link a
             WHERE a.user_id IS NULL
               AND coalesce(a.pat_enc, '') = ''
               AND a.id > (SELECT min(b.id) FROM aski_account_link b
                            WHERE b.user_id IS NULL)
        """)
        self.env.cr.execute(
            "SELECT count(*) FROM aski_account_link WHERE user_id IS NULL")
        cuantos = self.env.cr.fetchone()[0]
        if cuantos > 1:
            _logger.warning(
                "Aski: quedan %s conexiones globales con token en esta base. "
                "Revisa cual es la buena: mientras haya mas de una, el modo de "
                "acceso lo decide el id mas bajo.", cuantos)
            return
        # NULL != NULL para un indice unico normal, asi que se indexa una
        # expresion constante sobre las filas globales: eso si deja pasar una
        # sola.
        self.env.cr.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS aski_account_link_global_uniq "
            "ON aski_account_link ((user_id IS NULL)) WHERE user_id IS NULL")

    @api.model
    def _get_global(self):
        rec = self.sudo().search([("user_id", "=", False)], order="id", limit=1)
        if rec:
            return rec
        # El savepoint es lo que hace util al indice: sin el, la carrera que el
        # indice detecta abortaria la transaccion entera y el usuario veria un
        # error del servidor en vez de su chat.
        try:
            with self.env.cr.savepoint():
                return self.sudo().create({})
        except IntegrityError:
            return self.sudo().search([("user_id", "=", False)], order="id", limit=1)

    # Compat: el "singleton" historico ES el registro global (config del admin).
    @api.model
    def _get_or_create(self):
        return self._get_global()

    @api.model
    def _get_user_link(self, user, create=False):
        rec = self.sudo().search([("user_id", "=", user.id)], order="id", limit=1)
        if not rec and create:
            rec = self.sudo().create({"user_id": user.id})
        return rec

    @api.model
    def _current_mode(self):
        return self._get_global().access_mode or "per_user"

    @api.model
    def _active_link(self, user):
        """El link que ESTE usuario usa para chatear, segun el modo. En per_user
        puede ser un recordset vacio (aun no conecto su cuenta)."""
        if self._current_mode() == "per_user":
            return self._get_user_link(user)
        return self._get_global()

    # ------------------------------------------------------------------
    # Cambiar de modo CIERRA todas las conexiones. No es celo: es que cada modo
    # concede un acceso distinto, y una conexion abierta bajo el modo anterior
    # sigue viva despues del cambio.
    #
    # Los tres agujeros que cierra, medidos sobre el codigo anterior:
    #
    #  1. `per_user` -> `shared_admin`. El admin cree que corta a todo el que no
    #     sea administrador. No corta nada: cada persona conserva SU credencial
    #     activa en Aski y sigue consultando este Odoo desde el movil o la web,
    #     porque el modo solo decide como autentica el chat EMBEBIDO.
    #  2. `shared_*` -> `per_user`. Se cambia justo para dejar de consultar con
    #     la llave del admin (que lo ve todo), pero esa credencial global sigue
    #     viva del lado de Aski.
    #  3. `shared_group` -> `per_user` -> `shared_group`. Sin reset, volver al
    #     modo compartido reabre el acceso de TODO el grupo a traves de la llave
    #     del admin sin que nadie lo vuelva a autorizar; y si entretanto entro
    #     gente nueva al grupo, hereda esa visibilidad sin un solo paso de
    #     consentimiento.
    #
    # Se cierra de verdad, no se olvida en local: `_disconnect_link` archiva la
    # credencial del lado de Aski (el corte real) y revoca la API key de Odoo.
    # ------------------------------------------------------------------
    @api.model
    def _conexiones_vivas(self):
        """Los enlaces con token puesto, mirando el campo en Python.

        ⛔ Nada de `search([("pat_enc", "!=", False)])`: en Odoo un `!=` NO trae
        solo lo que difiere, y `pat_enc` ademas esta restringido a
        `base.group_system`, asi que el dominio depende de quien pregunte. Se
        recorre en sudo y se filtra aqui, que es estable.
        """
        return self.sudo().search([]).filtered(lambda r: r.pat_enc)

    @api.model
    def _cerrar_todas_las_conexiones(self):
        """Desconecta TODOS los enlaces: el global y el de cada persona.

        Devuelve cuantos se cerraron. Un enlace que falle no detiene a los demas:
        entre cerrar cuatro de cinco y no cerrar ninguno porque uno dio timeout,
        lo segundo es peor.
        """
        cerrados = 0
        for rec in self._conexiones_vivas():
            try:
                self._disconnect_link(rec)
                cerrados += 1
            except Exception:  # noqa: BLE001
                _logger.warning(
                    "Aski: no se pudo cerrar el enlace %s al cambiar de modo; "
                    "se limpia el token en local igual", rec.id, exc_info=True)
                # Que quede sin token pase lo que pase: un enlace que sobrevive a
                # un cambio de modo es justo el agujero que esto viene a cerrar.
                rec.sudo().write({
                    "pat_enc": False, "credential_id": False, "wallet_credits": 0,
                    "plan_name": False, "email": False, "last_synced": False,
                })
                cerrados += 1
        return cerrados

    @api.onchange("access_mode")
    def _onchange_access_mode_aviso(self):
        """Avisa ANTES de guardar de que el cambio cierra todas las conexiones.

        Va en un `onchange` y no en un dialogo de confirmacion porque salta en
        cuanto se elige el modo nuevo —antes de guardar— y todavia se puede
        volver atras sin consecuencias.
        """
        origen = self._origin
        if not origen or origen.user_id or not origen.access_mode:
            return
        if origen.access_mode == self.access_mode:
            return
        vivas = len(self.env["aski.account.link"]._conexiones_vivas())
        if not vivas:
            return
        return {"warning": {
            "title": _("All Aski connections will be closed"),
            "message": _(
                "Saving this change closes every Aski connection in this "
                "database (%s right now), including yours.\n\n"
                "Each mode grants a different level of access, so a connection "
                "opened under the previous mode cannot stay open: whoever "
                "connected before would keep reaching this Odoo from the Aski "
                "app even after the change.\n\n"
                "Everyone will have to connect again after saving."
            ) % vivas,
        }}

    def write(self, vals):
        """Cambiar `access_mode` en el registro GLOBAL cierra todo.

        ⛔ Se comprueba el valor ANTERIOR: guardar el formulario sin tocar el
        modo manda `access_mode` igualmente en `vals`, y cerrar las conexiones de
        todo el mundo por pulsar Guardar seria peor que el agujero.
        """
        modo = vals.get("access_mode")
        cambia = bool(modo) and any(
            not r.user_id and r.access_mode != modo for r in self.sudo())
        res = super().write(vals)
        if cambia:
            cerrados = self._cerrar_todas_las_conexiones()
            _logger.info("Aski: modo de acceso -> %s; %s conexion(es) cerradas",
                         modo, cerrados)
        return res

    # ------------------------------------------------------------------
    # Quien puede USAR el chat, y quien puede CONECTAR (pegar token) — depende
    # del modo. En modos compartidos el chat lee via la conexion del admin
    # (sudo), asi que solo un grupo/los admin deben poder invocarlo; en per_user
    # cada quien usa SU cuenta con SUS permisos, por eso basta ser interno.
    # ------------------------------------------------------------------
    @api.model
    def _user_can_use_chat(self, user):
        mode = self._current_mode()
        if mode == "shared_admin":
            return user.has_group("base.group_system")
        if mode == "per_user":
            return user.has_group("base.group_user")  # cualquier interno
        return user.has_group(self._CHAT_GROUP)  # shared_group

    @api.model
    def _user_can_connect(self, user):
        """Quien puede pegar/gestionar un token: en modos compartidos solo los
        admins (configuran la conexion global); en per_user cada usuario conecta
        la suya."""
        if self._current_mode() == "per_user":
            return self._user_can_use_chat(user)
        return user.has_group("base.group_system")

    @api.model
    def can_use_chat(self):
        """True si el usuario actual puede usar el chat en el modo vigente. Lo
        consulta el systray para NO mostrar la burbuja a quien no tiene acceso."""
        return self._user_can_use_chat(self.env.user)

    def _ensure_chat_access(self):
        """Barrera REAL: los metodos del chat corren con sudo(), asi que ocultar
        el menu/burbuja no basta — hay que rechazar la llamada RPC directa de
        quien no puede usar el chat en el modo vigente."""
        if not self._user_can_use_chat(self.env.user):
            raise AccessError(_(
                "You don't have access to the Aski chat. Ask an administrator "
                "for access."))

    def _not_connected_error(self):
        """Mensaje de 'aun no conectado', segun el modo."""
        if self._current_mode() == "per_user":
            return _("Connect your own Aski account first: open Aski > Chat and "
                     "click Connect.")
        return _("Aski isn't connected yet. Open Aski > Chat Settings and paste "
                 "your personal access token.")

    @api.model
    def action_open_settings(self):
        """Menu 'Aski > Chat Settings'. Un ir.actions.act_window ESTATICO no
        puede apuntar al singleton (su id no se conoce hasta runtime) — sin
        res_id, Odoo abre un formulario NUEVO y vacio en vez de la conexion
        real ya guardada. Este metodo resuelve el registro real primero."""
        rec = self.sudo()._get_or_create()
        return {
            "type": "ir.actions.act_window",
            "name": _("Aski chat settings"),
            "res_model": "aski.account.link",
            "res_id": rec.id,
            "view_mode": "form",
            "view_id": self.env.ref("aski_connector.view_aski_account_link_form").id,
            "target": "new",
        }

    # ------------------------------------------------------------------
    # Llamadas al backend real de Aski
    # ------------------------------------------------------------------
    def _headers(self):
        self.ensure_one()
        return {"Authorization": "Bearer %s" % self.pat, "Content-Type": "application/json"}

    @staticmethod
    def _error_code(resp):
        """`code` del detail estructurado ({code, message, hint}), o "".

        Es lo que permite reaccionar a un error CONCRETO sin leer su texto: el
        backend responde en un idioma y esta instancia puede estar en otro.
        """
        try:
            detail = (resp.json() or {}).get("detail")
            return (detail or {}).get("code") or "" if isinstance(detail, dict) else ""
        except Exception:  # noqa: BLE001
            return ""

    @staticmethod
    def _error_message(resp):
        """Aski devuelve `detail` como string simple en la mayoria de errores,
        pero algunos guards (ej. limite de conexiones por plan) usan un detail
        ESTRUCTURADO {code, message, hint} para que el cliente movil arme su
        propio CTA. Aqui solo mostramos texto -> extraer siempre el string."""
        try:
            data = resp.json()
            detail = data.get("detail")
            if isinstance(detail, dict):
                return detail.get("message") or resp.text
            if isinstance(detail, list):
                # 422 de validacion: FastAPI manda una LISTA de errores de campo
                # ([{'type': 'string_too_long', 'loc': [...]}, ...]). Devolverla
                # tal cual le pintaba al usuario ese JSON crudo en la burbuja del
                # chat. Se traduce a algo accionable; el detalle va al log, que es
                # donde sirve.
                _logger.info("Aski: respuesta 422 del backend: %s", detail)
                if any((e or {}).get("type") == "string_too_long"
                       for e in detail if isinstance(e, dict)):
                    return _("That question is too long. Make it shorter and "
                             "ask again.")
                return _("Aski couldn't process that request. Check what you "
                         "typed and try again.")
            return detail or resp.text
        except Exception:
            return resp.text or ("HTTP %s" % resp.status_code)

    # ------------------------------------------------------------------
    # Un 401 no siempre es culpa del token
    # ------------------------------------------------------------------
    def _mensaje_401(self, resp=None):
        """(mensaje, olvidar_token) mirando el CONTEXTO antes de acusar al token.

        Cualquier 401 se leia como "tu token esta revocado", y de las tres cosas
        que lo provocan solo una lo es:

          1. Este Odoo esta preguntando a OTRO backend (uno de staging, uno
             local, o una base restaurada que se trajo el parametro del entorno
             anterior). El token es perfecto: simplemente no vive en esa base.
          2. El token guardado no se pudo descifrar y se mando el cifrado tal
             cual — pasa cuando cambia la clave del modulo, tipico al restaurar
             o duplicar una base. Tampoco es culpa del token.
          3. El token si esta muerto: revocado, de otra cuenta, o su dueño
             desactivado.

        Solo en el caso 3 se borra. En los otros dos, borrarlo destruye una
        conexion sana y encima esconde la causa, que es justo lo unico que
        habia que contar. Caso fundacional: una instancia apuntando a un backend
        local mandaba a generar tokens nuevos que fallaban igual, uno tras otro.
        """
        self.ensure_one()
        base = aski_api_base(self.env)
        if base != ASKI_API_BASE:
            return _(
                "This Odoo asks %(base)s, which is not the Aski service "
                "(%(oficial)s), and that server rejected the token. If you "
                "generated the token in the Aski web app, the token is fine — "
                "it's this Odoo that is pointing somewhere else. Whoever "
                "administers this server can change it in the system parameter "
                "aski_connector.api_base."
            ) % {"base": base, "oficial": ASKI_API_BASE}, False
        if self.pat and not self.pat.startswith(ASKI_PAT_PREFIX):
            return _(
                "The saved token could not be read, so it went out unusable. "
                "That happens when the database is restored or duplicated, or "
                "when what got saved was not a whole token. Paste your Aski "
                "access token again."
            ), False
        codigo = self._error_code(resp) if resp is not None else ""
        if codigo == "token_revoked":
            return _("That token was revoked. Generate a new one in Aski."), True
        if codigo == "token_unknown":
            return _("Aski doesn't know that token: it belongs to another account "
                     "or to another environment. Generate one in the Aski account "
                     "you want to use here."), True
        if codigo == "user_inactive":
            return _("The Aski account that owns that token is deactivated."), True
        # Backend anterior al detail estructurado: el mensaje de siempre.
        return _("That token is invalid or was revoked. Generate a new one in "
                 "Aski."), True

    def _sync_wallet(self):
        """Verifica el token contra /billing/me y refresca el saldo/plan en cache.
        Devuelve (ok, message) — sin lanzar, para que tanto el boton interactivo
        como el wizard de conexion puedan decidir que hacer con el resultado."""
        self.ensure_one()
        rec = self.sudo()
        if not rec.pat:
            return False, _("Paste your Aski personal access token first.")
        try:
            resp = requests.get(aski_api_base(self.env) + "/billing/me",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            return False, aski_mensaje_red(self.env, e)
        if resp.status_code == 401:
            mensaje, olvidar = rec._mensaje_401(resp)
            if olvidar:
                rec._olvidar_token()
            return False, mensaje
        if resp.status_code != 200:
            return False, rec._error_message(resp)
        data = resp.json()
        wallet = data.get("wallet") or {}
        sub = data.get("subscription") or {}
        vals = {
            "wallet_credits": wallet.get("balance", 0),
            # ⛔ `plan_name`, NO `plan_id`: el backend ya manda el nombre
            # legible ("Enterprise Plus") y aqui se estaba leyendo el
            # identificador, asi que la cabecera mostraba "enterprise_plus".
            # Se cae a plan_id solo si el backend no lo trajera.
            "plan_name": ((sub or {}).get("plan_name")
                          or (sub or {}).get("plan_id") or ""),
            "agent_enabled": bool(data.get("agent_enabled")),
            "partner_managed": bool(data.get("partner_managed")),
            "partner_name": (sub or {}).get("partner_name") or "",
            "partner_logo_url": (sub or {}).get("partner_logo_url") or "",
            "partner_logo_is_light": bool((sub or {}).get("partner_logo_is_light")),
            "partner_logo_is_tall": bool((sub or {}).get("partner_logo_is_tall")),
            "partner_show_cobrand": bool((sub or {}).get("partner_show_cobrand", True)),
            "cobrand_html": aski_cobrand_html(
                self.env,
                name=(sub or {}).get("partner_name") or "",
                logo_url=(sub or {}).get("partner_logo_url") or "",
                is_light=bool((sub or {}).get("partner_logo_is_light")),
                is_tall=bool((sub or {}).get("partner_logo_is_tall")),
            ) if (data.get("partner_managed")
                  and (sub or {}).get("partner_show_cobrand", True)) else "",
            "last_synced": fields.Datetime.now(),
        }
        # Solo se pisa el correo si el backend lo reporta: por la via de pegar un
        # token suelto es la UNICA forma de saberlo, pero un backend que todavia
        # no lo manda no debe borrar el que guardo el asistente de conexion.
        correo = (data.get("email") or "").strip()
        if correo:
            vals["email"] = correo
        rec.write(vals)
        return True, _("Connected. %s credits available.") % rec.wallet_credits

    def action_test_connection(self):
        """Boton interactivo: espejo de _sync_wallet() pero con notificacion UI."""
        ok, message = self.sudo()._sync_wallet()
        return {"type": "ir.actions.client", "tag": "display_notification", "params": {
            "title": _("Aski connection") if ok else _("Aski connection issue"),
            "message": message, "type": "success" if ok else "danger", "sticky": not ok}}

    def action_save_settings(self):
        """Guarda la configuracion del chat (sobre todo el modo de acceso) y
        recarga. El boton del pie es type=object, asi que el framework PERSISTE
        el registro antes de entrar aqui — imprescindible en modo 'per_user',
        donde el resto de botones se ocultan y sin este 'Save' solo quedaba
        'Close' (special=cancel), que descartaba el cambio: el modo nunca se
        aplicaba. Se recarga porque cambiar el modo altera QUIEN ve la burbuja
        del chat y por QUE conexion lee, y el systray ya montado debe
        reevaluarlo (mismo motivo que action_disconnect)."""
        self.ensure_one()
        return {"type": "ir.actions.client", "tag": "reload"}

    # ------------------------------------------------------------------
    # Desconectar (cerrar sesion de la cuenta Aski)
    # ------------------------------------------------------------------
    def _disconnect_link(self, rec):
        """Desvincula una conexion: archiva la credencial del lado de Aski,
        revoca la API key de Odoo y limpia el registro local.

        El corte REAL es archivar la credencial en Aski: aunque la revocacion
        local falle (o la key sea de OTRO admin, que fue quien conecto en modo
        compartido), Aski ya no puede entrar a este Odoo. Por eso el archivado va
        primero y la limpieza local ocurre IGUAL si la red falla — si no, el
        usuario quedaria atrapado con una conexion que no puede quitar.
        """
        rec = rec.sudo()
        if rec.credential_id:
            try:
                requests.delete(
                    aski_api_base(self.env) + "/users/odoo/%s" % rec.credential_id,
                    headers=rec._headers(), timeout=_TIMEOUT)
            except Exception:  # noqa: BLE001
                _logger.info("Aski: no se pudo archivar la credencial remota al "
                             "desconectar; se limpia igual en local", exc_info=True)
        rec._aski_revoke_previous("Aski Chat")
        rec.write({
            "pat_enc": False, "credential_id": False, "credential_name": False,
            "wallet_credits": 0,
            "plan_name": False, "email": False, "last_synced": False,
        })

    @api.model
    def disconnect_account(self):
        """Desde el widget (orm.call). Desconecta la conexion que le corresponde
        a ESTE usuario segun el modo: la suya propia en `per_user`, la global en
        los modos compartidos (donde solo un admin puede)."""
        user = self.env.user
        if not self._user_can_connect(user):
            raise AccessError(_(
                "You can't disconnect this Aski connection. Ask an administrator."))
        rec = self._active_link(user)
        if not rec or not rec.connected:
            return {"ok": True, "message": _("Aski was already disconnected.")}
        self._disconnect_link(rec)
        return {"ok": True, "message": _("Aski account disconnected.")}

    def action_disconnect(self):
        """Boton 'Disconnect' del formulario de Chat Settings (admin)."""
        self.ensure_one()
        if not self._user_can_connect(self.env.user):
            raise AccessError(_(
                "You can't disconnect this Aski connection. Ask an administrator."))
        if self.sudo().connected:
            self._disconnect_link(self)
        # Recarga COMPLETA: al cerrar el dialogo, la burbuja del systray sigue
        # montada con su estado "conectado" y su composer usable. Mismo motivo
        # que en el widget (y que en action_connect al conectar).
        return {"type": "ir.actions.client", "tag": "display_notification", "params": {
            "title": _("Aski connection"),
            "message": _("Aski account disconnected."),
            "type": "success",
            "next": {"type": "ir.actions.client", "tag": "reload"}}}

    # -----------------------------------------------------------------
    #  Las conexiones de la CUENTA (no solo la de este Odoo)
    # -----------------------------------------------------------------
    # Una cuenta Aski puede tener varias instancias colgando: este Odoo, el de
    # pruebas, el SAP de la matriz. Dentro de Odoo solo se CHATEA con la de aqui,
    # pero hay dos cosas que necesitan verlas todas: no dejar que nazcan dos con
    # el mismo nombre, y decir a cuales cubre el resumen diario.

    @api.model
    def _conexiones_cuenta(self, rec=None):
        """Las conexiones de la cuenta Aski conectada. Nunca lanza.

        -> {"ok", "connections": [{"id", "name", "current", "erp_type"}]}

        `current` marca la de ESTE Odoo, que es la unica que el usuario reconoce
        sin pensar: un selector de tres nombres parecidos sin decir cual es el
        suyo obliga a adivinar.
        """
        rec = rec or self._active_link(self.env.user)
        vacio = {"ok": False, "connections": []}
        if not rec or not rec.connected:
            return vacio
        try:
            resp = requests.get(aski_api_base(self.env) + "/users/odoo",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return vacio
        if resp.status_code != 200:
            # Un backend anterior al que admite el token personal aqui responde
            # 401. No es un fallo del usuario y no se cuenta como tal: quien
            # llama se queda con la unica conexion que si conoce, la de aqui.
            return vacio
        try:
            filas = resp.json() or []
        except Exception:  # noqa: BLE001
            return vacio
        salida = []
        for c in filas:
            if not isinstance(c, dict) or not c.get("id"):
                continue
            salida.append({
                "id": int(c["id"]),
                "name": c.get("nickname") or "",
                "erp_type": c.get("erp_type") or "odoo",
                "current": int(c["id"]) == (rec.credential_id or 0),
            })
        # De paso se refresca el nombre de la conexion de aqui: si alguien la
        # renombro desde la app o la web, la cabecera del chat lo dice sin que
        # haga falta reconectar. Y es lo que rellena el campo en las
        # instalaciones que conectaron antes de que este campo existiera.
        actual = next((c for c in salida if c["current"]), None)
        if actual and (rec.credential_name or "") != actual["name"]:
            rec.sudo().write({"credential_name": actual["name"]})
        return {"ok": True, "connections": salida}

    def _nombre_conexion_libre(self, nombre, rec=None):
        """(ok, mensaje): si ese nombre ya lo lleva OTRA conexion de la cuenta.

        ⛔ Se comprueba aqui y no en el backend a proposito: el nombre lo elige
        quien conecta, y el sitio donde se puede DECIR algo util —«ese ya lo usa
        otra instancia, ponle otro»— es el formulario donde acaba de escribirlo.

        Se compara sin distinguir mayusculas y sin espacios de sobra, que es como
        lo lee una persona: "Odoo Produccion" y "odoo produccion " son el mismo
        nombre para cualquiera que mire la lista desde el celular.

        Si no se pueden leer las conexiones (backend viejo, red caida) NO se
        bloquea: un nombre repetido molesta, pero no dejar conectar por no poder
        comprobarlo es peor.
        """
        limpio = (nombre or "").strip()
        if not limpio:
            return True, ""
        rec = rec or self
        datos = self._conexiones_cuenta(rec)
        if not datos.get("ok"):
            return True, ""
        mio = rec.credential_id or 0
        for c in datos["connections"]:
            if c["id"] == mio:
                continue
            if (c["name"] or "").strip().lower() == limpio.lower():
                return False, _(
                    "Your Aski account already has a connection called \"%s\". "
                    "Give this one a different name so you can tell them apart "
                    "in the app, on the web and in your scheduled alerts."
                ) % limpio
        return True, ""

    # Errores del backend que significan "esa DIRECCION no sirve, prueba otra".
    # No son fallos del token ni de la clave: reintentar con la siguiente
    # candidata es exactamente lo correcto.
    _URL_ERROR_CODES = ("erp_url_not_public", "erp_unreachable")

    def _register_credential_any(self, nickname, urls, db, login, api_key):
        """Registra esta base probando las direcciones en orden hasta que una
        funcione. Devuelve (ok, message, url_usada).

        Existe porque la direccion NO la teclea el cliente: la deduce el modulo
        (ver `aski_url_candidates`). Si la primera no es alcanzable desde Aski hay
        que probar la siguiente en vez de dejar la conexion rota, que es lo que
        pasaba cuando `web.base.url` conservaba el default de Odoo.
        """
        self.ensure_one()
        ultimo = ""
        for url in (urls or []):
            ok, message, code = self._register_credential(
                nickname, url, db, login, api_key)
            if ok:
                return True, "", url
            ultimo = message
            if code not in self._URL_ERROR_CODES:
                # Token invalido, limite de plan, credenciales rechazadas: cambiar
                # de direccion no lo arregla y reintentar solo confunde el mensaje.
                return False, message, url
        return False, ultimo, (urls or [""])[-1]

    def _register_credential(self, nickname, url, db, login, api_key):
        """Registra esta base Odoo como credential de la cuenta Aski conectada.
        Si YA habia un credential_id de una conexion anterior, actualiza ESE
        registro (PUT) en vez de crear uno nuevo (POST) — antes cada
        Reconectar creaba una credential "Odoo (in-app chat)" duplicada.

        Devuelve (ok, message, code); `code` es el del detail estructurado y lo
        usa `_register_credential_any` para saber si vale la pena probar otra
        direccion."""
        self.ensure_one()
        rec = self.sudo()
        body = {"nickname": nickname, "url": url, "db": db, "login": login,
                "api_key": api_key, "erp_type": "odoo"}
        if rec.credential_id:
            try:
                resp = requests.put(aski_api_base(self.env) + "/users/odoo/%s" % rec.credential_id,
                                    json=body, headers=rec._headers(), timeout=_TIMEOUT)
            except Exception as e:  # noqa: BLE001
                return False, aski_mensaje_red(self.env, e), ""
            if resp.status_code == 200:
                rec.write({"credential_name": nickname})
                return True, "", ""
            if resp.status_code in (403, 404):
                # 404 = esa credential ya no existe (el user la borro desde la
                # app). 403 = existe pero NO es de la cuenta del token que se
                # acaba de pegar -> el usuario esta conectando OTRA cuenta Aski,
                # y el credential_id que teniamos guardado es de la cuenta vieja
                # (sin esto, conectar una cuenta distinta fallaba con un error
                # de permisos incomprensible). En ambos casos: olvidar el id
                # viejo y crear una conexion nueva en la cuenta actual.
                rec.write({"credential_id": False})
            else:
                return False, rec._error_message(resp), rec._error_code(resp)
        try:
            resp = requests.post(aski_api_base(self.env) + "/users/odoo", json=body,
                                 headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            return False, aski_mensaje_red(self.env, e), ""
        if resp.status_code not in (200, 201):
            return False, rec._error_message(resp), rec._error_code(resp)
        data = resp.json()
        rec.write({"credential_id": data.get("id"),
                   "credential_name": data.get("nickname") or nickname})
        return True, "", ""

    def _olvidar_token(self):
        """El token ya no vale (revocado desde la cuenta, o caducado).

        Ademas de borrarlo hay que tirar el saldo y el plan que quedaron
        cacheados: son de una conexion que ya no existe. Sin esto, `Chat
        Settings` seguia enseñando "enterprise" y miles de creditos junto a un
        "Conectado: no", que es una cifra que ya no significa nada (visto en el
        demo tras revocar un token de verdad).

        El correo y el id de credencial SI se conservan: no han dejado de ser
        ciertos y dicen QUE cuenta hay que volver a conectar. Al desconectar a
        mano se limpian tambien, porque ahi la intencion es soltar la conexion
        entera.
        """
        self.ensure_one()
        self.sudo().write({
            "pat_enc": False,
            "wallet_credits": 0,
            "plan_name": False,
            "agent_enabled": False,
        })

    def _raise_for_chat_error(self, resp):
        """Traduce la respuesta del backend a la excepcion que toca.

        Compartido por el modo normal y el profundo: son el MISMO motor y el
        MISMO monedero, asi que un fallo debe contarse igual en los dos. Cuando
        estaba escrito dos veces, cualquier arreglo se quedaba en uno solo.
        """
        self.ensure_one()
        rec = self.sudo()
        if resp.status_code == 200:
            return
        if resp.status_code == 401:
            mensaje, olvidar = rec._mensaje_401(resp)
            if olvidar:
                rec._olvidar_token()
                raise UserError("%s%s%s" % (
                    mensaje, PARRAFO,
                    _("Reconnect in Aski > Chat Settings.")))
            raise UserError(mensaje)
        if resp.status_code == 402:
            # Cuenta gestionada por un socio: NO ofrecer la compra directa (el
            # backend la rechaza igual) — el saldo lo repone su socio.
            if rec.partner_managed:
                raise AskiCreditsError(_(
                    "You're out of Aski credits. Contact your Aski partner to top up."))
            raise AskiCreditsError(_("You're out of Aski credits. Top up at %s/billing to keep chatting.")
                            % "https://app.aski.dev")
        if resp.status_code == 403 and rec._error_code(resp) == "feature_not_in_plan":
            # El plan no incluye el analisis profundo. Se distingue con clase
            # propia para que el chat apague el interruptor en vez de dejar al
            # usuario reintentando algo que nunca va a funcionar.
            raise AskiAgentNotInPlanError(rec._error_message(resp))
        raise UserError(_("Aski error: %s") % rec._error_message(resp))

    @api.model
    def _record_body(self, record_model, record_id):
        """El REGISTRO ABIERTO para el cuerpo de la peticion, o `{}` si no hay.

        Lo comparten los dos modos (normal y profundo) para que el contrato salga
        identico desde los dos: si cada uno armara el suyo, bastaria un despiste
        para que el modo profundo mandara `id` donde el normal manda `res_id` y la
        ficha se perdiera solo en uno.

        Valida aqui ademas de en el backend porque el par llega del navegador: un
        modelo con formato raro debe morir antes de gastar una peticion HTTP. El
        backend vuelve a validarlo — es su frontera, no puede fiarse de esta.
        """
        if not record_model or not record_id:
            return {}
        try:
            res_id = int(record_id)
        except (TypeError, ValueError):
            return {}
        if res_id <= 0 or not isinstance(record_model, str):
            return {}
        # Mismo formato que exige el backend (`^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*$`).
        # ⛔ El punto NO es obligatorio: los modelos que crea Studio se llaman
        # `x_pedido`, `x_contrato`… sin punto, y exigirlo los descartaba aqui
        # mismo — la ficha no salia justo en los modelos propios del cliente.
        limpio = record_model.replace(".", "").replace("_", "")
        if not limpio.isalnum() or not record_model[:1].islower():
            return {}
        return {"record": {"model": record_model, "res_id": res_id}}

    @api.model
    def send_message_agent(self, text, conversation_id=None, confirm_heavy=False,
                           record_model=None, record_id=None):
        """Analisis profundo: MISMO motor que el interruptor de la app y la web.

        Existe porque el cliente con plan Pro/Enterprise ya paga el modo profundo
        y, hasta ahora, dentro de Odoo no podia usarlo: el chat embebido solo
        hablaba con /chat. Misma cuenta, mismo monedero, mismo agente.

        `confirm_heavy` lo manda el chat cuando el usuario acepta seguir con una
        consulta que el backend marco como pesada.
        """
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            raise UserError(self._not_connected_error())
        body = {"credential_id": rec.credential_id, "prompt": text}
        if conversation_id:
            body["conversation_id"] = conversation_id
        if confirm_heavy:
            body["confirm_heavy"] = True
        body.update(self._record_body(record_model, record_id))
        try:
            resp = requests.post(aski_api_base(self.env) + "/chat/agent", json=body,
                                 headers=rec._headers(), timeout=_TIMEOUT_AGENT)
        except requests.exceptions.Timeout:
            raise UserError(_(
                "The deep analysis took longer than this Odoo allows. Try a more "
                "specific question, or ask it in normal mode."))
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        rec._raise_for_chat_error(resp)
        data = resp.json()
        return {
            "answer": data.get("answer", ""),
            "conversation_id": data.get("conversation_id"),
            "credits": data.get("credits"),
            # Para que el grafico salga YA en el turno que se acaba de mandar y
            # no solo tras la recarga del hilo (que puede fallar sin red).
            "chart": (data.get("query") or {}).get("chart"),
            # El agente puede pedir confirmacion antes de una consulta pesada, o
            # declinar. El chat lo refleja en vez de tragarselo.
            "confirmation_required": bool(data.get("confirmation_required")),
            "refused": bool(data.get("refused")),
        }

    @api.model
    def send_message(self, text, conversation_id=None,
                     record_model=None, record_id=None):
        """Envia una pregunta al motor real de Aski (mismo determinista +
        narrador + wallet que la app Android) y devuelve la respuesta.
        Llamado desde el widget OWL via orm.call — corre con sudo() para usar la
        conexion configurada por el admin sin necesitar acceso de lectura al
        token en si, PERO solo tras verificar que el usuario esta en el grupo del
        chat (si no, veria datos de toda la empresa saltandose sus reglas)."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            raise UserError(self._not_connected_error())
        body = {"credential_id": rec.credential_id, "prompt": text}
        if conversation_id:
            body["conversation_id"] = conversation_id
        body.update(self._record_body(record_model, record_id))
        try:
            resp = requests.post(aski_api_base(self.env) + "/chat", json=body,
                                 headers=rec._headers(), timeout=_TIMEOUT_CHAT)
        except requests.exceptions.Timeout:
            raise UserError(_("Aski is taking too long to answer. Try again in a moment."))
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        rec._raise_for_chat_error(resp)
        data = resp.json()
        return {
            "answer": data.get("answer", ""),
            "conversation_id": data.get("conversation_id"),
            "credits": data.get("credits"),
            "chart": (data.get("query") or {}).get("chart"),
        }

    @api.model
    def get_status(self):
        """Estado para bootstrap del widget: conectado, saldo, plan.
        Refresca el saldo en vivo contra /billing/me en cada apertura del
        widget — antes se mostraba el ultimo valor cacheado en
        wallet_credits, que solo se actualizaba con el boton "Test
        connection" de Configuracion; un usuario con creditos reales (p.ej.
        tras una recarga) seguia viendo "Sin creditos" hasta tocar ese boton
        a mano. Si la sincronizacion falla (sin red, token invalido) se
        ignora el error y se muestra el ultimo valor cacheado, sin romper
        la carga del widget."""
        # Suave (no lanza): el widget muestra el estado correcto (sin acceso /
        # conectar tu cuenta / pide al admin). La barrera dura vive en los
        # metodos que traen datos.
        user = self.env.user
        mode = self._current_mode()
        if not self._user_can_use_chat(user):
            return {"allowed": False, "mode": mode, "can_connect": False,
                    "connected": False, "email": "", "connection_name": "",
                    "wallet_credits": 0,
                    "plan_name": "", "partner_managed": False,
                    "agent_enabled": False}
        rec = self._active_link(user)
        if rec and rec.connected and rec.pat:
            rec._sync_wallet()
            # Una sola vez, y solo mientras falte: las conexiones que se
            # registraron antes de guardar el nombre no tienen como saberlo, y
            # sin el la cabecera se queda muda. En cuanto se rellena, esta
            # peticion deja de hacerse.
            if not rec.credential_name and rec.credential_id:
                self._conexiones_cuenta(rec)
        return {
            "allowed": True,
            "mode": mode,
            "can_connect": self._user_can_connect(user),
            "connected": bool(rec) and rec.connected,
            "email": (rec.email or "") if rec else "",
            # A QUE instancia se le esta preguntando. Sin esto, alguien con el
            # Odoo de produccion y el de pruebas abiertos en dos pestañas veia
            # dos chats identicos y no tenia como saber cual era cual.
            "connection_name": (rec.credential_name or "") if rec else "",
            "wallet_credits": rec.wallet_credits if rec else 0,
            "plan_name": (rec.plan_name or "") if rec else "",
            # El interruptor de analisis profundo solo se ofrece si el plan lo
            # incluye: mostrarlo siempre seria prometer algo que el backend
            # rechaza con un 403 en cuanto lo pulsan.
            "agent_enabled": bool(rec.agent_enabled) if rec else False,
            # Para que el chat NO le ofrezca recargar a un cliente de socio: esa
            # compra la rechaza el backend y lo dejaria contra un muro. Su saldo
            # se lo repone su socio. Si aun no hay conexion, vale el codigo que
            # el socio dejo configurado en la instancia.
            "partner_managed": bool(
                (rec.partner_managed if rec else False)
                or (aski_partner_code(self.env) or "").strip()
            ),
        }

    @api.model
    def list_conversations(self):
        """Historial de conversaciones de ESTA conexion (drawer del widget,
        igual que Android/web) — mas reciente primero."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            return []
        try:
            resp = requests.get(aski_api_base(self.env) + "/chat/conversations",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return []
        if resp.status_code != 200:
            return []
        return [c for c in resp.json() if c.get("odoo_credential_id") == rec.credential_id]

    @api.model
    def search_history(self, q, limit=30):
        """Busca texto DENTRO de los mensajes del historial (cajon del chat).

        Devuelve un DICT y no una lista a proposito: una lista vacia cuenta igual
        "no hay resultados" que "no se pudo buscar", y para quien esta tecleando
        son dos cosas muy distintas. -> {"ok", "code", "results"}

        No lanza NUNCA: esto corre a cada pausa del teclado y un UserError abriria
        un dialogo encima del cajon.
        """
        self._ensure_chat_access()
        vacio = {"ok": True, "code": "", "results": []}
        texto = (q or "").strip()
        # Mismo minimo que el backend (app/chat/search.py::MIN_QUERY_LEN): con un
        # solo caracter casi todo coincide. Se corta aqui para no gastar una
        # peticion en algo que ya se sabe que no ayuda a nadie.
        if len(texto) < 2:
            return vacio
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            return vacio
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/chat/search",
                params={
                    # 200 es el tope duro del backend: pasarse devuelve un 422 que
                    # aqui no aporta nada, asi que se recorta antes de salir.
                    "q": texto[:200],
                    # Acotado a ESTA conexion, coherente con el cajon, que ya
                    # ensena solo los hilos de la credencial activa.
                    "credential_id": rec.credential_id,
                    "limit": max(1, min(int(limit or 30), 100)),
                },
                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return {"ok": False, "code": "error", "results": []}
        # El limitador del backend va por IP y en un Odoo TODOS los usuarios salen
        # por la misma: en una instancia con gente buscando a la vez esto se ve de
        # verdad. Se distingue del fallo generico para poder decir "espera un
        # momento" en vez de "algo se rompio".
        if resp.status_code == 429:
            return {"ok": False, "code": "rate_limited", "results": []}
        if resp.status_code != 200:
            return {"ok": False, "code": "error", "results": []}
        try:
            filas = resp.json() or []
        except Exception:  # noqa: BLE001
            return {"ok": False, "code": "error", "results": []}
        salida = []
        for m in filas:
            if not isinstance(m, dict):
                continue
            salida.append({
                "conversationId": m.get("conversation_id"),
                "conversationTitle": m.get("conversation_title") or "",
                "messageId": m.get("message_id"),
                # Mismo id que arma load_conversation ("h<id>"): asi el widget
                # localiza la burbuja en el DOM sin inventarse el formato.
                "domId": "h%s" % m.get("message_id"),
                "role": m.get("role") or "",
                "snippet": m.get("snippet") or "",
                # Offsets del resaltado, ya calculados por el backend: buscando
                # "credito" el cliente no encontraria nada en un texto que dice
                # "credito" con tilde, y habria que duplicar la tabla de acentos
                # en JavaScript. Ver app/chat/search.py.
                "matchStart": m.get("match_start") or 0,
                "matchLen": m.get("match_len") or 0,
                "createdAt": m.get("created_at"),
            })
        return {"ok": True, "code": "", "results": salida}

    def _aski_suggestions_lang(self):
        """`es` o `en` para el catalogo de preguntas del backend.

        El catalogo del backend vive en esos dos idiomas; el conector se traduce a
        seis. Un usuario en aleman vera el marco del chat en aleman y las
        preguntas en ingles: es una limitacion DECLARADA del catalogo, no un
        olvido de aqui.
        """
        return "es" if (self.env.user.lang or "").lower().startswith("es") else "en"

    @api.model
    def get_suggestions(self, refresh=False):
        """Con que abre el chat esta conexion: sus cifras y que preguntarle.

        El mismo arranque que la app y la web. No lanza NUNCA: es una carga de
        pantalla, y si el ERP no responde el chat tiene que seguir usandose.
        -> {"ok", "code", "metrics", "questions", "sections", "asOf", "stale", "empty"}
        """
        self._ensure_chat_access()
        vacio = {"ok": False, "code": "", "metrics": [], "questions": [],
                 "sections": [], "asOf": "", "stale": False, "empty": False}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            # Sin conexion no hay nada que pedir, y no es un error: el chat ya
            # ensena su propia pantalla de "conecta tu cuenta".
            return dict(vacio, ok=True)
        params = {
            "credential_id": rec.credential_id,
            "lang": self._aski_suggestions_lang(),
            # El huso del USUARIO de Odoo, no el del servidor: decide que dia es
            # HOY para las cifras de calendario ("facturado este mes"). Con UTC,
            # alguien en Lima veria el dia equivocado cinco horas de cada dia.
            "tz": (self.env.user.tz or "UTC"),
        }
        if refresh:
            params["refresh"] = "true"
        # La empresa SOLO si el usuario tiene una sola activa. Con varias, en Odoo
        # ve la suma de todas: acotar a la actual daria una cifra correcta que no
        # cuadra con su pantalla. Omitiendola, cada metrica declara de cuantas
        # empresas sale y la tarjeta lo dice en pequeno.
        try:
            companias = self.env.companies
        except Exception:  # noqa: BLE001
            companias = self.env.company
        if companias and len(companias) == 1:
            params["company_id"] = companias.id
        try:
            resp = requests.get(aski_api_base(self.env) + "/suggestions",
                                params=params, headers=rec._headers(),
                                timeout=_TIMEOUT_SUGGESTIONS)
        except Exception:  # noqa: BLE001
            return dict(vacio, code="erp_down")
        if resp.status_code == 429:
            return dict(vacio, code="rate_limited")
        if resp.status_code != 200:
            return dict(vacio, code="erp_down")
        try:
            data = resp.json() or {}
        except Exception:  # noqa: BLE001
            return dict(vacio, code="erp_down")

        def _pregunta(p):
            return {"key": p.get("key") or "", "text": p.get("text") or "",
                    "section": p.get("section") or ""}

        metricas = []
        for m in (data.get("metrics") or []):
            if not isinstance(m, dict):
                continue
            metricas.append({
                "id": m.get("id") or "",
                # Ya traducida por el backend, como las preguntas: el cliente no
                # traduce contenido, solo su propio marco.
                "label": m.get("label") or "",
                # Ya formateada, y con cada moneda separada por el punto medio
                # que pone el motor, que es quien decidio NO sumarlas: aqui no
                # se reformatea jamas.
                "value": m.get("value") or "",
                "companies": m.get("companies") or 0,
            })
        preguntas = [_pregunta(p) for p in (data.get("questions") or [])
                     if isinstance(p, dict)]
        secciones = []
        for s in (data.get("sections") or []):
            if not isinstance(s, dict):
                continue
            secciones.append({
                "key": s.get("key") or "",
                "label": s.get("label") or "",
                "questions": [_pregunta(p) for p in (s.get("questions") or [])
                              if isinstance(p, dict)],
            })
        return {
            "ok": True, "code": "",
            "metrics": metricas, "questions": preguntas, "sections": secciones,
            # Instante del CALCULO, no del envio: es lo que permite decir "hace 12
            # min". Una cifra vieja presentada como actual es peor que ninguna.
            "asOf": data.get("as_of") or "",
            "stale": bool(data.get("stale")),
            "empty": bool(data.get("empty")),
        }

    @api.model
    def delete_conversation(self, conversation_id):
        """Archiva un hilo, igual que el gesto de borrar de la app.

        Del lado de Aski es un archivado, no un borrado fisico: desaparece de los
        listados y se resetea el contexto del modelo. Se dice asi en la UI para
        no prometer una eliminacion que no ocurre.
        """
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.delete(
                aski_api_base(self.env) + "/chat/conversations/%s" % conversation_id,
                headers=rec.sudo()._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        # 404 = ya no existe (borrada desde la app): para el usuario el resultado
        # es el mismo, no tiene sentido darle un error.
        if resp.status_code not in (200, 204, 404):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return True

    @api.model
    def rename_conversation(self, conversation_id, title):
        """Renombra un hilo desde el cajon del historial (como en la app)."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        nombre = (title or "").strip()
        if not nombre:
            raise UserError(_("Type a name for the conversation."))
        try:
            resp = requests.patch(
                aski_api_base(self.env) + "/chat/conversations/%s" % conversation_id,
                json={"title": nombre[:200]},
                headers=rec.sudo()._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return True

    @api.model
    def load_conversation(self, conversation_id):
        """Mensajes de una conversacion (al abrirla desde el drawer, o al
        restaurar la mas reciente cuando se recarga la pantalla)."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            return []
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/chat/conversations/%s/messages" % conversation_id,
                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return []
        if resp.status_code != 200:
            return []
        out = []
        for m in resp.json():
            role = m.get("role")
            if role not in ("user", "assistant"):
                continue
            out.append({
                "id": "h%s" % m["id"], "backendId": m["id"], "role": role,
                "text": m.get("content", ""),
                # `is_agent` viaja en la PREGUNTA (asi lo guarda el backend, y
                # asi lo leen la app y la web). Sin mapearlo aqui, el distintivo
                # de "analisis profundo" desaparecia en cuanto se recargaba el
                # hilo — que ocurre justo despues de cada respuesta.
                "deep": bool(m.get("is_agent")) if role == "user" else False,
                # La hora de la burbuja va en los DOS roles, como en la app y en
                # la web. Llega en UTC y SIN marca de zona; quien la convierte a
                # hora local es bubbleTime() en el widget.
                "createdAt": m.get("created_at"),
                "credits": m.get("credits") if role == "assistant" else None,
                "rows": m.get("odoo_result_count") if role == "assistant" else None,
                # El grafico viaja DENTRO de la consulta guardada (igual que
                # en la app y la web), asi que sobrevive al historial, donde
                # ya no hay filas que mirar. None en la mayoria de turnos,
                # que es lo correcto: pocas respuestas admiten grafico.
                "chart": ((m.get("odoo_query") or {}).get("chart")
                          if role == "assistant" else None),
                "feedback": m.get("feedback") if role == "assistant" else None,
                # El motivo que escribio al marcar 'dislike'. Vuelve para que al
                # recargar el hilo lo siga viendo: un comentario que desaparece
                # se siente como que no se guardo.
                "feedbackComment": (
                    m.get("feedback_comment") if role == "assistant" else None),
            })
        return out

    def _fetch_export_html(self, message_id, tz_offset_minutes):
        rec = self.sudo()
        # Idioma del usuario de Odoo (es_419, en_US, pt_BR...): el backend lo
        # normaliza y devuelve el "chrome" del reporte (titulo, "Exportado", el
        # pie) en ese idioma. Sin esto el PDF salia siempre en espanol, aunque
        # el usuario tuviera Odoo en ingles.
        lang = self.env.user.lang or ""
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/chat/messages/%s/export-html" % message_id,
                params={"tz_offset_minutes": tz_offset_minutes, "lang": lang},
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code == 403:
            raise UserError(rec._error_message(resp))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        data = resp.json()
        return {"content_html": data.get("content_html", "")}

    # =================================================================
    #  Las demas funciones del chat que YA se pueden usar con un PAT
    # =================================================================
    # ⛔ Aqui solo entra lo que el backend acepta con token personal. Lo que
    # exige sesion de navegador (listar y revocar enlaces, borrar la
    # conversacion, avisos programados) NO se finge: una fila que responde 401
    # es peor que una fila que no esta.

    @api.model
    def message_records(self, message_id):
        """Los registros que hay DETRAS de una cifra.

        No devuelve filas guardadas: el backend RE-EJECUTA la consulta con las
        credenciales del usuario, asi que los permisos se aplican al mirar. Y
        puede declinar con un motivo legible — eso no es un error, es la
        explicacion, y se pasa tal cual al widget.
        """
        rec = self._link_para_chat()
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/chat/messages/%s/records" % message_id,
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    @api.model
    def export_message_xlsx(self, message_id):
        """La hoja de calculo de una respuesta, en base64.

        El backend vuelve a ejecutar la consulta: las filas no se guardan con el
        mensaje. Eso hace que el fichero lleve las cifras de HOY, con los rangos
        relativos reanclados.
        """
        rec = self._link_para_chat()
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/chat/messages/%s/export-xlsx" % message_id,
                params={"lang": self.env.user.lang or ""},
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        data = resp.json()
        return {
            "filename": data.get("filename") or "aski.xlsx",
            "content_b64": data.get("content_b64") or "",
            "rows": data.get("rows") or 0,
        }

    @api.model
    def email_answer(self, message_id, to, attach_xlsx=False, tz_offset_minutes=0):
        """Manda la respuesta por correo.

        Sale con el `reply_to` del usuario: quien lo recibe ve de quien viene y
        le contesta a EL. El backend lo limita por plan y por cupo diario, y
        devuelve el MOTIVO cuando falla — se propaga entero en vez de un
        "no se pudo enviar" que deja reintentando lo mismo.
        """
        rec = self._link_para_chat()
        destinos = [d.strip() for d in (to or []) if (d or "").strip()]
        if not destinos:
            raise UserError(_("Add at least one email address."))
        cuerpo = {
            "to": destinos,
            "attach_xlsx": bool(attach_xlsx),
            "lang": self.env.user.lang or None,
            "tz_offset_minutes": tz_offset_minutes,
        }
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/chat/messages/%s/answer-email" % message_id,
                json=cuerpo, headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    @api.model
    def create_share(self, message_id, days=None):
        """Crea el enlace publico de una respuesta.

        ⛔ Solo CREA. Listar y revocar enlaces se queda fuera del modulo a
        proposito: administrar los enlaces de la cuenta se hace donde vive la
        cuenta, no dentro del Odoo de un cliente. El backend recorta los dias
        en silencio al maximo del plan, asi que lo que se ensena al usuario es
        el `expires_at` que VUELVE, no el que se pidio.
        """
        rec = self._link_para_chat()
        cuerpo = {}
        if days:
            cuerpo["days"] = int(days)
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/chat/messages/%s/share" % message_id,
                json=cuerpo, headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        data = resp.json()
        return {
            "url": data.get("url") or "",
            "expires_at": data.get("expires_at") or "",
            "has_password": bool(data.get("has_password")),
        }

    @api.model
    def get_wallet(self):
        """El saldo REAL, releido del backend.

        El widget restaba el coste en local tras cada respuesta, que es solo una
        estimacion: si el cobro difiere del estimado —o el entorno no cobra— la
        cabecera se queda desfasada hasta la siguiente recarga. Esto la corrige
        con lo que dice el servidor, que es la unica cifra que vale.
        """
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.pat:
            return {"wallet_credits": 0, "plan_name": ""}
        rec._sync_wallet()
        return {"wallet_credits": rec.wallet_credits or 0,
                "plan_name": rec.plan_name or ""}

    @api.model
    def clear_context(self, conversation_id):
        """Olvida el contexto del hilo SIN borrarlo: la siguiente pregunta no
        arrastra lo anterior. Mismo endpoint que el chip del pie en la app y en
        la web."""
        rec = self._link_para_chat()
        try:
            resp = requests.post(
                aski_api_base(self.env)
                + "/chat/conversations/%s/clear-context" % conversation_id,
                json={}, headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code not in (200, 204):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return True

    def _link_para_chat(self):
        """La conexion activa, ya comprobada. Estaba repetido en cada metodo."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            raise UserError(self._not_connected_error())
        return rec.sudo()

    @api.model
    def export_message_pdf(self, message_id, tz_offset_minutes=0):
        """Exporta UNA respuesta puntual (boton 'Exportar' del panel de
        detalle de un mensaje) — mismo endpoint que usan Android/web."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        return rec._fetch_export_html(message_id, tz_offset_minutes)

    @api.model
    def export_answer_pdf(self, conversation_id, tz_offset_minutes=0):
        """Exporta la ULTIMA respuesta de Aski en esa conversacion (boton
        global del composer). El endpoint de chat no devuelve el id del
        mensaje assistant, asi que primero se resuelve via
        /conversations/.../messages (mismo patron que ya usan Android/web)."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/chat/conversations/%s/messages" % conversation_id,
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        messages = resp.json()
        assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
        if not assistant_msgs:
            raise UserError(_("There's no Aski answer to export yet."))
        return rec._fetch_export_html(assistant_msgs[-1]["id"], tz_offset_minutes)

    @api.model
    def set_feedback(self, message_id, feedback, comment=None):
        """Like/dislike de una respuesta (pulgares de la burbuja y del panel de
        detalle), con el motivo opcional que se escribe al marcar 'dislike'.

        `comment` solo viaja SI lo hay: el backend no borra a proposito el motivo
        ya guardado cuando el PATCH no lo trae (el cliente puede estar solo
        cambiando el pulgar), asi que mandar una cadena vacia pisaria lo que el
        usuario escribio. El recorte a 500 y el "solo espacios = vacio" los hace
        el backend; no se duplican aqui.
        """
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec:
            raise UserError(self._not_connected_error())
        payload = {"feedback": feedback}
        if comment:
            payload["comment"] = comment
        try:
            resp = requests.patch(
                aski_api_base(self.env) + "/chat/messages/%s/feedback" % message_id,
                json=payload, headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code not in (200, 204):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return True

    # =================================================================
    #  Avisos programados, acciones sobre el ERP y asientos de equipo
    # =================================================================
    # Las tres funciones que al conector le faltaban. Las dos primeras ya existian
    # en el backend y solo les faltaba aceptar el token personal; la tercera es
    # nueva. El orden de este bloque es el de su riesgo: leer, avisar, escribir.

    @_rpc_seguro
    @api.model
    def list_insights(self):
        """Los avisos que le tocan a ESTA conexion, y que conexiones tiene la cuenta.

        Devuelve un dict con `ok` en vez de una lista pelada por lo mismo que la
        busqueda: una lista vacia no distingue "no tienes ninguno" de "no se pudo
        preguntar", y son dos pantallas distintas.
        """
        self._ensure_chat_access()
        vacio = {"ok": False, "insights": [], "alert_limit": 0, "free_kinds": [],
                 "connections": [], "credential_id": 0}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            return vacio
        try:
            # ⛔ SIN `credential_id`. El backend filtra por la conexion PRINCIPAL
            # del aviso, y el resumen y el cierre pasaron a ser UNO por cuenta que
            # cubre VARIAS conexiones: la de aqui puede ser una de las
            # adicionales, y entonces el filtro la dejaba fuera. La hoja ofrecia
            # encender un resumen que ya existia y el backend contestaba 409.
            # Lo que es de una sola instancia (alertas, vigias, recordatorios,
            # informes) se acota abajo, que es donde se puede distinguir.
            resp = requests.get(aski_api_base(self.env) + "/insights",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return vacio
        if resp.status_code != 200:
            return vacio
        datos = resp.json() or {}
        # ⛔ El backend NO devuelve una lista `insights`: devuelve los avisos
        # REPARTIDOS por tipo (`digest` y `closing` sueltos, y `alerts`,
        # `watches`, `reminders`, `reports` en listas), y el contador se llama
        # `alerts_used`, no `alert_used`. Leyendo los nombres equivocados, esto
        # devolvia SIEMPRE una lista vacia y el cupo en None — para todo el
        # mundo, no solo en un caso raro. La hoja decia «aun no tienes avisos»
        # con dos avisos encendidos detras, ofrecia encender un resumen que ya
        # existia, y el 409 que devolvia el backend salia disfrazado de «cupo
        # lleno». El arnes no lo veia porque simula ESTE metodo, no el backend.
        filas = []
        # El resumen y el cierre son de la CUENTA: se toman vengan de donde
        # vengan, sin mirar cual es su conexion principal. Cual cubren lo dice su
        # `connections_label`, y desde la hoja se puede cambiar.
        for plural, unico in (("digests", "digest"), ("closings", "closing")):
            varios = datos.get(plural)
            if varios:
                filas.extend(varios)
            elif datos.get(unico):
                filas.append(datos[unico])
        # Lo demas SI es de una instancia: una alerta pregunta por los datos de un
        # ERP concreto y en otro no significa nada.
        for lista in ("alerts", "watches", "reminders", "reports"):
            filas.extend([f for f in (datos.get(lista) or [])
                          if f.get("credential_id") == rec.credential_id])
        return {
            "ok": True,
            "insights": filas,
            "alert_limit": datos.get("alert_limit"),
            "alert_used": datos.get("alerts_used"),
            # QUIEN se lo gasto: con varias personas en la cuenta, un
            # numero suelto no deja resolver «se me acabo y yo no fui».
            "by_person": datos.get("alerts_by_person") or [],
            "free_kinds": datos.get("kinds_free_in_plan") or [],
            # El plan mas barato que si trae avisos, para cuando el cupo es 0.
            "upsell": datos.get("alerts_min_plan") or "",
            # Las conexiones de la cuenta, para poder elegir a cuales cubre el
            # resumen. Marcadas con `current` para no obligar a adivinar cual es
            # la de este Odoo.
            "connections": self._conexiones_cuenta(rec).get("connections") or [],
            "credential_id": rec.credential_id,
        }

    @_rpc_seguro
    @api.model
    def set_insight_connections(self, insight_id, connection_ids):
        """A que conexiones cubre un resumen o un cierre.

        Se manda la lista COMPLETA (`connection_ids`), no un delta: la ventana
        manda lo que quedo marcado y el backend reparte principal + adicionales.
        Es la misma llamada que hace la app, para que las dos digan lo mismo.

        ⛔ Cualquiera que use el token de la cuenta puede moverlo, a proposito: el
        aviso es de la CUENTA y no de la instancia desde la que se creo. Quien
        quiera que nadie se lo toque, que use su propia cuenta.
        """
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        ids = []
        for c in (connection_ids or []):
            try:
                valor = int(c)
            except (TypeError, ValueError):
                continue
            if valor > 0 and valor not in ids:
                ids.append(valor)
        if not ids:
            # Un aviso sin conexiones no tiene de que hablar, y el backend lo
            # rechaza. Se dice aqui, que es donde se entiende.
            raise UserError(_("Pick at least one connection."))
        try:
            resp = requests.patch(
                aski_api_base(self.env) + "/insights/%s" % int(insight_id),
                json={"connection_ids": ids}, headers=rec._headers(),
                timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    @_rpc_seguro
    @api.model
    def create_insight(self, vals):
        """Crea un aviso que se entrega en la BANDEJA de este Odoo.

        `delivery='odoo'` no es opcional aqui: quien lo crea esta dentro del ERP y
        no tiene la app instalada, asi que un push no llegaria a ningun sitio y un
        correo lo sacaria de donde ya esta trabajando. El backend lo deja en
        Discuss escribiendo con la MISMA credencial con la que lo calculo.
        """
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            raise UserError(self._not_connected_error())
        cuerpo = dict(vals or {})
        cuerpo["credential_id"] = rec.credential_id
        cuerpo["delivery"] = "odoo"
        # La zona horaria y el idioma salen del propio Odoo: preguntarselos seria
        # pedirle dos veces algo que su sesion ya sabe.
        cuerpo.setdefault("tz", self.env.user.tz or "UTC")
        cuerpo.setdefault("lang", (self.env.user.lang or "es")[:2])
        try:
            resp = requests.post(aski_api_base(self.env) + "/insights",
                                 json=cuerpo, headers=rec._headers(),
                                 timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code == 409:
            # ⛔ 409 NO significa siempre "cupo lleno": el backend lo usa tambien
            # para "ya lo tienes". Traducirlo todo a cupo mandaba a la persona a
            # borrar avisos para hacer sitio a uno que YA estaba encendido.
            codigo = ""
            try:
                codigo = str(((resp.json() or {}).get("detail") or {}).get("code") or "")
            except Exception:  # noqa: BLE001
                codigo = ""
            if codigo.endswith("_already_exists"):
                raise UserError(_("You already have that alert on this connection."))
            raise UserError(_(
                "Your account has used all its scheduled alerts. Delete one, or "
                "ask the account owner to move up a plan."))
        if resp.status_code == 403:
            raise UserError(_("Scheduled alerts are not included in your plan."))
        if resp.status_code not in (200, 201):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    @_rpc_seguro
    @api.model
    def set_insight_enabled(self, insight_id, enabled):
        """Enciende o apaga un aviso.

        Lo decide el USUARIO. La pausa por falta de plan, de saldo o de cupo la
        decide el sistema y no se toca desde aqui: si se tocara, al recuperar el
        plan se le reactivaria algo que el habia apagado a proposito.
        """
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.patch(
                aski_api_base(self.env) + "/insights/%s" % int(insight_id),
                json={"enabled": bool(enabled)}, headers=rec._headers(),
                timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    @api.model
    def resume_insight(self, insight_id):
        """Reanuda un aviso que pauso el SISTEMA (sin plan, sin saldo, fallando)."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/insights/%s/resume" % int(insight_id),
                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    @api.model
    def delete_insight(self, insight_id):
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.delete(
                aski_api_base(self.env) + "/insights/%s" % int(insight_id),
                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code not in (200, 204):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return True

    # -----------------------------------------------------------------
    #  Acciones sobre el ERP
    # -----------------------------------------------------------------
    # SOLO en modo "por usuario", y esta es la frontera que el backend NO puede
    # vigilar por si solo: una accion escribe en el ERP con la credencial que se le
    # pase, y en los modos compartidos esa credencial es la del ADMINISTRADOR. Con
    # el gate aqui, quien escribe lo hace siempre con su propio usuario y sus
    # propios permisos. Saltarselo exige ser administrador de este Odoo, es decir,
    # tener ya la llave que se querria robar.

    @api.model
    def _acciones_permitidas(self):
        return self._current_mode() == "per_user"

    @_rpc_seguro
    @api.model
    def list_actions(self):
        """Acciones pendientes de confirmar, con el estado de la funcion.

        Responde SIEMPRE, tambien a quien no la tiene: `feature_enabled` y
        `mode_ok` dicen por que no se ve, que es lo que permite explicarlo en vez
        de esconder la seccion y dejar a la persona sin saber que existe.
        """
        self._ensure_chat_access()
        base = {"ok": False, "actions": [], "feature_enabled": False,
                "mode_ok": self._acciones_permitidas()}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not base["mode_ok"]:
            return base
        try:
            resp = requests.get(aski_api_base(self.env) + "/actions",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return base
        if resp.status_code != 200:
            return base
        datos = resp.json() or {}
        base.update({
            "ok": True,
            "actions": datos.get("actions") or [],
            "feature_enabled": bool(datos.get("feature_enabled")),
        })
        return base

    @_rpc_seguro
    @api.model
    def confirm_action(self, action_id):
        """Ejecuta una accion ya propuesta.

        Doble confirmacion: el widget pregunta y el backend vuelve a comprobar
        plan, propiedad, vigencia y, sobre todo, que el dato no haya cambiado
        desde que se propuso. Ese ultimo control es el que evita el peor caso
        concreto de esta funcion: mandarle un cobro a un cliente que ya pago.
        """
        self._ensure_chat_access()
        if not self._acciones_permitidas():
            raise UserError(_(
                "Actions on your ERP are only available when the chat runs in "
                "Per user mode, so that every change is made with the permissions "
                "of the person who asked for it."))
        rec = self._active_link(self.env.user)
        if not rec:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/actions/%s/confirm" % int(action_id),
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code == 403:
            raise UserError(_("Actions on your ERP are not included in your plan."))
        if resp.status_code not in (200, 201):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    @_rpc_seguro
    @api.model
    def cancel_action(self, action_id):
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/actions/%s/cancel" % int(action_id),
                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code not in (200, 201):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return resp.json()

    # -----------------------------------------------------------------
    #  Asientos de equipo
    # -----------------------------------------------------------------
    @_rpc_seguro
    @api.model
    def seat_status(self):
        """Si esta persona se sienta en la cuenta de otro, y con que limites.

        Lo consulta el widget para saber que enseñarle a quien abre el chat sin
        cuenta propia: hasta ahora le decia "conecta tu propia cuenta" y descubria
        el precio de un plan entero al final del camino.
        """
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            return {"connected": False, "is_seat": False}
        try:
            resp = requests.get(aski_api_base(self.env) + "/seats/me",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return {"connected": True, "is_seat": False}
        if resp.status_code != 200:
            return {"connected": True, "is_seat": False}
        datos = resp.json() or {}
        datos["connected"] = True
        return datos

    @_rpc_seguro
    @api.model
    def team_seats(self):
        """El equipo de la cuenta, para quien es titular. Vacio para los demas."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            return {"ok": False, "capacity": {}, "seats": []}
        try:
            resp = requests.get(aski_api_base(self.env) + "/seats",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return {"ok": False, "capacity": {}, "seats": []}
        if resp.status_code != 200:
            return {"ok": False, "capacity": {}, "seats": []}
        datos = resp.json() or {}
        datos["ok"] = True
        # ⛔ La base de la WEB la pone el modulo, no el widget: en Odoo
        # `window.location.origin` es el dominio del cliente. Va aqui dentro y no
        # en otra llamada porque la hoja ya esta pidiendo esto, y quien NO tiene
        # socio necesita el enlace para comprar — dentro de Odoo si se puede
        # llevar a la pasarela (la regla de Google Play es de la app, no de aqui).
        datos["web_base"] = self._web_base()
        return datos

    def _web_base(self):
        """Donde vive la web de Aski. Configurable para despliegues propios."""
        return (self.env["ir.config_parameter"].sudo()
                .get_param("aski.web_base") or "https://app.aski.dev").rstrip("/")

    @_rpc_seguro
    @api.model
    def request_more_credits(self):
        """Un asiento le pide a su titular que le suba el tope.

        ⛔ Al asiento no se le enseñan precios ni boton de compra: quien paga es
        el titular. Pero sin una forma de pedirlo, el tope es un muro sin salida y
        la persona acaba escribiendo por fuera o dejando de usarlo.
        """
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.post(aski_api_base(self.env) + "/seats/me/request-credits",
                                 headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code == 200:
            return resp.json()
        raise UserError(self._error_asiento(resp))

    @_rpc_seguro
    @api.model
    def invite_seat(self, vals):
        """Invita a alguien al equipo DESDE Odoo.

        ⛔ Existe porque quien usa Aski dentro de Odoo suele estar ahi justamente
        por no querer llevar sus datos a otra pantalla: mandarle a la web o a la
        app para dar de alta a un companero es mandarle a lo que evita. El
        backend valida cupo, correo y tope; aqui solo se traslada.
        """
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        correo = (vals or {}).get("email") or ""
        cuerpo = {
            "email": correo.strip(),
            "role": (vals or {}).get("role") or "member",
            "monthly_credit_cap": (vals or {}).get("monthly_credit_cap") or None,
        }
        try:
            resp = requests.post(aski_api_base(self.env) + "/seats/invite",
                                 json=cuerpo, headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code in (200, 201):
            datos = resp.json() or {}
            # ⛔ El enlace lo arma EL MODULO, no el widget: en Odoo
            # `window.location.origin` es el dominio del cliente, no el de Aski,
            # y saldria un enlace que no lleva a ninguna parte. La base se puede
            # cambiar por parametro del sistema para los despliegues propios.
            base = self._web_base()
            token = datos.get("invite_token") or ""
            if token:
                from urllib.parse import quote
                datos["invite_link"] = "%s/team/join?token=%s" % (base, quote(token))
            return datos
        raise UserError(self._error_asiento(resp))

    @_rpc_seguro
    @api.model
    def set_seat_active(self, seat_id, active):
        """Quita o devuelve el asiento. No borra nada: ver la regla del backend."""
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        destino = "resume" if active else "suspend"
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/seats/%s/%s" % (int(seat_id), destino),
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code == 200:
            return resp.json()
        raise UserError(self._error_asiento(resp))

    @_rpc_seguro
    @api.model
    def cancel_seat_invite(self, seat_id):
        """Retira una invitacion que nadie acepto y libera el asiento."""
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.delete(
                aski_api_base(self.env) + "/seats/%s" % int(seat_id),
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code in (200, 204):
            return {"ok": True}
        raise UserError(self._error_asiento(resp))

    @_rpc_seguro
    @api.model
    def request_to_partner(self, kind, plan_id=None, pack_id=None):
        """Le pide a su proveedor un asiento mas, un plan o una recarga.

        ⛔ Aqui NO se enlaza a la pasarela ni se manda a "contactar a ventas":
        quien usa Aski dentro de Odoo suele estar ahi justamente por no querer
        salir a otra pantalla, y ademas su tarifa la pone su socio. Se deja una
        peticion REGISTRADA que el socio ve en su panel y resuelve de un toque —
        no un mensaje que se pierde fuera del producto.

        No se confunde con `request_seat`: aquel lo usa alguien SIN cuenta que
        pide sentarse; este lo usa el titular, que ya la tiene y quiere mas sitio.
        """
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        # ⛔ Se OMITEN los vacios, no se mandan como False: `_sin_nulos` sirve
        # para la RESPUESTA (XML-RPC no marshalea None) y aplicarla al cuerpo
        # enviaria `plan_id: false`, que el backend rechaza. Aqui lo que toca es
        # que el campo no viaje.
        cuerpo = {"kind": kind}
        if plan_id:
            cuerpo["plan_id"] = plan_id
        if pack_id:
            cuerpo["pack_id"] = pack_id
        try:
            resp = requests.post(aski_api_base(self.env) + "/partner/requests",
                                 json=cuerpo, headers=rec._headers(),
                                 timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code in (200, 201):
            return resp.json() or {}
        raise UserError(self._error_asiento(resp))

    @_rpc_seguro
    @api.model
    def my_partner_requests(self):
        """Lo que esta cuenta ya pidio y sigue sin resolver.

        Sin esto el boton no sabe que ya se pulso, y quien no ve respuesta
        inmediata lo pide cinco veces — cinco filas de ruido en el panel del
        socio por una sola intencion.
        """
        vacio = {"ok": False, "requests": []}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            return vacio
        try:
            resp = requests.get(aski_api_base(self.env) + "/partner/requests/mine",
                                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return vacio
        if resp.status_code != 200:
            return vacio
        return {"ok": True, "requests": list(resp.json() or [])}

    @_rpc_seguro
    @api.model
    def update_seat(self, seat_id, vals):
        """Cambia el ROL o el TOPE mensual de un asiento ya creado.

        ⛔ El tope se quita mandando **0**, no vacio: en un PATCH parcial, "no lo
        mande" y "ponlo en nada" son indistinguibles, y el cero es explicito. Un
        tope de cero real dejaria a la persona sin poder preguntar, que no es algo
        que nadie configure a proposito.
        """
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            raise UserError(self._not_connected_error())
        # Solo viaja lo que se quiere cambiar: es un PATCH parcial.
        cuerpo = {}
        rol = (vals or {}).get("role")
        tope = (vals or {}).get("monthly_credit_cap")
        if rol:
            cuerpo["role"] = rol
        if tope is not None:
            cuerpo["monthly_credit_cap"] = int(tope)
        try:
            resp = requests.patch(
                aski_api_base(self.env) + "/seats/%s" % int(seat_id),
                json=cuerpo, headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code == 200:
            return resp.json() or {}
        raise UserError(self._error_asiento(resp))

    @_rpc_seguro
    @api.model
    def billing_catalog(self):
        """Que planes y recargas se le pueden PEDIR al proveedor.

        Se traen del backend y no se escriben aqui por lo mismo que la tarifa de
        asientos: una copia de los precios dentro del modulo se separa de la real
        en el primer cambio, y el cliente veria una cifra que su socio no le va a
        cobrar. Solo mensuales y sin SAP, igual que la lista que ya ve en la web.
        """
        vacio = {"ok": False, "plans": [], "packs": []}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            return vacio
        try:
            rp = requests.get(aski_api_base(self.env) + "/billing/plans",
                              headers=rec._headers(), timeout=_TIMEOUT_FAST)
            rk = requests.get(aski_api_base(self.env) + "/billing/packs",
                              headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return vacio
        if rp.status_code != 200:
            return vacio
        planes = [
            {
                "id": p.get("id"), "name": p.get("name"),
                "monthly_credits": p.get("monthly_credits"),
                "daily_query_limit": p.get("daily_query_limit"),
            }
            for p in (rp.json() or [])
            if p.get("period") != "annual" and not str(p.get("id", "")).startswith("sap_")
        ]
        packs = []
        if rk.status_code == 200:
            packs = [
                {"id": k.get("id"), "credits": k.get("credits")}
                for k in (rk.json() or [])
            ]
        return {"ok": True, "plans": planes, "packs": packs}

    def _error_asiento(self, resp):
        """Traduce el codigo del backend a algo que se pueda leer.

        ⛔ Por CODIGO, no por el estado HTTP: el backend usa 409 para media
        docena de situaciones distintas y traducirlas todas igual fue lo que hizo
        que «ya lo tienes» saliera como «cupo lleno».
        """
        codigo = ""
        try:
            codigo = str(((resp.json() or {}).get("detail") or {}).get("code") or "")
        except Exception:  # noqa: BLE001
            codigo = ""
        return {
            "no_seats_available": _("There are no free seats. Take one back, or add one from the Aski app."),
            "plan_without_seats": _("Your plan does not include team seats."),
            "already_invited": _("That person already has an invitation."),
            "already_seated": _("That person is already on your team."),
            "has_own_plan": _("That person already pays for their own Aski plan."),
            "invalid_email": _("That email address does not look right."),
            "never_accepted": _("That invitation was never accepted."),
            "already_accepted": _("That invitation was already accepted."),
            "seat_not_found": _("That seat no longer exists."),
        }.get(codigo) or (_("Aski error: %s") % self._error_message(resp))

    @_rpc_seguro
    @api.model
    def request_seat(self):
        """Pide un asiento para el usuario ACTUAL de Odoo.

        No lleva token: quien pide todavia no tiene cuenta en Aski, y crearsela
        antes de que se la concedan deja cuentas huerfanas de gente que nunca
        entro. Lo que autentica la peticion es que esta INSTANCIA ya tenga una
        cuenta conectada; si nadie de aqui usa Aski, no hay a quien pedirselo.

        Devuelve a quien le llego para poder decirlo en pantalla: al socio que
        lleva la cuenta, o al titular.
        """
        user = self.env.user
        base = self.env["ir.config_parameter"].sudo().get_param("web.base.url") or ""
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/seats/request",
                json={
                    "instance_url": base,
                    "erp_login": user.login,
                    "name": user.name,
                    "email": user.email or None,
                    "erp_type": "odoo",
                },
                timeout=_TIMEOUT_FAST)
        except Exception as e:  # noqa: BLE001
            raise UserError(aski_mensaje_red(self.env, e))
        if resp.status_code == 404:
            raise UserError(_(
                "Nobody in this Odoo is using Aski yet, so there is no one to ask. "
                "Connect your own account to get started."))
        if resp.status_code not in (200, 201):
            raise UserError(_("Aski error: %s") % self._error_message(resp))
        return resp.json()

    @_rpc_seguro
    @api.model
    def watch_metrics(self):
        """Que se puede VIGILAR en esta conexion, con su valor de hoy.

        Lo sirve el backend porque las metricas se derivan del mismo motor que
        despues las evalua: si una aparece en la lista es porque existe en ESTA
        instancia, y una nueva sale sin publicar version del modulo.

        Devuelve dict con `ok` y nunca lanza: esto se pide al abrir un formulario
        y un dialogo de error encima de una hoja es peor que una lista vacia con
        su explicacion.
        """
        self._ensure_chat_access()
        vacio = {"ok": False, "metrics": []}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            return vacio
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/insights/metrics",
                params={"credential_id": rec.credential_id,
                        "lang": (self.env.user.lang or "es")[:2]},
                headers=rec._headers(), timeout=_TIMEOUT_SUGGESTIONS)
        except Exception:  # noqa: BLE001
            return vacio
        if resp.status_code != 200:
            return vacio
        return {"ok": True, "metrics": (resp.json() or {}).get("metrics") or []}

    @_rpc_seguro
    @api.model
    def reminder_topics(self):
        """Que puede RECORDARTE esta conexion (facturas por vencer, etc.)."""
        self._ensure_chat_access()
        vacio = {"ok": False, "topics": []}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected or not rec.credential_id:
            return vacio
        try:
            resp = requests.get(
                aski_api_base(self.env) + "/insights/reminder-topics",
                params={"credential_id": rec.credential_id,
                        "lang": (self.env.user.lang or "es")[:2]},
                headers=rec._headers(), timeout=_TIMEOUT_FAST)
        except Exception:  # noqa: BLE001
            return vacio
        if resp.status_code != 200:
            return vacio
        return {"ok": True, "topics": (resp.json() or {}).get("topics") or []}

    def _catalogo(self, ruta, params=None):
        """Lo comun a los dos catalogos: pedirlos y no romper si no llegan.

        ⛔ Ambos responden 200 SIEMPRE (tambien sin el plan y con la funcion
        apagada) a proposito: quien no sabe que algo existe no lo compra nunca.
        Asi que aqui NO se filtra por plan — se muestra el mapa entero y cada
        item dice si va en ESTA conexion.
        """
        vacio = {"ok": False, "groups": []}
        rec = self._active_link(self.env.user)
        if not rec or not rec.connected:
            return vacio
        datos = dict(params or {})
        datos["lang"] = (self.env.user.lang or "es")[:2]
        if rec.credential_id:
            datos["credential_id"] = rec.credential_id
        try:
            resp = requests.get(aski_api_base(self.env) + ruta, params=datos,
                                headers=rec._headers(),
                                timeout=_TIMEOUT_SUGGESTIONS)
        except Exception:  # noqa: BLE001
            return vacio
        if resp.status_code != 200:
            return vacio
        cuerpo = resp.json() or {}
        salida = {"ok": True, "groups": cuerpo.get("groups") or []}
        for campo in ("total", "available", "feature_enabled", "connection_name",
                      "erp_type", "credits_per_run", "credits_per_action",
                      "in_plan"):
            if campo in cuerpo:
                salida[campo] = cuerpo[campo]
        return salida

    @_rpc_seguro
    @api.model
    def insights_catalog(self, kind=None):
        """El mapa de lo que Aski sabe vigilar y recordar.

        Faltaba: la hoja ofrecia crear un vigia sin decir en ningun sitio QUE se
        puede vigilar, asi que solo lo descubria quien ya lo sabia. Android y la
        web llevan este catalogo desde hace tiempo; el conector se quedo atras.

        `kind` acota a un lado ("watch" | "reminder") porque cada seccion ensena
        el suyo: las cifras en Vigias, los registros en Avisos.
        """
        self._ensure_chat_access()
        return self._catalogo("/insights/catalog", {"kind": kind} if kind else None)

    @_rpc_seguro
    @api.model
    def actions_catalog(self):
        """Que puede HACER Aski sobre este ERP (cobrar, agendar, etc.).

        Mismo hueco que el de avisos y peor: la seccion de acciones nombraba dos
        verbos de ejemplo cuando ya hay diez, porque el texto estaba escrito a
        mano. Servido por el backend, un verbo nuevo aparece sin publicar
        version del modulo.
        """
        self._ensure_chat_access()
        return self._catalogo("/actions/catalog")


    # -----------------------------------------------------------------
    #  Entrega de un aviso en la bandeja de Odoo
    # -----------------------------------------------------------------

    @_rpc_seguro
    @api.model
    def deliver_inbox(self, vals):
        """Deja un aviso de Aski en la BANDEJA de Odoo de QUIEN LLAMA.

        Lo invoca el backend con la MISMA credencial con la que calculo el
        aviso, y solo puede escribirle a esa misma persona: desde aqui no hay
        forma de notificar a un tercero.

        ⛔ No se usa `message_notify`: reparte segun la preferencia del
        destinatario (`res.users.notification_type`, que de fabrica es "por
        correo"), asi que el aviso NO aparecia en la campana y encima encolaba
        un correo de verdad en el Odoo del cliente. Comprobado en Odoo 19: la
        bandeja no subia ni un mensaje.

        ⛔ Tampoco vale crear el mensaje a pelo desde el backend: eso no toca el
        bus y el contador de la campana no se movia hasta recargar la pagina.
        Aqui se reparte con el MISMO metodo interno con el que Odoo llena la
        bandeja, que crea la notificacion y avisa por el bus de una vez.
        """
        if not isinstance(vals, dict):
            return False
        cuerpo = (vals.get("body") or "").strip()
        if not cuerpo:
            return False
        usuario = self.env.user
        socio = usuario.partner_id
        if not socio:
            return False
        mensaje = self.env["mail.message"].sudo().create({
            "subject": (vals.get("subject") or "Aski")[:200],
            # Markup, o Odoo escapa el HTML y el aviso sale como un ladrillo con
            # las etiquetas a la vista.
            "body": Markup(cuerpo),
            "message_type": "user_notification",
            # Sin autor, y con el NOMBRE a secas: con `author_id` puesto el aviso
            # se leia como si te lo hubieras escrito tu mismo, y con el correo
            # dentro salia "Aski <avisos@aski.dev>" en vez de "Aski".
            "author_id": False,
            "email_from": "Aski",
            "partner_ids": [(6, 0, socio.ids)],
        })
        destinatario = [{
            "id": socio.id, "uid": usuario.id, "notif": "inbox",
            "type": "user", "active": True, "share": False,
            "groups": [], "ushare": False,
        }]
        try:
            self.env["mail.thread"]._notify_thread_by_inbox(mensaje, destinatario)
        except Exception:  # noqa: BLE001
            # Si esa via interna no esta en esta serie, que el aviso llegue igual:
            # lo unico que se pierde es que el contador salte sin recargar.
            _logger.warning("aski: bandeja repartida por la via corta", exc_info=True)
            self.env["mail.notification"].sudo().create({
                "mail_message_id": mensaje.id,
                "res_partner_id": socio.id,
                "notification_type": "inbox",
                "notification_status": "sent",
                "is_read": False,
            })
        return True
