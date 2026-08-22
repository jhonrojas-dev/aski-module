# -*- coding: utf-8 -*-
import requests

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError

from .aski_common import (
    aski_api_base,
    aski_cobrand_html_current,
    aski_is_private_url,
    aski_partner_code,
    aski_url_candidates,
)

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
                   ("login", "I already have an account"),
                   ("token", "Paste an access token")],
        string="How do you want to connect?", default="signup", required=True)

    # Se deja normalmente VACIO: la direccion se deduce sola (ver
    # aski_url_candidates). Existe para la instalacion en la que ninguna
    # candidata sirve — Odoo sin modo proxy detras de un reverse proxy, o
    # `web.base.url` con el default tras restaurar una base. Sin este campo, ese
    # cliente se quedaba sin forma de conectar desde Odoo.
    #
    # Siempre visible en vez de aparecer solo al fallar: el modulo evita `attrs`
    # para que el MISMO XML sirva de Odoo 14 a 19, y un campo condicional obliga
    # a escribir la vista dos veces.
    public_url = fields.Char(
        string="Address of this Odoo (optional)",
        help="Leave it empty and Aski will detect it. Fill it in only if Aski "
             "can't reach this Odoo: type the same address you use to open it "
             "from outside your office, for example https://odoo.mycompany.com")

    # --- Alta inline (mode = signup) ---------------------------------------
    signup_email = fields.Char(
        string="Email", default=lambda self: self.env.user.email,
        help="Your Aski account will be created with this email. You can use it "
             "afterwards in the Aski mobile app and on the web, with the same "
             "credits.")
    signup_password = fields.Char(string="Password")
    signup_password_confirm = fields.Char(string="Repeat password")
    # Si este Odoo lo instalo un socio (reseller), su codigo afilia la cuenta
    # nueva a ese socio, igual que al registrarse desde la app o la web.
    #
    # Normalmente es CONFIGURACION DE LA INSTANCIA: lo deja puesto el socio al
    # instalar (odoo.conf o el parametro `aski_connector.partner_code`). En ese
    # caso el campo NI SE MUESTRA (ver la vista): el cliente no puede cambiarlo,
    # no le sirve verlo, y la co-marca ya le dice quien le da el servicio. Solo
    # aparece, editable, cuando NO hay ninguno configurado, por si su socio le
    # dio uno de palabra.
    signup_partner_code = fields.Char(
        string="Partner code (optional)",
        default=lambda self: aski_partner_code(self.env) or False,
        help="Only if an Aski partner gave you one. If the partner set up this "
             "instance, it is already configured and you don't have to type it.")

    # Verdadero si el codigo YA viene de la configuracion de la instancia. Es
    # una bandera aparte y no `signup_partner_code` a secas porque el campo se
    # oculta con ella: si dependiera del propio valor, se escondería solo en
    # cuanto el cliente escribiera la primera letra.
    has_configured_code = fields.Boolean(
        default=lambda self: bool(aski_partner_code(self.env)))

    # --- Cuenta existente por correo+clave (mode = login) ------------------
    # Existe para el cliente al que su SOCIO le creo la cuenta: antes tenia que
    # salir a la web, entrar, generar un token a mano y volver a pegarlo. Aqui el
    # modulo hace por dentro ese mismo canje.
    login_email = fields.Char(
        string="Aski email", default=lambda self: self.env.user.email)
    login_password = fields.Char(string="Aski password")

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

    # Lockup "Aski x <socio>". Con la cuenta ya conectada sale de los datos que
    # trae /billing/me; en FRIO (dandose de alta, sin sesion) se resuelve por el
    # codigo que el socio dejo configurado en la instancia. Vacio = no hay socio
    # que presentar y no se pinta nada.
    # Por DEFAULT, no computado: ver la nota en aski.account.link.cobrand_html
    # (un Html computado no almacenado no llega al cliente en Odoo 16).
    cobrand_html = fields.Html(
        readonly=True, sanitize=False,
        default=lambda self: aski_cobrand_html_current(self.env))

    @api.model
    def _default_partner_managed(self):
        link = self.env["aski.account.link"]._active_link(self.env.user)
        return bool(link) and link.partner_managed

    def _aski_url_help(self, url_probada, message):
        """Mensaje de fallo que dice QUE hacer, no solo que fallo.

        Si lo que no sirvio es la direccion, el usuario no tiene por que saber
        que existe `web.base.url`: se le pide la direccion con la que el mismo
        entra a Odoo, en el campo que tiene delante.
        """
        if not aski_is_private_url(url_probada) and "://" in (url_probada or ""):
            return message
        return _(
            "Aski queries your Odoo from the internet and could not reach it at "
            "%(url)s, which is an address of your internal network.\n\n"
            "Type the address you use to open Odoo from outside your office "
            "(for example https://odoo.mycompany.com) in the field \"Address of "
            "this Odoo\" below, then connect again.\n\n%(detail)s"
        ) % {"url": url_probada or "-", "detail": message or ""}

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
        # La afiliacion sale del PARAMETRO, no del campo del formulario: el campo
        # es de solo lectura y el cliente no puede introducir un codigo a mano.
        # Leerlo aqui tambien evita depender de que el cliente web devuelva un
        # campo readonly al crear el registro.
        code = ((aski_partner_code(self.env) or self.signup_partner_code) or "").strip()
        if code:
            body["partner_code"] = code
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
                "\"I already have an account\" above and sign in with its "
                "password — no need to leave Odoo."))
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
            return self._finish_connection(link, token, nickname, email=email)
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

    def action_login_connect(self):
        """Conecta con la cuenta que ya existe, usando correo y contrasena."""
        self.ensure_one()
        email = (self.login_email or "").strip()
        password = self.login_password or ""
        if not email or "@" not in email:
            raise UserError(_("Enter the email of your Aski account."))
        if not password:
            raise UserError(_("Enter the password of your Aski account."))

        # El permiso se valida ANTES de mandar credenciales a ningun sitio.
        link = self._target_link()
        nickname = (self.name or "").strip() or self.env.company.name or self.env.cr.dbname
        try:
            resp = requests.post(
                aski_api_base(self.env) + "/auth/connector-token",
                json={"email": email, "password": password, "token_name": nickname},
                timeout=_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            raise UserError(_("Could not reach Aski: %s") % e)
        if resp.status_code == 401:
            raise UserError(_("Wrong email or password. If you just got the account "
                              "from your Aski partner, use the temporary password "
                              "they gave you."))
        if resp.status_code == 403:
            # Cuenta creada con Google (no tiene clave local) o deshabilitada: el
            # backend ya manda el texto accionable.
            raise UserError(self.env["aski.account.link"]._error_message(resp))
        if resp.status_code == 429:
            raise UserError(_("Too many attempts. Wait a minute and try again."))
        if resp.status_code not in (200, 201):
            raise UserError(_("Could not connect: %s")
                            % self.env["aski.account.link"]._error_message(resp))
        token = (resp.json() or {}).get("token") or ""
        if not token:
            raise UserError(_("Aski didn't return an access token. Try again."))
        return self._finish_connection(link, token, nickname, email=email)

    def action_connect(self):
        self.ensure_one()
        pat = (self.pat or "").strip()
        if not pat:
            raise UserError(_("Paste your Aski personal access token."))
        link = self._target_link()
        nickname = (self.name or "").strip() or self.env.company.name or self.env.cr.dbname
        return self._finish_connection(link, pat, nickname)

    def _finish_connection(self, link, pat, nickname, email=""):
        """Cierre COMPARTIDO por las dos vias: guarda el token, verifica contra
        Aski, rota la API key de Odoo, registra esta base como conexion y
        aterriza en el chat. Vive en un solo sitio para que el alta inline no se
        quede atras cuando cambie algo de la conexion.

        `email` es el correo de la cuenta Aski cuando lo sabemos de primera mano
        (el usuario lo acaba de teclear para darse de alta o iniciar sesion). Se
        guarda para poder DECIR con que cuenta esta hablando este Odoo: en modo
        'por usuario' cada quien conecta la suya y, sin este dato, no habia forma
        de saber cual quedo conectada. Por la via de pegar un token suelto no se
        conoce aqui — lo rellena `_sync_wallet` si el backend lo reporta.
        """
        vals = {"pat": pat}
        if email:
            vals["email"] = email
        link.write(vals)

        ok, message = link._sync_wallet()
        if not ok:
            raise UserError(message)

        # La direccion NO la teclea el cliente: se deduce (peticion en curso ->
        # web.base.url -> lo que el haya escrito abajo). Ver aski_url_candidates.
        urls = aski_url_candidates(self.env, self.public_url)
        dbname = self.env.cr.dbname
        # El nombre de la API KEY de Odoo se mantiene fijo ("Aski Chat") a
        # proposito: la rotacion (revocar la anterior antes de crear la nueva)
        # busca por ese nombre. Lo que el usuario elige es el nombre de la
        # CONEXION del lado de Aski, que es el que se ve en el celular.
        self._aski_revoke_previous("Aski Chat")
        api_key = self._aski_generate_api_key("Aski Chat")
        ok, message, url_usada = link._register_credential_any(
            nickname=nickname, urls=urls, db=dbname,
            login=self.env.user.login, api_key=api_key,
        )
        if not ok:
            raise UserError(self._aski_url_help(url_usada, message))

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
