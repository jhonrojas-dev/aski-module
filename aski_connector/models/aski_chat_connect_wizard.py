# -*- coding: utf-8 -*-
import requests

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

from .aski_common import aski_api_base

_TIMEOUT = 30


class AskiChatConnectWizard(models.TransientModel):
    """Activa el chat embebido, por cualquiera de las dos vias:

    - `signup`: crea la cuenta Aski SIN salir de Odoo (un solo POST a
      /auth/connector-signup, que da de alta y devuelve el token). Es el camino
      por defecto porque quien instala el modulo casi nunca tiene cuenta aun, y
      mandarlo a la web a registrarse y volver con un token copiado era el punto
      donde se caia el alta.
    - `token`: pega un Personal Access Token ya existente (app.aski.dev >
      Settings > Personal access tokens), para quien ya es usuario.

    En ambos casos termina igual: registra esta base Odoo como una credential mas
    de esa cuenta Aski (misma API key + helpers que el QR de la app, via
    aski.key.mixin). La cuenta creada aqui NO es de un tipo distinto: sirve igual
    en la app, la web y Odoo, con el mismo monedero.
    """

    _name = "aski.chat.connect.wizard"
    _description = "Connect Aski chat"
    _inherit = ["aski.key.mixin"]

    mode = fields.Selection(
        selection=[("signup", "Create my Aski account"),
                   ("token", "I already have an account")],
        string="How do you want to connect?", default="signup", required=True)

    # --- Alta inline (mode = signup) ---------------------------------------
    signup_email = fields.Char(
        string="Email", default=lambda self: self.env.user.email,
        help="Your Aski account will be created with this email. You can use it "
             "afterwards in the Aski mobile app and on the web, with the same "
             "credits.")
    signup_password = fields.Char(string="Password")
    signup_password_confirm = fields.Char(string="Repeat password")
    # Opcional: si este Odoo lo instalo un socio (reseller), su codigo afilia la
    # cuenta nueva a ese socio, igual que al registrarse desde la app o la web.
    signup_partner_code = fields.Char(string="Partner code (optional)")

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

    def _target_link(self):
        """La conexion a la que se pega el token, segun el modo de acceso que
        configuro el admin en Chat Settings:
          - modos compartidos: el registro GLOBAL, y SOLO un admin lo configura.
          - por usuario: el registro del PROPIO usuario (cada quien el suyo).
        Es la MISMA barrera para las dos vias (alta y token pegado): darse de
        alta desde aqui no puede saltarse el permiso de configurar la conexion.
        """
        Link = self.env["aski.account.link"]
        user = self.env.user
        if Link._current_mode() == "per_user":
            if not Link._user_can_use_chat(user):
                raise AccessError(_("You can't use the Aski chat. Ask an "
                                    "administrator for access."))
            return Link._get_user_link(user, create=True).sudo()
        if not user.has_group("base.group_system"):
            raise AccessError(_("Only administrators can set up the shared "
                                "Aski connection."))
        return Link._get_global().sudo()

    def action_create_account(self):
        """Crea la cuenta Aski y conecta este Odoo, sin salir de aqui."""
        self.ensure_one()
        email = (self.signup_email or "").strip()
        password = self.signup_password or ""
        if not email:
            raise UserError(_("Enter the email for your new Aski account."))
        if "@" not in email or " " in email:
            raise UserError(_("That email doesn't look valid."))
        if len(password) < 8:
            raise UserError(_("Choose a password with at least 8 characters."))
        if password != (self.signup_password_confirm or ""):
            raise UserError(_("The two passwords don't match."))

        # Se valida el permiso ANTES de crear nada afuera: si este usuario no
        # puede configurar la conexion, crear la cuenta remota lo dejaria con un
        # registro huerfano en Aski y un error aqui.
        link = self._target_link()

        nickname = (self.name or "").strip() or self.env.company.name or self.env.cr.dbname
        base_url = self.env["ir.config_parameter"].sudo().get_param("web.base.url") or ""
        body = {
            "email": email,
            "password": password,
            "token_name": nickname,
            "instance": base_url,
        }
        if (self.signup_partner_code or "").strip():
            body["partner_code"] = self.signup_partner_code.strip()
        try:
            resp = requests.post(aski_api_base(self.env) + "/auth/connector-signup",
                                 json=body, timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(_("Could not reach Aski: %s") % e)
        if resp.status_code == 409:
            # Ya tiene cuenta: se le dice exactamente que hacer en vez de
            # devolverle un error crudo.
            raise UserError(_(
                "There's already an Aski account with that email. Pick "
                "\"I already have an account\" above and paste a personal "
                "access token from app.aski.dev > Settings > Personal access "
                "tokens."))
        if resp.status_code == 429:
            raise UserError(_("Too many attempts. Wait a minute and try again."))
        if resp.status_code not in (200, 201):
            raise UserError(_("Could not create the account: %s")
                            % self.env["aski.account.link"]._error_message(resp))
        token = (resp.json() or {}).get("token") or ""
        if not token:
            raise UserError(_("Aski didn't return an access token. Try again."))

        # A partir de aqui la cuenta YA existe del lado de Aski. Si el cierre de
        # la conexion falla (blip de red al verificar o al registrar esta base),
        # Odoo revierte la transaccion y el token se pierde — pero la cuenta NO
        # se deshace. Sin este aviso el usuario quedaba atrapado: al reintentar
        # le saldria "ese correo ya tiene cuenta" sin saber por que ni con que
        # token seguir. Se le dice exactamente como continuar.
        try:
            return self._finish_connection(link, token, nickname)
        except UserError as e:
            raise UserError(_(
                "Your Aski account was created (%(email)s), but connecting this "
                "Odoo failed: %(reason)s\n\n"
                "Your account is fine — nothing was charged and you don't need "
                "to sign up again. To finish: sign in at app.aski.dev with that "
                "email and the password you just chose, generate a personal "
                "access token under Settings, then come back here and pick "
                "\"I already have an account\".",
            ) % {"email": email, "reason": e.args[0] if e.args else ""})

    def action_connect(self):
        self.ensure_one()
        pat = (self.pat or "").strip()
        if not pat:
            raise UserError(_("Paste your Aski personal access token."))
        link = self._target_link()
        nickname = (self.name or "").strip() or self.env.company.name or self.env.cr.dbname
        return self._finish_connection(link, pat, nickname)

    def _finish_connection(self, link, pat, nickname):
        """Cierre COMPARTIDO por las dos vias: guarda el token, verifica contra
        Aski, rota la API key de Odoo, registra esta base como conexion y
        aterriza en el chat. Vive en un solo sitio para que el alta inline no se
        quede atras cuando cambie algo de la conexion."""
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
        ok, message = link._register_credential(
            nickname=nickname, url=base_url, db=dbname,
            login=self.env.user.login, api_key=api_key,
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
