# -*- coding: utf-8 -*-
import base64
import hashlib
import io
import json
import logging

from odoo import api, models, release
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
        """Genera una API key de Odoo para el usuario actual (scope 'rpc').
        La firma de `_generate` cambia entre series (Odoo 17+ agrego
        expiration_date). Se prueba de forma defensiva."""
        api_keys = self.env["res.users.apikeys"]
        major = release.version_info[0]
        try:
            if major >= 17:
                return api_keys._generate("rpc", name, False)
            return api_keys._generate("rpc", name)
        except TypeError:
            try:
                return api_keys._generate("rpc", name)
            except TypeError:
                return api_keys._generate("rpc", name, False)

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
