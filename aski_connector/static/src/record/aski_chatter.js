odoo.define("aski_connector.chatter", function (require) {
"use strict";
// ---------------------------------------------------------------------------
// El boton "Aski" DENTRO del chatter — VARIANTE ODOO 14 (la mas legacy).
// ---------------------------------------------------------------------------
// La logica compartida (`aski_connector.record` / `aski_connector.access`) es la
// MISMA que en las otras cinco ramas. Aqui solo vive lo que la 14 hace distinto,
// que es casi todo el envoltorio:
//
//   * **Sin modulos ES**: `import`/`export` no existen y el loader descarta el
//     fichero EN SILENCIO. Todo va por `odoo.define` / `require`.
//   * **Sin `@web/core/utils/patch`**: ese ayudante llego despues. Se extiende el
//     prototipo a mano con `Object.assign` y se envuelve `willStart`, que OWL 1
//     ESPERA antes del primer render — asi el permiso ya esta resuelto cuando se
//     decide si pintar el boton, y este no aparece de golpe medio segundo tarde.
//   * **Sin servicios de wowl**: no hay `useService("orm")`; el equivalente es
//     `rpc.query()`, igual que en el systray de esta misma rama.
//   * **El chatter es el modelo de "messaging" viejo**: se llega a el con
//     `this.env.models['mail.chatter'].get(this.props.chatterLocalId)`, y el hilo
//     esta en `chatter.thread` con `.model` y `.id`.

const rpc = require("web.rpc");
const ChatterTopbar = require("mail/static/src/components/chatter_topbar/chatter_topbar.js");
const { canUseChat } = require("aski_connector.access");
const { setRecord, clearRecordIf, requestOpen } = require("aski_connector.record");

const proto = ChatterTopbar.prototype;

// `willStart` se espera ANTES del primer render (OWL 1), asi que el permiso esta
// resuelto cuando la plantilla pregunta por `askiVisible`.
const _willStart = proto.willStart;
proto.willStart = async function () {
    if (_willStart) {
        await _willStart.call(this);
    }
    this.askiCanUse = await canUseChat(() => rpc.query({
        model: "aski.account.link",
        method: "can_use_chat",
        args: [],
    }));
};

// El usuario se fue de la ficha: el ambito deja de valer. Se compara CUAL es
// antes de borrar, por si otro chatter ya fijo el suyo.
const _willUnmount = proto.willUnmount;
proto.willUnmount = function () {
    const t = this._askiThread();
    if (t) {
        clearRecordIf(t.model, t.id);
    }
    if (_willUnmount) {
        return _willUnmount.call(this);
    }
};

Object.assign(proto, {
    /** El hilo de esta ficha, o null. Defensivo: el chatter se monta antes de
     *  tener `thread` resuelto y acceder a ciegas revienta el render. */
    _askiThread: function () {
        const modelos = this.env && this.env.models;
        const ch = modelos && modelos["mail.chatter"]
            ? modelos["mail.chatter"].get(this.props.chatterLocalId)
            : null;
        const th = ch && ch.thread;
        return th && th.model && th.id ? { model: th.model, id: th.id } : null;
    },

    /** Fija esta ficha como ambito y abre el panel de Aski. */
    _onClickAski: function () {
        const t = this._askiThread();
        if (!t) {
            return;
        }
        setRecord(t.model, t.id, "");
        requestOpen();
        rpc.query({ model: t.model, method: "read", args: [[t.id], ["display_name"]] })
            .then(function (filas) {
                if (filas && filas.length && filas[0].display_name) {
                    setRecord(t.model, t.id, filas[0].display_name);
                }
            })
            .guardedCatch(function () {
                // Sin nombre bonito el chip ensena el modelo y el id. El backend
                // resuelve el registro igual: solo el rotulo queda mas pobre.
            });
    },
});

// `askiVisible` como getter del prototipo: la plantilla lo lee sin parentesis,
// igual que `chatter.hasActivities`.
Object.defineProperty(proto, "askiVisible", {
    get: function () {
        return !!this.askiCanUse && !!this._askiThread();
    },
    configurable: true,
});

return ChatterTopbar;
});
