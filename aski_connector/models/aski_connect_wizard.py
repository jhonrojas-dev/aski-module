# -*- coding: utf-8 -*-
import base64
import io
import json
import logging

from odoo import _, fields, models, release

_logger = logging.getLogger(__name__)


class AskiConnectWizard(models.TransientModel):
    """Genera un codigo de conexion (QR + token) para enlazar este Odoo con la
    app Aski en 1 paso, sin que el usuario teclee URL/db/API key a mano.

    El token empaqueta: base_url, db, login y una API key de Odoo recien
    generada para el usuario actual (modelo estandar res.users.apikeys, 14+).
    La app Aski lo escanea y se conecta por el API externo estandar (XML-RPC).
    Compatible Odoo 14 a 19 (sin `attrs`, sin res.config.settings, para que el
    mismo codigo sirva en todas las series).
    """

    _name = "aski.connect.wizard"
    _description = "Aski connection assistant"

    token = fields.Char(string="Connection code", readonly=True)
    qr_image = fields.Binary(string="QR code", readonly=True)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _aski_generate_api_key(self, name):
        """Genera una API key de Odoo para el usuario actual (scope 'rpc').

        La firma de `_generate` cambia entre series (Odoo 17+ agrego
        expiration_date). Se prueba de forma defensiva.
        """
        api_keys = self.env["res.users.apikeys"]
        major = release.version_info[0]
        try:
            if major >= 17:
                # 17+: _generate(scope, name, expiration_date) -> False = sin caducidad
                return api_keys._generate("rpc", name, False)
            return api_keys._generate("rpc", name)
        except TypeError:
            # Fallback por si la firma difiere en algun parche
            try:
                return api_keys._generate("rpc", name)
            except TypeError:
                return api_keys._generate("rpc", name, False)

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
