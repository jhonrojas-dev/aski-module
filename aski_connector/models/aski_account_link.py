# -*- coding: utf-8 -*-
"""Conexion de esta base Odoo con una cuenta Aski, para el chat embebido.

Un registro por compania. El token (PAT) se pega UNA vez desde la web de Aski
(app.aski.dev > Settings > Personal access tokens) y de ahi en adelante el
widget de chat habla con el MISMO backend/motor/wallet que la app Android —
esto no es un producto nuevo, es un canal nuevo para la misma suscripcion.
"""
import logging

import requests

from odoo import _, api, fields, models
from odoo.exceptions import UserError

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
    # Singleton por compania — no hace falta mas de una conexion Aski.
    # ------------------------------------------------------------------
    @api.model
    def _get_or_create(self):
        rec = self.sudo().search([("company_id", "=", self.env.company.id)], limit=1)
        if not rec:
            rec = self.sudo().create({})
        return rec

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
            "wallet_credits": wallet.get("balance_credits", 0),
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
        """Registra (o refresca) esta base Odoo como una credential mas de la
        cuenta Aski conectada — POST /users/odoo, guarda el credential_id que
        despues viaja en cada /chat."""
        self.ensure_one()
        rec = self.sudo()
        body = {"nickname": nickname, "url": url, "db": db, "login": login,
                "api_key": api_key, "erp_type": "odoo"}
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
        Llamado desde el widget OWL via orm.call — corre siempre con sudo()
        para que cualquier usuario interno pueda usar la conexion configurada
        por el admin, sin necesitar acceso de lectura al token en si."""
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
        """Estado para bootstrap del widget: conectado, saldo, plan."""
        rec = self.sudo()._get_or_create()
        return {
            "connected": rec.connected,
            "email": rec.email or "",
            "wallet_credits": rec.wallet_credits,
            "plan_name": rec.plan_name or "",
        }
