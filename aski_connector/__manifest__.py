# -*- coding: utf-8 -*-
{
    "name": "AI Assistant for Odoo | Free AI Agent & Chatbot | Ask Your Data in Natural Language | Voice Queries, Sales & Receivables",
    "live_test_url": "https://demo.aski.dev/demo",
    # OJO: el primer par (14.0/15.0/.../19.0) define la serie de Odoo en la
    # tienda. build_releases.py lo estampa por serie automaticamente.
    # OJO al bumpear: la version debe ser MONOTONICA en CADA rama de serie, y
    # las ramas iban desincronizadas (16/17/18 en 1.1.0 pero 19.0 en 1.4.10).
    # Por eso se unifico todo en 1.5.0: es mayor que la mas alta publicada, asi
    # que ninguna serie ve un downgrade. Mantenerlas iguales de aqui en adelante.
    "version": "17.0.1.22.0",
    "category": "Productivity",
    "summary": "AI assistant to ask your Odoo in natural language: sales, "
               "receivables, reports - by chat or voice, from your phone or "
               "right inside Odoo. Read-only by default. Free.",
    "description": """
Aski - Ask your ERP in natural language
=======================================

Aski lets you ask your Odoo questions in plain language and get real figures in
seconds: sales, receivables, top products, inactive customers and more - from
your phone, even by voice.

This lightweight connector removes the manual setup: install it, click
**Connect with Aski**, and a one-time code (QR) is generated. Open the Aski app,
scan the code, and your phone is securely linked to this Odoo - no need to type
URLs, databases or API keys by hand.

New: chat with Aski right inside Odoo - paste a personal access token
generated once in the Aski web app, and a chat panel appears under Aski > Chat.
Same account, same wallet as the mobile app - just another way to ask.

* Read-only by default: Aski reads and reports. It does not create, edit or
  delete anything in your Odoo unless you switch on **actions with confirmation**
  - a top-plan capability limited to a closed list of four operations (payment
  reminder, follow-up activity, approve or reject a document). Even then nothing
  runs until you are shown what will happen, on which record, and you confirm.
* Works with Odoo Community and Enterprise (14 to 19) - BOTH the in-Odoo chat
  and the QR connector for the mobile app work on EVERY version, 14 included.
* Generates a standard Odoo API key for your user (you can revoke it anytime in
  Settings > Users > API Keys).
* No data leaves your Odoo through this module beyond what you ask Aski: the
  chat panel talks directly to the Aski backend using your own personal access
  token, the same way the mobile app does.
* Also run SAP? Aski works with SAP too - handy if you or your business partners
  use both Odoo and SAP.

Aski is an AI assistant and chatbot for Odoo: ask your ERP in natural language
and get instant answers and mobile reports - sales, receivables, top products,
inactive customers, cash flow - by chat or voice. A simpler alternative to
building dashboards or BI reports for everyday questions.

Keywords: AI, assistant, chatbot, natural language, ask Odoo, mobile reports,
business intelligence, BI, dashboards, voice, analytics, conversational, ERP,
embedded chat, in-app chat, chat widget, floating chat bubble, export PDF.

Get the app and learn more at https://aski.dev
""",
    "author": "Aski",
    "website": "https://aski.dev",
    "license": "LGPL-3",
    "support": "soporte@aski.dev",
    # `mail` es necesario para el boton de Aski DENTRO del chatter: la plantilla
    # `mail.Chatter` se hereda con `t-inherit`, y un `t-inherit` sobre una
    # plantilla que no existe rompe el bundle entero de assets (pantalla en
    # blanco), no solo el boton. No hay forma de heredar "solo si esta instalado".
    #
    # No se saco a un modulo aparte a proposito: serian DOS fichas que publicar y
    # mantener en las seis series para ahorrar una dependencia que, en la practica,
    # ya esta puesta en cualquier Odoo real (`sale`, `account`, `crm` y `project`
    # dependen de `mail`). El coste de mantener el parche paralelo es mayor que el
    # de la dependencia.
    "depends": ["base", "web", "mail"],
    "data": [
        "security/aski_security.xml",
        "security/ir.model.access.csv",
        "views/aski_connect_views.xml",
        "views/aski_chat_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "aski_connector/static/src/chat/**/*",
            "aski_connector/static/src/systray/**/*",
            # El boton del chatter y el estado del registro abierto.
            "aski_connector/static/src/record/**/*",
            # ⛔ El remove va DESPUES del glob: las operaciones se aplican en
            # ORDEN, asi que ponerlo antes no quitaba nada (aun no estaba) y el
            # glob lo volvia a meter -> la paleta oscura pisaba la clara siempre.
            ("remove", "aski_connector/static/src/chat/aski_chat.dark.scss"),
        ],
        # Odoo 19 no marca el modo oscuro con una clase: cambia el BUNDLE
        # (cookie color_scheme=dark). Como assets_backend entra en los dos, aqui
        # solo hace falta redefinir las variables del chat.
        "web.assets_web_dark": [
            "aski_connector/static/src/chat/aski_chat.dark.scss",
        ],
    },
    "images": [
        "static/description/banner.png",
        "static/description/shot-1.png",
        "static/description/shot-2.png",
        "static/description/shot-3.png",
        "static/description/shot-4.png",
        "static/description/shot-5.png",
        "static/description/shot-6.png",
        "static/description/shot-7.png",
        "static/description/shot-8.png",
        "static/description/shot-9.png",
        "static/description/shot-10.png",
        "static/description/shot-11.png",
        "static/description/shot-12.png",
    ],
    "installable": True,
    "application": True,
}
