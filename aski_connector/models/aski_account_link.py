# -*- coding: utf-8 -*-
"""Conexion de esta base Odoo con una cuenta Aski, para el chat embebido.

Un registro por BASE DE DATOS (no por compania: una base multi-compania sigue
siendo una sola instancia hacia afuera, un solo XML-RPC). El token (PAT) se
pega UNA vez desde la web de Aski (app.aski.dev > Settings > Personal access
tokens) y de ahi en adelante el widget de chat habla con el MISMO backend/
motor/wallet que la app Android — esto no es un producto nuevo, es un canal
nuevo para la misma suscripcion.
"""
import logging

import requests

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

from .aski_common import ASKI_API_BASE

_logger = logging.getLogger(__name__)

_TIMEOUT = 30


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
    wallet_credits = fields.Integer(string="Credits available", readonly=True)
    plan_name = fields.Char(string="Plan", readonly=True)
    last_synced = fields.Datetime(string="Last synced", readonly=True)

    # Vacio en el registro GLOBAL/compartido (la conexion del admin); en modo
    # "por usuario" cada usuario tiene su PROPIO registro con este campo puesto.
    user_id = fields.Many2one(
        "res.users", string="User", index=True, ondelete="cascade", copy=False,
        help="Empty on the shared connection; set on each person's own "
             "connection when the access mode is 'Per user'.")
    # Solo se lee del registro GLOBAL. Decide COMO autentica el chat embebido.
    access_mode = fields.Selection(
        selection=[
            ("shared_group", "Shared - the Aski Chat group uses my connection"),
            ("shared_admin", "Private - only administrators use my connection"),
            ("per_user", "Per user - each person connects their own Aski account"),
        ],
        string="Chat access mode", default="shared_group", required=True,
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

    @api.model
    def _get_global(self):
        rec = self.sudo().search([("user_id", "=", False)], order="id", limit=1)
        if not rec:
            rec = self.sudo().create({})
        return rec

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
        return self._get_global().access_mode or "shared_group"

    @api.model
    def _active_link(self, user):
        """El link que ESTE usuario usa para chatear, segun el modo. En per_user
        puede ser un recordset vacio (aun no conecto su cuenta)."""
        if self._current_mode() == "per_user":
            return self._get_user_link(user)
        return self._get_global()

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
            return detail or resp.text
        except Exception:
            return resp.text or ("HTTP %s" % resp.status_code)

    def _sync_wallet(self):
        """Verifica el token contra /billing/me y refresca el saldo/plan en cache.
        Devuelve (ok, message) — sin lanzar, para que tanto el boton interactivo
        como el wizard de conexion puedan decidir que hacer con el resultado."""
        self.ensure_one()
        rec = self.sudo()
        if not rec.pat:
            return False, _("Paste your Aski personal access token first.")
        try:
            resp = requests.get(ASKI_API_BASE + "/billing/me", headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            return False, _("Could not reach Aski: %s") % e
        if resp.status_code == 401:
            rec.write({"pat_enc": False})
            return False, _("That token is invalid or was revoked. Generate a new one in Aski.")
        if resp.status_code != 200:
            return False, rec._error_message(resp)
        data = resp.json()
        wallet = data.get("wallet") or {}
        sub = data.get("subscription") or {}
        rec.write({
            "wallet_credits": wallet.get("balance", 0),
            "plan_name": (sub or {}).get("plan_id") or "",
            "last_synced": fields.Datetime.now(),
        })
        return True, _("Connected. %s credits available.") % rec.wallet_credits

    def action_test_connection(self):
        """Boton interactivo: espejo de _sync_wallet() pero con notificacion UI."""
        ok, message = self.sudo()._sync_wallet()
        return {"type": "ir.actions.client", "tag": "display_notification", "params": {
            "title": _("Aski connection") if ok else _("Aski connection issue"),
            "message": message, "type": "success" if ok else "danger", "sticky": not ok}}

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
                    ASKI_API_BASE + "/users/odoo/%s" % rec.credential_id,
                    headers=rec._headers(), timeout=_TIMEOUT)
            except Exception:  # noqa: BLE001
                _logger.info("Aski: no se pudo archivar la credencial remota al "
                             "desconectar; se limpia igual en local", exc_info=True)
        rec._aski_revoke_previous("Aski Chat")
        rec.write({
            "pat_enc": False, "credential_id": False, "wallet_credits": 0,
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
        return {"type": "ir.actions.client", "tag": "display_notification", "params": {
            "title": _("Aski connection"),
            "message": _("Aski account disconnected."),
            "type": "success",
            "next": {"type": "ir.actions.act_window_close"}}}

    def _register_credential(self, nickname, url, db, login, api_key):
        """Registra esta base Odoo como credential de la cuenta Aski conectada.
        Si YA habia un credential_id de una conexion anterior, actualiza ESE
        registro (PUT) en vez de crear uno nuevo (POST) — antes cada
        Reconectar creaba una credential "Odoo (in-app chat)" duplicada."""
        self.ensure_one()
        rec = self.sudo()
        body = {"nickname": nickname, "url": url, "db": db, "login": login,
                "api_key": api_key, "erp_type": "odoo"}
        if rec.credential_id:
            try:
                resp = requests.put(ASKI_API_BASE + "/users/odoo/%s" % rec.credential_id,
                                    json=body, headers=rec._headers(), timeout=_TIMEOUT)
            except Exception as e:  # noqa: BLE001
                return False, _("Could not reach Aski: %s") % e
            if resp.status_code == 200:
                return True, ""
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
                return False, rec._error_message(resp)
        try:
            resp = requests.post(ASKI_API_BASE + "/users/odoo", json=body,
                                 headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            return False, _("Could not reach Aski: %s") % e
        if resp.status_code not in (200, 201):
            return False, rec._error_message(resp)
        data = resp.json()
        rec.write({"credential_id": data.get("id")})
        return True, ""

    @api.model
    def send_message(self, text, conversation_id=None):
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
        try:
            resp = requests.post(ASKI_API_BASE + "/chat", json=body, headers=rec._headers(), timeout=90)
        except requests.exceptions.Timeout:
            raise UserError(_("Aski is taking too long to answer. Try again in a moment."))
        except Exception as e:  # noqa: BLE001
            raise UserError(_("Could not reach Aski: %s") % e)
        if resp.status_code == 401:
            rec.write({"pat_enc": False})
            raise UserError(_("Your Aski connection expired. Reconnect in Aski > Chat Settings."))
        if resp.status_code == 402:
            raise UserError(_("You're out of Aski credits. Top up at %s/billing to keep chatting.")
                            % "https://app.aski.dev")
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        data = resp.json()
        return {
            "answer": data.get("answer", ""),
            "conversation_id": data.get("conversation_id"),
            "credits": data.get("credits"),
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
                    "connected": False, "email": "", "wallet_credits": 0,
                    "plan_name": ""}
        rec = self._active_link(user)
        if rec and rec.connected and rec.pat:
            rec._sync_wallet()
        return {
            "allowed": True,
            "mode": mode,
            "can_connect": self._user_can_connect(user),
            "connected": bool(rec) and rec.connected,
            "email": (rec.email or "") if rec else "",
            "wallet_credits": rec.wallet_credits if rec else 0,
            "plan_name": (rec.plan_name or "") if rec else "",
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
            resp = requests.get(ASKI_API_BASE + "/chat/conversations", headers=rec._headers(), timeout=_TIMEOUT)
        except Exception:  # noqa: BLE001
            return []
        if resp.status_code != 200:
            return []
        return [c for c in resp.json() if c.get("odoo_credential_id") == rec.credential_id]

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
                ASKI_API_BASE + "/chat/conversations/%s/messages" % conversation_id,
                headers=rec._headers(), timeout=_TIMEOUT)
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
                "credits": m.get("credits") if role == "assistant" else None,
                "rows": m.get("odoo_result_count") if role == "assistant" else None,
                "feedback": m.get("feedback") if role == "assistant" else None,
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
                ASKI_API_BASE + "/chat/messages/%s/export-html" % message_id,
                params={"tz_offset_minutes": tz_offset_minutes, "lang": lang},
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(_("Could not reach Aski: %s") % e)
        if resp.status_code == 403:
            raise UserError(rec._error_message(resp))
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        data = resp.json()
        return {"content_html": data.get("content_html", "")}

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
                ASKI_API_BASE + "/chat/conversations/%s/messages" % conversation_id,
                headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(_("Could not reach Aski: %s") % e)
        if resp.status_code != 200:
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        messages = resp.json()
        assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
        if not assistant_msgs:
            raise UserError(_("There's no Aski answer to export yet."))
        return rec._fetch_export_html(assistant_msgs[-1]["id"], tz_offset_minutes)

    @api.model
    def set_feedback(self, message_id, feedback):
        """Like/dislike de una respuesta (boton del panel de detalle)."""
        self._ensure_chat_access()
        rec = self._active_link(self.env.user)
        if not rec:
            raise UserError(self._not_connected_error())
        try:
            resp = requests.patch(
                ASKI_API_BASE + "/chat/messages/%s/feedback" % message_id,
                json={"feedback": feedback}, headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(_("Could not reach Aski: %s") % e)
        if resp.status_code not in (200, 204):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return True
