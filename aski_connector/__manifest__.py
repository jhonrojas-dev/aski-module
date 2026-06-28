# -*- coding: utf-8 -*-
{
    "name": "Aski - AI assistant: ask your Odoo in natural language (chat & voice)",
    # OJO: el primer par (14.0/15.0/.../19.0) define la serie de Odoo en la
    # tienda. build_releases.py lo estampa por serie automaticamente.
    "version": "1.0.0",
    "category": "Productivity",
    "summary": "AI assistant to ask your Odoo in natural language: sales, "
               "receivables, reports - by chat or voice. Connect by scanning a QR. Free.",
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

* Works with Odoo Community and Enterprise (14 to 19).
* Generates a standard Odoo API key for your user (you can revoke it anytime in
  Settings > Users > API Keys).
* No data leaves your Odoo through this module: it only shows you the connection
  code. The Aski app connects directly to your Odoo via the standard external API.

Aski is an AI assistant and chatbot for Odoo: ask your ERP in natural language
and get instant answers and mobile reports - sales, receivables, top products,
inactive customers, cash flow - by chat or voice. A simpler alternative to
building dashboards or BI reports for everyday questions.

Keywords: AI, assistant, chatbot, natural language, ask Odoo, mobile reports,
business intelligence, BI, dashboards, voice, analytics, conversational, ERP.

Get the app and learn more at https://aski.dev
""",
    "author": "Aski",
    "website": "https://aski.dev",
    "license": "LGPL-3",
    "support": "jhon@aski.dev",
    "depends": ["base"],
    "data": [
        "security/ir.model.access.csv",
        "views/aski_connect_views.xml",
    ],
    "images": ["static/description/banner.png"],
    "installable": True,
    "application": True,
}
