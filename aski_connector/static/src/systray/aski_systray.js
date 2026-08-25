odoo.define("aski_connector.systray", function (require) {
"use strict";
// ---------------------------------------------------------------------------
// VARIANTE ODOO 14 — arranque LEGACY del chat.
// ---------------------------------------------------------------------------
// La 14 no tiene los registries de wowl, asi que el componente OWL (identico al
// de 15/16+) se monta con el puente `web.OwlCompatibility`:
//   * el item del systray  -> Widget legacy que hospeda al componente OWL,
//     registrado en `SystrayMenu.Items`;
//   * la pantalla completa -> `AbstractAction` que hospeda el mismo componente,
//     registrada en `core.action_registry` con el tag `aski_chat_widget` (el
//     mismo que usa el ir.actions.client del XML, comun a todas las series).
const core = require("web.core");
const rpc = require("web.rpc");
const Widget = require("web.Widget");
const SystrayMenu = require("web.SystrayMenu");
const AbstractAction = require("web.AbstractAction");
const { ComponentWrapper } = require("web.OwlCompatibility");
const { AskiChatWidget } = require("aski_connector.chat");
// Los DOS son el mismo codigo que en 15-19, solo que aqui se piden con
// `require` porque la 14 no tiene modulos ES.
const { canUseChat } = require("aski_connector.access");
const { onOpenRequest } = require("aski_connector.record");
const { Component } = owl;
const { useState, onWillStart, onWillUnmount } = owl.hooks;

const STORAGE_KEY = "aski_connector.bubble_state";

function loadBubbleState() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return { open: !!parsed.open, minimized: !!parsed.minimized };
    } catch (e) {
        return { open: false, minimized: false };
    }
}

// Burbuja flotante estilo Discuss/WhatsApp: un icono en la barra superior que
// abre el MISMO widget de chat (historial, tablas, export a PDF — todo reusado,
// cero duplicacion) en un panel flotante, sin salir de la pantalla actual.
class AskiSystray extends Component {
    setup() {
        // Recuerda si el usuario la dejo abierta/minimizada — al recargar la
        // pantalla (F5) antes se perdia y volvia a cerrarse siempre.
        // `canUse` decide si la burbuja se muestra: depende del MODO de acceso
        // (compartida al grupo / solo admin / por usuario). Arranca en false
        // para NO parpadear la burbuja antes de resolver el permiso.
        this.state = useState({ ...loadBubbleState(), canUse: false });
        onWillStart(async () => {
            // La 14 no tiene los servicios de wowl (no hay useService/orm):
            // `rpc.query()` es el equivalente legacy de `orm.call()`. Y va
            // memoizado y COMPARTIDO con el boton del chatter: entre los dos
            // hacen UNA llamada por pestana, no una cada uno. `canUseChat` ya
            // traga sus propios errores, por eso aqui no hace falta try/catch.
            this.state.canUse = await canUseChat(() => rpc.query({
                model: "aski.account.link",
                method: "can_use_chat",
                args: [],
            }));
        });
        // El boton "Aski" de una ficha pide abrir la burbuja. Se desmarca al
        // desmontar: sin la baja, cada recarga del systray dejaria un oyente
        // muerto que sigue tocando el estado de un componente que ya no existe.
        onWillUnmount(onOpenRequest(() => {
            this.state.open = true;
            this.state.minimized = false;
            this._persist();
        }));
        // OWL 1: en las plantillas `this` NO es el componente, asi que las props
        // callback se pasan YA atadas desde aqui.
        this.onMinimize = () => this.minimize();
        this.onClose = () => this.close();
    }

    _persist() {
        // Con el almacenamiento bloqueado (ventana privada, politica del
        // navegador, cuota llena) `setItem` LANZA. Como se llama desde los
        // handlers de abrir/minimizar/cerrar, esa excepcion se llevaba por
        // delante el clic entero: la burbuja no abria. Recordar el estado es un
        // extra; que el chat funcione, no.
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
                open: this.state.open, minimized: this.state.minimized,
            }));
        } catch (e) {
            // Sin memoria entre recargas, pero el chat sigue usable.
        }
    }

    toggle() {
        this.state.open = !this.state.open;
        this.state.minimized = false;
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
AskiSystray.template = "aski_connector.Systray";
AskiSystray.components = { AskiChatWidget };

// ---- item del systray: Widget legacy que hospeda el componente OWL ----
const AskiSystrayItem = Widget.extend({
    tagName: "li",
    className: "o_dropdown",
    start: function () {
        this.component = new ComponentWrapper(this, AskiSystray, {});
        return this.component.mount(this.el).then(this._super.bind(this));
    },
});
SystrayMenu.Items.push(AskiSystrayItem);

// ---- pantalla completa: AbstractAction que hospeda el MISMO componente ----
const AskiChatAction = AbstractAction.extend({
    hasControlPanel: false,
    start: function () {
        this.$el.addClass("o_aski_chat_action");
        // El AbstractAction de la 14 ya renderiza un `.o_content` (su area de
        // contenido). Montando con `mount(this.el)` el componente quedaba
        // COLGADO AL LADO de ese div, no dentro: el `.o_content` vacio se comia
        // 600px y el chat aparecia a media pantalla, con el header flotando en
        // el aire. Se monta DENTRO de `.o_content` (y si no existiera, en el
        // propio elemento, sin romperse).
        const target = this.el.querySelector(".o_content") || this.el;
        this.component = new ComponentWrapper(this, AskiChatWidget, {});
        return this.component.mount(target).then(this._super.bind(this));
    },
});
core.action_registry.add("aski_chat_widget", AskiChatAction);

return { AskiSystray: AskiSystray, AskiSystrayItem: AskiSystrayItem };
});
