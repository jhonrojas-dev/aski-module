/** @odoo-module **/
// ---------------------------------------------------------------------------
// El boton "Aski" DENTRO del chatter — VARIANTE ODOO 15 (OWL 1).
// ---------------------------------------------------------------------------
// La logica compartida (`aski_record.js` / `aski_access.js`) es la MISMA que en
// las otras cinco ramas, byte a byte. Aqui solo vive lo que la 15 hace distinto,
// que son cuatro cosas y ninguna es cosmetica:
//
//   * **OWL 1.4**: no existe el modulo `@odoo/owl` (llego con OWL 2 en la 16).
//     OWL vive en el global `owl` y los hooks cuelgan de `owl.hooks`.
//   * **`patch` de TRES argumentos** —`patch(obj, nombre, valor)`— y el original
//     se llama con `this._super(...)`. Desde la 17 es `patch(obj, valor)` +
//     `super.metodo()`; copiar aquella forma aqui no da error de sintaxis, lanza
//     al montar el chatter.
//   * **El chatter es el modelo de "messaging" viejo**: `ChatterTopbar` expone
//     `this.chatter` (en la 16 es `this.chatterTopbar.chatter`), y el hilo esta
//     en `chatter.thread` con `.model` y `.id`.
//   * En la plantilla se accede a `chatter` DIRECTO, sin prefijo.

import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { ChatterTopbar } from "@mail/components/chatter_topbar/chatter_topbar";
import { canUseChat } from "@aski_connector/record/aski_access";
import { setRecord, clearRecordIf, requestOpen } from "@aski_connector/record/aski_record";

const { useState, onWillStart, onWillUnmount } = owl.hooks;

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
        // OWL 1: en la plantilla `this` NO es el componente, asi que el manejador
        // se deja YA atado aqui y el t-on-click solo lo nombra.
        this.askiAsk = this.askiAsk.bind(this);
    },

    /** El hilo de esta ficha, o null. Defensivo: el chatter se monta antes de
     *  tener `thread` resuelto y acceder a ciegas revienta el render. */
    _askiThread() {
        const ch = this.chatter;
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
