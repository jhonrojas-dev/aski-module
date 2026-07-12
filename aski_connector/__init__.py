from . import models

# El post_init_hook se ELIMINO (2026-07-12).
#
# Hacia esto:
#     if release.version_info[0] < 16:
#         env.ref("aski_connector.menu_aski_chat").active = False
# es decir, OCULTABA el menu "Chat" en Odoo 14 y 15, partiendo de que el widget
# OWL no podia cargar en esas series. Esa premisa YA NO ES CIERTA: el chat corre
# en 14-19 (14 = OWL 1.4 sobre el web client legacy; 15 = OWL 1.4 sobre wowl;
# 16-19 = OWL 2). Con el hook puesto, un usuario de 14/15 instalaba el modulo y
# NO VEIA el chat por ningun lado.
#
# Para que las instalaciones que ya quedaron con el menu oculto lo recuperen al
# actualizar, views/aski_chat_views.xml fuerza `active=True` sobre ese menu (un
# post_init_hook no bastaria: solo corre al INSTALAR, no al actualizar).
