# -*- coding: utf-8 -*-
{
    "name": "Aski - AI assistant: ask your Odoo in natural language (chat & voice)",
    # OJO: el primer par (14.0/15.0/.../19.0) define la serie de Odoo en la
    # tienda. build_releases.py lo estampa por serie automaticamente.
    # OJO al bumpear: la version debe ser MONOTONICA en CADA rama de serie, y
    # las ramas iban desincronizadas (16/17/18 en 1.1.0 pero 19.0 en 1.4.10).
    # Por eso se unifico todo en 1.5.0: es mayor que la mas alta publicada, asi
    # que ninguna serie ve un downgrade. Mantenerlas iguales de aqui en adelante.
    "version": "15.0.1.6.0",
    "category": "Productivity",
    "summary": "AI assistant to ask your Odoo in natural language: sales, "
               "receivables, reports - by chat or voice, from your phone or "
               "right inside Odoo. Read-only & safe. Free.",
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

* Read-only by design: Aski only reads and reports - it never creates, edits or
  deletes records in your Odoo.
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
    "author": "Jhon Jairo Rojas Ortiz",
    "website": "https://aski.dev",
    "license": "LGPL-3",
    "support": "jhon@aski.dev",
    "depends": ["base", "web"],
    "data": [
        "security/ir.model.access.csv",
        "views/aski_connect_views.xml",
        "views/aski_chat_views.xml",
    ],
    # ODOO 15: las plantillas OWL van en el bundle `web.assets_qweb`, SEPARADO
    # del JS/SCSS (en 16+ todo va junto en assets_backend). Si se dejan en
    # assets_backend, el XML no se registra y el widget no encuentra su template.
    "assets": {
        "web.assets_backend": [
            "aski_connector/static/src/chat/*.js",
            "aski_connector/static/src/chat/*.scss",
            "aski_connector/static/src/systray/*.js",
            "aski_connector/static/src/systray/*.scss",
        ],
        "web.assets_qweb": [
            "aski_connector/static/src/chat/*.xml",
            "aski_connector/static/src/systray/*.xml",
        ],
    },
    "post_init_hook": "post_init_hook",
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
    ],
    "installable": True,
    "application": True,
}
