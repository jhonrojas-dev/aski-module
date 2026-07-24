# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError


class AskiChatConnectWizard(models.TransientModel):
    """Pega el Personal Access Token (generado una vez en app.aski.dev >
    Settings > Personal access tokens) para activar el chat embebido. Registra
    esta base Odoo como una credential mas de esa cuenta Aski (reusa la misma
    API key + helpers que el QR de la app movil, via aski.key.mixin)."""

    _name = "aski.chat.connect.wizard"
    _description = "Connect Aski chat"
    _inherit = ["aski.key.mixin"]

    pat = fields.Char(string="Aski personal access token")
    # El nombre con el que esta conexion aparece en la lista de conexiones de
    # Aski (app movil / web). Antes iba HARDCODEADO como "Odoo (in-app chat)":
    # el usuario no podia distinguir dos instancias de Odoo entre si y el texto
    # era largo de mas en el selector del celular. Por defecto = nombre de la
    # compania (generico: sirva a cualquier instancia, sin inventar etiquetas).
    name = fields.Char(
        string="Connection name",
        default=lambda self: self.env.company.name,
        help="How this Odoo will appear in your Aski connections list.")
    # Si la cuenta que YA esta conectada la gestiona un socio, no se muestran los
    # enlaces de precios/compra (su plan lo ve con el socio). En una PRIMERA
    # conexion aun no se sabe -> se muestran, que es lo util para darse de alta.
    partner_managed = fields.Boolean(
        default=lambda self: self._default_partner_managed())

    @api.model
    def _default_partner_managed(self):
        link = self.env["aski.account.link"]._active_link(self.env.user)
        return bool(link) and link.partner_managed

    def action_connect(self):
        self.ensure_one()
        pat = (self.pat or "").strip()
        if not pat:
            raise UserError(_("Paste your Aski personal access token."))

        # A que conexion se pega el token depende del modo (configurado por el
        # admin en Chat Settings):
        #  - modos compartidos: el registro GLOBAL, y SOLO un admin lo configura.
        #  - por usuario: el registro del PROPIO usuario (cada quien el suyo).
        Link = self.env["aski.account.link"]
        user = self.env.user
        if Link._current_mode() == "per_user":
            if not Link._user_can_use_chat(user):
                raise AccessError(_("You can't use the Aski chat. Ask an "
                                    "administrator for access."))
            link = Link._get_user_link(user, create=True).sudo()
        else:
            if not user.has_group("base.group_system"):
                raise AccessError(_("Only administrators can set up the shared "
                                    "Aski connection."))
            link = Link._get_global().sudo()
        link.write({"pat": pat})

        ok, message = link._sync_wallet()
        if not ok:
            raise UserError(message)

        base_url = self.env["ir.config_parameter"].sudo().get_param("web.base.url") or ""
        dbname = self.env.cr.dbname
        # El nombre de la API KEY de Odoo se mantiene fijo ("Aski Chat") a
        # proposito: la rotacion (revocar la anterior antes de crear la nueva)
        # busca por ese nombre. Lo que el usuario elige es el nombre de la
        # CONEXION del lado de Aski, que es el que se ve en el celular.
        self._aski_revoke_previous("Aski Chat")
        api_key = self._aski_generate_api_key("Aski Chat")
        nickname = (self.name or "").strip() or self.env.company.name or dbname
        ok, message = link._register_credential(
            nickname=nickname, url=base_url, db=dbname,
            login=user.login, api_key=api_key,
        )
        if not ok:
            raise UserError(message)

        # Carga de pagina COMPLETA que ademas ATERRIZA EN EL CHAT.
        #
        # Hace falta que sea completa: devolver solo la accion del chat re-monta
        # la pantalla completa, pero la burbuja del systray sigue montada y
        # conservaria en su estado la conversacion/creditos de la cuenta ANTERIOR
        # (se veia el historial de otra cuenta tras pegar un token nuevo).
        #
        # Pero un `{"tag": "reload"}` a secas recarga la URL ACTUAL, que puede ser
        # la del PROPIO WIZARD -> tras conectar se reabria el MISMO dialogo y
        # parecia que no habia pasado nada (reportado en Odoo 14, donde el boton
        # "Connect my Aski account" del chat navega por hash a la accion del
        # wizard porque esa serie no tiene servicio `action`).
        #
        # Un act_url con target=self fuerza la carga completa Y deja al usuario en
        # el chat. Ojo: en 14-17 el chat vive en /web#action=<id> y cambiar SOLO
        # el hash NO recarga la pagina -> se anade un parametro de query que la
        # obliga.
        from odoo import release
        chat = self.env.ref("aski_connector.action_aski_chat")
        if release.version_info[0] >= 18:
            url = "/odoo/action-%s" % chat.id
        else:
            url = "/web?aski_connected=1#action=%s" % chat.id
        return {"type": "ir.actions.act_url", "url": url, "target": "self"}
