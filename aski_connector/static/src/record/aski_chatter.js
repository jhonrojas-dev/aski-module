/** @odoo-module **/
// ---------------------------------------------------------------------------
// El boton "Aski" DENTRO del chatter — VARIANTE ODOO 17.
// ---------------------------------------------------------------------------
// Preguntar estando parado en una ficha ("¿por que esta atrasada?") sin tener que
// reescribir de que documento se habla. El boton fija el registro abierto y abre
// el panel de chat de siempre, ya acotado a el.
//
// Por que un patch del componente y no un componente propio montado a mano: el
// `Chatter` ya recibe `props.threadModel` / `props.threadId` y los mantiene al dia
// cuando el usuario salta de registro (su `onWillUpdateProps`). Montar por fuera
// obligaria a espiar el router, que cambia de formato en cada serie.
//
// ⛔ Lo unico que cambia entre ramas es la RUTA del import del Chatter y el nombre
// de su plantilla. La logica vive en `aski_record.js` / `aski_access.js`, que son
// identicos en las seis.

import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { Chatter } from "@mail/core/web/chatter";
import { useState, onWillStart, onWillUnmount } from "@odoo/owl";
import { canUseChat } from "@aski_connector/record/aski_access";
import { setRecord, clearRecordIf, requestOpen } from "@aski_connector/record/aski_record";

patch(Chatter.prototype, {
    setup() {
        super.setup(...arguments);
        this.askiOrm = useService("orm");
        // Arranca oculto y aparece cuando se resuelve el permiso: al reves se
        // veria un boton que, al pulsarlo, abre un panel que el usuario no puede
        // usar. La comprobacion esta memoizada (una por pestana, no una por
        // ficha), asi que esto no cuesta un RPC en cada formulario.
        this.askiState = useState({ canUse: false });
        onWillStart(async () => {
            this.askiState.canUse = await canUseChat(() =>
                this.askiOrm.call("aski.account.link", "can_use_chat", [])
            );
        });
        onWillUnmount(() => {
            // El usuario se fue de la ficha: el ambito deja de valer. Se compara
            // CUAL es antes de borrar — si ya se monto otro chatter que fijo el
            // suyo, este desmontaje no debe llevarselo por delante.
            clearRecordIf(this.props.threadModel, this.props.threadId);
        });
    },

    /** Fija esta ficha como ambito y abre el panel de Aski. */
    async askiAsk() {
        const model = this.props.threadModel;
        const resId = this.props.threadId;
        if (!model || !resId) {
            return; // registro nuevo sin guardar: no hay nada que preguntar
        }
        // Nombre para el chip. Se pone YA lo que el chatter tenga a mano para que
        // el chip no aparezca vacio y luego se rellene: el parpadeo se lee como un
        // fallo. El `display_name` de verdad se pide despues y lo afina.
        const provisional = (this.state.thread && this.state.thread.name) || "";
        setRecord(model, resId, provisional);
        requestOpen();
        try {
            const filas = await this.askiOrm.read(model, [resId], ["display_name"]);
            if (filas && filas.length && filas[0].display_name) {
                setRecord(model, resId, filas[0].display_name);
            }
        } catch (e) {
            // Sin nombre bonito el chip ensena el provisional (o el modelo y el
            // id). El backend resuelve el registro por su cuenta: la respuesta
            // sale igual de bien, solo el rotulo queda mas pobre.
        }
    },
});
