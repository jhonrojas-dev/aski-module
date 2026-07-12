/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { AskiChatWidget } from "../chat/aski_chat";

// Burbuja flotante estilo Discuss/WhatsApp: un icono en la barra superior que
// abre el MISMO widget de chat (historial, tablas, export a PDF — todo
// reusado, cero duplicacion) en un panel flotante, sin salir de la pantalla
// actual. La pantalla completa "Aski > Chat" del menu sigue existiendo aparte
// para quien prefiera verla a pantalla completa.
export class AskiSystray extends Component {
    static template = "aski_connector.Systray";
    static props = ["*"];
    static components = { AskiChatWidget };

    setup() {
        this.state = useState({ open: false });
    }

    toggle() {
        this.state.open = !this.state.open;
    }
}

registry.category("systray").add(
    "aski_connector.systray", { Component: AskiSystray }, { sequence: 1 });
