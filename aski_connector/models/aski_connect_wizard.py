# -*- coding: utf-8 -*-
import base64
import json
import logging

from odoo import _, fields, models

_logger = logging.getLogger(__name__)


class AskiConnectWizard(models.TransientModel):
    """Genera un codigo de conexion (QR + token) para enlazar este Odoo con la
    app Aski en 1 paso, sin que el usuario teclee URL/db/API key a mano.

    El token empaqueta: base_url, db, login y una API key de Odoo recien
    generada para el usuario actual (modelo estandar res.users.apikeys, 14+).
    La app Aski lo escanea y se conecta por el API externo estandar (XML-RPC).
    Compatible Odoo 14 a 19 (sin `attrs` ni `res.config.settings`, para que el
    mismo codigo sirva en todas las series).
    """

    _name = "aski.connect.wizard"
    _description = "Aski connection assistant"
    _inherit = ["aski.key.mixin"]

    token = fields.Char(string="Connection code", readonly=True)
    qr_image = fields.Binary(string="QR code", readonly=True)

    # ------------------------------------------------------------------
    # Acciones
    # ------------------------------------------------------------------
    def action_generate(self):
        """Genera la API key + token + QR y abre el paso 2 con el codigo."""
        self.ensure_one()
        user = self.env.user
        base_url = (
            self.env["ir.config_parameter"].sudo().get_param("web.base.url") or ""
        )
        dbname = self.env.cr.dbname
        # Rota: revoca el codigo "Aski Mobile" anterior de este usuario antes de
        # crear el nuevo (evita acumular claves; el QR anterior queda invalidado).
        self._aski_revoke_previous("Aski Mobile")
        key = self._aski_generate_api_key("Aski Mobile")
        payload = {
            "v": 1,
            "url": base_url,
            "db": dbname,
            "login": user.login,
            "key": key,
        }
        token = base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode()
        ).decode()
        qr = self._aski_make_qr("aski://connect?t=" + token)
        wiz = self.create({"token": token, "qr_image": qr})
        return {
            "type": "ir.actions.act_window",
            "name": _("Your Aski connection code"),
            "res_model": "aski.connect.wizard",
            "res_id": wiz.id,
            "view_mode": "form",
            "view_id": self.env.ref("aski_connector.view_aski_connect_code").id,
            "target": "new",
        }
