from . import models


def post_init_hook(*args):
    """El widget de chat es OWL real: no puede mantener el mismo codigo-unico
    14-19 que el QR (que deliberadamente no usa JS). Se declara Chat como
    Odoo 16+; en 14/15 el modulo instala igual y el QR sigue intacto, pero el
    menu Chat se oculta (en vez de fallar al cargar un template OWL que esas
    series no soportan).

    La firma de post_init_hook cambio entre series (cr, registry) en <=16 vs
    (env) en 17+ — aceptamos ambas formas sin asumir cual llega."""
    from odoo import release
    if len(args) == 1:
        env = args[0]
    else:
        from odoo import api
        env = api.Environment(args[0], api.SUPERUSER_ID, {})
    if release.version_info[0] < 16:
        menu = env.ref("aski_connector.menu_aski_chat", raise_if_not_found=False)
        if menu:
            menu.active = False
