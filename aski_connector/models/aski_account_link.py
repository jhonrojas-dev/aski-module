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
    # Singleton por BASE DE DATOS, no por compania activa. Un Odoo multi-
    # compania sigue siendo UNA sola instancia hacia afuera (una URL, un
    # xmlrpc) — usar self.env.company aqui hacia que conectar con la
    # compania A activa dejara "sin conectar" a la compania B, aunque sea
    # la MISMA base y la MISMA conexion Aski. Ignorar company_id.
    # ------------------------------------------------------------------
    @api.model
    def _get_or_create(self):
        rec = self.sudo().search([], order="id", limit=1)
        if not rec:
            rec = self.sudo().create({})
        return rec

    # ------------------------------------------------------------------
    # Acceso al chat: grupo EXCLUSIVO. El chat lee via la conexion compartida
    # (el token del admin), asi que un usuario fuera del grupo veria cifras de
    # toda la empresa saltandose sus propias reglas de registro. El grupo es la
    # unica puerta: los admin lo tienen implicito; a los demas se les concede a
    # mano en Ajustes > Usuarios.
    # ------------------------------------------------------------------
    _CHAT_GROUP = "aski_connector.group_aski_chat_user"

    @api.model
    def can_use_chat(self):
        """True si el usuario actual pertenece al grupo del chat. Lo consulta el
        systray para NO mostrar la burbuja a quien no tiene acceso (barato: es
        un has_group, no toca el backend de Aski)."""
        return self.env.user.has_group(self._CHAT_GROUP)

    def _ensure_chat_access(self):
        """Barrera REAL: los metodos del chat corren con sudo() (usan el token del
        admin), asi que ocultar el menu/burbuja no basta — hay que rechazar la
        llamada RPC directa de quien no esta en el grupo."""
        if not self.env.user.has_group(self._CHAT_GROUP):
            raise AccessError(_(
                "You don't have access to the Aski chat. Ask an administrator to "
                "add you to the \"Use the Aski chat\" group."))

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
        rec = self.sudo()._get_or_create()
        if not rec.connected:
            raise UserError(_("Aski isn't connected yet. Open Aski > Chat Settings "
                              "and paste your personal access token."))
        if not rec.credential_id:
            raise UserError(_("This Odoo isn't registered with your Aski account yet. "
                              "Open Aski > Chat Settings and reconnect."))
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
        # Suave (no lanza): el widget muestra el estado "sin acceso" en vez de
        # un error. La barrera dura vive en los metodos que traen datos.
        if not self.env.user.has_group(self._CHAT_GROUP):
            return {"allowed": False, "connected": False, "email": "",
                    "wallet_credits": 0, "plan_name": ""}
        rec = self.sudo()._get_or_create()
        if rec.connected and rec.pat:
            rec._sync_wallet()
        return {
            "allowed": True,
            "connected": rec.connected,
            "email": rec.email or "",
            "wallet_credits": rec.wallet_credits,
            "plan_name": rec.plan_name or "",
        }

    @api.model
    def list_conversations(self):
        """Historial de conversaciones de ESTA conexion (drawer del widget,
        igual que Android/web) — mas reciente primero."""
        self._ensure_chat_access()
        rec = self.sudo()._get_or_create()
        if not rec.connected or not rec.credential_id:
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
        rec = self.sudo()._get_or_create()
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
        rec = self.sudo()._get_or_create()
        if not rec.connected:
            raise UserError(_("Aski isn't connected yet. Open Aski > Chat Settings "
                              "and paste your personal access token."))
        return rec._fetch_export_html(message_id, tz_offset_minutes)

    @api.model
    def export_answer_pdf(self, conversation_id, tz_offset_minutes=0):
        """Exporta la ULTIMA respuesta de Aski en esa conversacion (boton
        global del composer). El endpoint de chat no devuelve el id del
        mensaje assistant, asi que primero se resuelve via
        /conversations/.../messages (mismo patron que ya usan Android/web)."""
        self._ensure_chat_access()
        rec = self.sudo()._get_or_create()
        if not rec.connected:
            raise UserError(_("Aski isn't connected yet. Open Aski > Chat Settings "
                              "and paste your personal access token."))
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
        rec = self.sudo()._get_or_create()
        try:
            resp = requests.patch(
                ASKI_API_BASE + "/chat/messages/%s/feedback" % message_id,
                json={"feedback": feedback}, headers=rec._headers(), timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(_("Could not reach Aski: %s") % e)
        if resp.status_code not in (200, 204):
            raise UserError(_("Aski error: %s") % rec._error_message(resp))
        return True
