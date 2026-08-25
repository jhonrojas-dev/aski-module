/** @odoo-module **/
// ---------------------------------------------------------------------------
// El boton "Aski" DENTRO del chatter — VARIANTE ODOO 16.
// ---------------------------------------------------------------------------
// Misma idea que en 17/18/19 y MISMA logica compartida (`aski_record.js` /
// `aski_access.js`, identicos byte a byte en las seis ramas). Lo que cambia aqui
// es todo lo que la 16 hace distinto, y no es poco:
//
//   * El chatter aun es el modelo de "messaging" viejo: no hay un componente
//     `Chatter` con props, sino `ChatterTopbar`, que recibe UN `record` y llega
//     al hilo por `chatterTopbar.chatter.thread` (con `.model` y `.id`).
//   * `patch` lleva TRES argumentos —`patch(obj, nombre, valor)`— y el original
//     se llama con `this._super(...)`. Desde la 17 es `patch(obj, valor)` y
//     `super.metodo()`. Copiar la forma de la 17 aqui no da error de sintaxis:
//     lanza en tiempo de ejecucion al montar el chatter, que es peor.
//
// El resto (permiso memoizado, limpiar el ambito al salir de la ficha, pedir el
// `display_name` para el chip) es igual, porque vive fuera de este fichero.

import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { ChatterTopbar } from "@mail/components/chatter_topbar/chatter_topbar";
import { useState, onWillStart, onWillUnmount } from "@odoo/owl";
import { canUseChat } from "@aski_connector/record/aski_access";
import { setRecord, clearRecordIf, requestOpen } from "@aski_connector/record/aski_record";

patch(ChatterTopbar.prototype, "aski_connector.ChatterTopbar", {
    setup() {
        this._super(...arguments);
        this.askiOrm = useService("orm");
        this.askiState = useState({ canUse: false });
        onWillStart(async () => {
            this.askiState.canUse = await canUseChat(() =>
                this.askiOrm.call("aski.account.link", "can_use_chat", [])
            );
        });
        onWillUnmount(() => {
            const t = this._askiThread();
            if (t) {
                clearRecordIf(t.model, t.id);
            }
        });
    },

    /** El hilo de esta ficha, o null. Defensivo: en la 16 el chatter se monta
     *  antes de tener `thread` resuelto y acceder a ciegas revienta el render. */
    _askiThread() {
        const ct = this.chatterTopbar;
        const ch = ct && ct.chatter;
        const th = ch && ch.thread;
        return th && th.model && th.id ? { model: th.model, id: th.id } : null;
    },

    /** True si se puede ensenar el boton (permiso + hilo con id de verdad). */
    get askiVisible() {
        return this.askiState.canUse && !!this._askiThread();
    },

    /** Fija esta ficha como ambito y abre el panel de Aski. */
    async askiAsk() {
        const t = this._askiThread();
        if (!t) {
            return;
        }
        setRecord(t.model, t.id, "");
        requestOpen();
        try {
            const filas = await this.askiOrm.read(t.model, [t.id], ["display_name"]);
            if (filas && filas.length && filas[0].display_name) {
                setRecord(t.model, t.id, filas[0].display_name);
            }
        } catch (e) {
            // Sin nombre bonito el chip ensena el modelo y el id. El backend
            // resuelve el registro igual: solo el rotulo queda mas pobre.
        }
    },
});
