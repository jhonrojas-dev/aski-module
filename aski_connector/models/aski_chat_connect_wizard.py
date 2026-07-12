# -*- coding: utf-8 -*-
from odoo import _, fields, models
from odoo.exceptions import UserError


class AskiChatConnectWizard(models.TransientModel):
    """Pega el Personal Access Token (generado una vez en app.aski.dev >
    Settings > Personal access tokens) para activar el chat embebido. Registra
    esta base Odoo como una credential mas de esa cuenta Aski (reusa la misma
    API key + helpers que el QR de la app movil, via aski.key.mixin)."""

    _name = "aski.chat.connect.wizard"
    _description = "Connect Aski chat"
    _inherit = ["aski.key.mixin"]

    pat = fields.Char(string="Aski personal access token")

    def action_connect(self):
        self.ensure_one()
        pat = (self.pat or "").strip()
        if not pat:
            raise UserError(_("Paste your Aski personal access token."))

        link = self.env["aski.account.link"].sudo()._get_or_create()
        link.write({"pat": pat})

        ok, message = link._sync_wallet()
        if not ok:
            raise UserError(message)

        user = self.env.user
        base_url = self.env["ir.config_parameter"].sudo().get_param("web.base.url") or ""
        dbname = self.env.cr.dbname
        self._aski_revoke_previous("Aski Chat")
        api_key = self._aski_generate_api_key("Aski Chat")
        ok, message = link._register_credential(
            nickname=_("Odoo (in-app chat)"), url=base_url, db=dbname,
            login=user.login, api_key=api_key,
        )
        if not ok:
            raise UserError(message)

        return {
            "type": "ir.actions.client",
            "tag": "aski_chat_widget",
            "name": _("Aski"),
        }
