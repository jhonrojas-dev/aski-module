/** @odoo-module **/
import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { browser } from "@web/core/browser/browser";
import { useService } from "@web/core/utils/hooks";
import { AskiChatWidget } from "../chat/aski_chat";

const STORAGE_KEY = "aski_connector.bubble_state";

function loadBubbleState() {
    try {
        const raw = browser.localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return { open: !!parsed.open, minimized: !!parsed.minimized };
    } catch (e) {
        return { open: false, minimized: false };
    }
}

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
        this.orm = useService("orm");
        // Recuerda si el usuario la dejo abierta/minimizada — al recargar la
        // pantalla (F5) antes se perdia y volvia a cerrarse siempre.
        // `canUse` decide si la burbuja se muestra: solo a los miembros del
        // grupo del chat (el chat lee via la conexion compartida del admin, asi
        // que no debe estar al alcance de todo usuario interno). Arranca en
        // false para NO parpadear la burbuja antes de resolver el permiso.
        this.state = useState({ ...loadBubbleState(), canUse: false });
        onWillStart(async () => {
            try {
                this.state.canUse = await this.orm.call(
                    "aski.account.link", "can_use_chat", []);
            } catch (e) {
                this.state.canUse = false;
            }
        });
    }

    _persist() {
        browser.localStorage.setItem(STORAGE_KEY, JSON.stringify({
            open: this.state.open, minimized: this.state.minimized,
        }));
    }

    toggle() {
        if (this.state.open) {
            this.state.open = false;
            this.state.minimized = false;
        } else {
            this.state.open = true;
            this.state.minimized = false;
        }
        this._persist();
    }

    minimize() {
        this.state.minimized = !this.state.minimized;
        this._persist();
    }

    close() {
        this.state.open = false;
        this.state.minimized = false;
        this._persist();
    }
}

registry.category("systray").add(
    "aski_connector.systray", { Component: AskiSystray }, { sequence: 1 });
