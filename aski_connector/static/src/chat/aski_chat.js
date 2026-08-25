odoo.define("aski_connector.chat", function (require) {
"use strict";
// ---------------------------------------------------------------------------
// VARIANTE ODOO 14 (rama 14.0) — OWL 1.4 sobre el web client LEGACY.
// ---------------------------------------------------------------------------
// La 14 NO tiene modulos ES (`import`/`export` no existen: el loader reporta 0
// modulos ES) ni los registries de wowl (@web/core/*). Lo que SI tiene:
//   * OWL **1.4.11** (el mismo que la 15).
//   * `web.OwlCompatibility` (ComponentWrapper) para montar un componente OWL
//     dentro de un widget legacy.
//   * `web.SystrayMenu`, `web.AbstractAction`, `core.action_registry`, `web.rpc`.
// Por eso el COMPONENTE de abajo es IDENTICO al de la 15: lo unico que cambia es
// el andamiaje (este odoo.define) y unos shims para los 3 servicios de wowl que
// aqui no existen (orm / action / notification). Asi el chat no se bifurca en 3
// implementaciones distintas: 1 componente, 2 arranques.
// Aplican tambien las reglas de OWL 1 (ver la rama 15.0): sin markup() -> t-raw,
// y sin arrow functions en t-on-* -> llamada a metodo.
const core = require("web.core");
const rpc = require("web.rpc");
// El ambito del registro abierto: MISMO codigo que en 15-19, pedido con
// `require` porque en esta serie no hay modulos ES.
const { getRecord, clearRecord, subscribe } = require("aski_connector.record");
const _t = core._t;
const { Component } = owl;
const { useState, useRef, onWillStart, onWillUnmount, onMounted } = owl.hooks;
// Margen para que el aviso de "cuenta desconectada" se alcance a leer antes de
// que la recarga completa se lo lleve por delante.
const DISCONNECT_RELOAD_DELAY_MS = 1200;

// Tope de caracteres de una pregunta. Es el MISMO que valida el backend: por
// encima responde un 422 cuyo detalle es una lista de errores de campo, que en
// la burbuja se leia como un volcado de JSON. Se corta aqui, con el texto aun
// en el composer.
const MAX_PROMPT = 4000;

// Alto maximo del composer antes de hacer scroll dentro de el (unas 5 lineas).
const COMPOSER_MAX_PX = 132;

// Markdown -> HTML minimo (bold, italic, code, listas, tablas GFM, blockquote,
// links). Misma cobertura que web/src/chat/MarkdownMessage.tsx (react-markdown
// + remark-gfm) y MISMAS clases CSS (.md, .md-table-wrap) para que Odoo se vea
// igual que la web/app — no se reinventa el formato, solo el motor (OWL no
// puede montar un componente React).
function _escapeHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Los links del markdown NO son texto de confianza: el backend narra sobre datos
// del Odoo del cliente, asi que el nombre de un producto o de un contacto acaba
// dentro de la respuesta. Interpolar la URL cruda en el href abria dos puertas
// que `_escapeHtml` no cierra (solo toca &, < y >):
//   [x](javascript:...)      -> link ejecutable EN EL DOMINIO del propio Odoo.
//   [x](a" onmouseover="...) -> la comilla cierra el atributo y cuelga un handler.
// La web no lo sufre porque react-markdown transforma la URL por su cuenta; aqui
// hay que hacerlo a mano.
const _ESQUEMAS_OK = ["http:", "https:", "mailto:", "tel:"];

function _escapeAttr(s) {
    // El texto ya paso por _escapeHtml (&, <, >). Falta lo que rompe un atributo.
    return (s || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _safeUrl(u) {
    const raw = (u || "").trim();
    if (!raw) {
        return "";
    }
    // Un `<` o `>` aqui dentro no puede venir del texto original (ya paso
    // por _escapeHtml): solo lo mete el propio renderizador al unir un
    // parrafo con <br/>, o sea que la "URL" venia partida en dos lineas.
    // Pintarla dejaria markup dentro del href; mejor conservar el texto.
    if (raw.indexOf("<") !== -1 || raw.indexOf(">") !== -1) {
        return "";
    }
    // Empieza por / # o ?: es relativa a este Odoo, no puede ejecutar nada.
    if (/^[/#?]/.test(raw)) {
        return _escapeAttr(raw);
    }
    // Para DECIDIR el esquema se miran los caracteres visibles: el navegador
    // ignora tabuladores y saltos dentro del esquema, asi que "java\tscript:"
    // le vale y a una regex ingenua no. La URL que se devuelve es la original.
    const limpio = raw.replace(/[\u0000-\u0020]/g, "");
    const esquema = limpio.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/);
    if (!esquema) {
        // Sin esquema y sin barra ("aski.dev/precios"): se asume https, que es
        // lo que el usuario espera — dejarlo crudo lo resolveria contra Odoo.
        return _escapeAttr("https://" + raw);
    }
    if (_ESQUEMAS_OK.indexOf(esquema[0].toLowerCase()) === -1) {
        return "";  // javascript:, data:, vbscript:, file:... -> no se pinta link
    }
    return _escapeAttr(raw);
}

function _inline(s) {
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a || b}</strong>`);
    s = s.replace(/\*([^*]+)\*/g, (_m, a) => `<em>${a}</em>`);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => {
        const href = _safeUrl(u);
        // Esquema no permitido: se conserva el TEXTO (la frase sigue leyendose)
        // y se tira el enlace. Mejor que borrar la linea entera.
        return href
            ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`
            : t;
    });
    return s;
}
function _isTableStart(lines, idx) {
    return lines[idx].includes("|") && lines[idx + 1] !== undefined
        && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[idx + 1]);
}
function mdToHtml(text) {
    const lines = _escapeHtml(text).split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        if (/^```/.test(line)) {
            i++;
            const buf = [];
            while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++;
            out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
            continue;
        }
        const h = line.match(/^(#{1,3})\s+(.*)/);
        if (h) { out.push(`<h${h[1].length}>${_inline(h[2])}</h${h[1].length}>`); i++; continue; }
        if (_isTableStart(lines, i)) {
            const split = (l) => l.split("|").map((c) => c.trim()).filter((c, idx, arr) => !((idx === 0 || idx === arr.length - 1) && c === ""));
            const head = split(line);
            let j = i + 2;
            const rows = [];
            while (j < lines.length && lines[j].includes("|")) { rows.push(split(lines[j])); j++; }
            let html = '<div class="md-table-wrap"><table><thead><tr>';
            for (const c of head) html += `<th>${_inline(c)}</th>`;
            html += "</tr></thead><tbody>";
            for (const r of rows) { html += "<tr>"; for (const c of r) html += `<td>${_inline(c)}</td>`; html += "</tr>"; }
            html += "</tbody></table></div>";
            out.push(html);
            i = j;
            continue;
        }
        // El texto ya paso por _escapeHtml, asi que ">" quedo como "&gt;" — el
        // detector de blockquote debe buscar "&gt;", no ">" (si no, la cita
        // se renderizaba literal, con el "&gt;" a la vista).
        if (/^&gt;\s?/.test(line)) {
            const buf = [];
            while (i < lines.length && /^&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
            out.push(`<blockquote>${_inline(buf.join(" "))}</blockquote>`);
            continue;
        }
        if (/^[-*]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, "")); i++; }
            out.push(`<ul>${items.map((it) => `<li>${_inline(it)}</li>`).join("")}</ul>`);
            continue;
        }
        if (/^\d+\.\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
            out.push(`<ol>${items.map((it) => `<li>${_inline(it)}</li>`).join("")}</ol>`);
            continue;
        }
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|[-*]\s|\d+\.\s|&gt;\s?|```)/.test(lines[i]) && !_isTableStart(lines, i)) {
            buf.push(lines[i]);
            i++;
        }
        out.push(`<p>${_inline(buf.join("<br/>"))}</p>`);
    }
    return out.join("");
}

// Imprime un HTML autonomo a PDF con el dialogo nativo del navegador. MISMA
// tecnica que web/src/lib/printHtml.ts (iframe oculto, sin bloqueo de
// pop-ups) — reusa el HTML que ya genera el backend para Android/web.
function printHtml(html) {
    const iframe = document.createElement("iframe");
    Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow && iframe.contentWindow.document;
    if (!doc) { iframe.remove(); return; }
    doc.open();
    doc.write(html);
    doc.close();
    const win = iframe.contentWindow;
    const doPrint = () => {
        try { win.focus(); win.print(); } finally { setTimeout(() => iframe.remove(), 1000); }
    };
    if (doc.readyState === "complete") setTimeout(doPrint, 350);
    else iframe.onload = () => setTimeout(doPrint, 350);
}

class AskiChatWidget extends Component {
    static template = "aski_connector.ChatWidget";
    static props = ["*"];

    setup() {
        // Shims de los 3 servicios de wowl, que en la 14 NO existen. El resto del
        // componente usa this.orm/this.action/this.notification sin enterarse.
        this.orm = {
            // web.rpc.query() es el equivalente legacy de orm.call(): mismo
            // endpoint (/web/dataset/call_kw), misma sesion.
            call: (model, method, args) => rpc.query(
                { model: model, method: method, args: args }
            ).catch((err) => {
                // En esta serie, CUALQUIER RPC fallido abre ademas el dialogo
                // "Odoo Error" del gestor de errores legacy, con su "copia el
                // error completo al portapapeles". El chat ya cuenta el fallo
                // con sus palabras y ofrece reintentar, asi que ese dialogo solo
                // asusta — y encima tapa la pantalla, dejando el boton de
                // reintentar debajo y sin poder pulsarse. Marcar el evento como
                // atendido es la forma que da la propia serie de decir "de este
                // error me encargo yo" (es lo que hace `guardedCatch`).
                if (err && err.event && typeof err.event.preventDefault === "function") {
                    err.event.preventDefault();
                }
                throw err;
            }),
        };
        this.action = {
            // En la 14 no hay servicio `action` accesible desde OWL. Se resuelve
            // el id real del xmlid y se navega por hash (el ActionManager legacy
            // lo abre igual, respetando target=new).
            doAction: async (xmlid) => {
                const parts = xmlid.split(".");
                const res = await rpc.query({
                    model: "ir.model.data", method: "check_object_reference", args: parts,
                });
                if (res && res[1]) {
                    window.location.hash = "#action=" + res[1];
                }
            },
        };
        this.notification = {
            // Sin servicio de notificaciones: el error se muestra como una burbuja
            // de error en el propio chat (mismo tratamiento que un envio fallido),
            // que ademas es mas visible que un toast.
            add: (msg) => {
                this.state.messages.push({
                    id: "e" + Date.now(), role: "error", text: msg, retryText: null,
                });
                this._scrollToBottom();
            },
        };
        this.messagesRef = useRef("messages");
        // El composer es un <textarea> NO controlado: atarlo al estado con un
        // atributo `value` reposiciona el cursor al final en cada tecla. Se lee
        // por el evento y se limpia por la referencia.
        this.composerRef = useRef("composer");
        // La plantilla solo ve el componente, no las constantes del modulo: el
        // maxlength del composer sale de aqui para no repetir el numero (y que
        // no se desincronice del guard de send()).
        this.MAX_PROMPT = MAX_PROMPT;
        this.state = useState({
            loading: true,
            allowed: true,
            mode: "shared_group",
            canConnect: false,
            connected: false,
            walletCredits: 0,
            planName: "",
            // Cuenta gestionada por un socio: se le ocultan los accesos a
            // comprar creditos (el backend rechaza esa compra; su saldo lo
            // repone su socio).
            partnerManaged: false,
            // El correo de la cuenta Aski conectada. Importa sobre todo en modo
            // "por usuario": sin esto no habia forma de saber CUAL de las cuentas
            // quedo conectada en este Odoo.
            email: "",
            messages: [],
            input: "",
            sending: false,
            conversationId: null,
            exporting: false,
            conversations: [],
            drawerOpen: false,
            // --- Grafico: el id del mensaje cuyo grafico esta abierto ---
            chartFor: null,
            // --- Compartir enlace (solo crear; administrarlos no) ---
            shareFor: null, shareUrl: "", shareExpires: "", shareDays: 7,
            shareBusy: false,
            // --- Los registros detras de la cifra ---
            recordsFor: null, records: null, recordsBusy: false,
            // --- Excel ---
            xlsxBusy: false,
            // --- Enviar por correo ---
            emailFor: null, emailTo: "", emailAttach: true, emailBusy: false,
            // --- Empezar de cero ---
            clearing: false,
            detailFor: null,
            // Motivo del 'dislike' (campo "¿Que estuvo mal?" del panel de
            // detalle). Vive en el estado del chat y NO en el mensaje porque
            // solo hay un panel abierto a la vez; se reinicia en _openDetail
            // para que lo escrito en una respuesta no reaparezca en la de al
            // lado.
            fbComment: "",
            // Lo que se PINTA dentro del textarea. Se fija al abrir el panel y
            // no se vuelve a tocar: si el contenido colgara de `fbComment`, OWL
            // reescribiria el texto en cada pulsacion y el cursor saltaria al
            // final al corregir algo en mitad de la frase.
            fbInitial: "",
            fbSending: false,
            fbSent: false,
            fbError: false,
            // Confirmacion IN-APP de desconectar (nunca window.confirm).
            confirmDisconnect: false,
            disconnecting: false,
            // El estado NO se pudo cargar (backend caido, sin red, RPC roto).
            // Es distinto de "no conectado": antes se pintaban igual y el chat
            // le pedia conectar su cuenta a quien YA la tenia conectada.
            loadError: "",
            // Analisis profundo: `agentEnabled` dice si el PLAN lo incluye,
            // `deepMode` si el usuario lo tiene encendido ahora.
            agentEnabled: false,
            deepMode: false,
            // Segundos que lleva esperando la respuesta en curso, y si esa
            // espera es de analisis profundo (que tarda mucho mas).
            elapsed: 0,
            sendingDeep: false,
            // Hilo pendiente de confirmar por ser una consulta pesada.
            pendingHeavy: null,
            // Renombrar/borrar un hilo desde el cajon, siempre in-app.
            renamingId: null,
            renameText: "",
            confirmDeleteId: null,
            // REGISTRO ABIERTO: la ficha del ERP desde la que se pregunta, puesta
            // por el boton "Aski" del chatter. `null` en la pantalla completa y
            // mientras el usuario no lo pida: el chat se comporta como siempre.
            record: null,
        });
        // El ambito lo manda un singleton de modulo (`record/aski_record.js`) y no
        // una prop, porque quien lo fija —el chatter— no es antepasado de este
        // componente: viven en dos arboles distintos del web client.
        this.state.record = getRecord().model ? getRecord() : null;
        const _bajaRecord = subscribe((r) => {
            this.state.record = r.model ? r : null;
        });
        onWillUnmount(_bajaRecord);
        onWillStart(async () => { await this.loadStatus(); });
        // ⛔ El chat abria por ARRIBA, ensenando el mensaje mas viejo del hilo.
        // Causa: `loadStatus` corre en `onWillStart` —antes del montaje— y su
        // `openConversation` llama a `_scrollToBottom`, que lee `messagesRef.el`.
        // Ese elemento AUN NO EXISTE, asi que el scroll se perdia en silencio.
        // Aqui el DOM ya esta, y `onWillStart` termino, asi que los mensajes
        // estan puestos: es el primer instante en el que se puede bajar de verdad.
        onMounted(() => this._scrollToBottom());
        // El chat se cierra (o se cambia de pantalla) con una respuesta en
        // vuelo: el cronometro seguiria latiendo sobre un componente que ya no
        // existe.
        onWillUnmount(() => this._stopClock());
        // Esc cierra la hoja de detalle, como cualquier dialogo de Odoo. Va en
        // el documento porque la hoja no tiene el foco por si sola, y se retira
        // al desmontar: el widget se monta DOS veces (pantalla completa y
        // burbuja del systray) y dejar el listener colgado haria que la hoja de
        // una cerrase por la otra.
        this._onEsc = (ev) => {
            if (ev.key === "Escape" && this.state.detailFor) {
                this.state.detailFor = null;
            }
        };
        document.addEventListener("keydown", this._onEsc);
        onWillUnmount(() => document.removeEventListener("keydown", this._onEsc));
    }

    async loadStatus() {
        this.state.loading = true;
        this.state.loadError = "";
        try {
            const st = await this.orm.call("aski.account.link", "get_status", []);
            // El estado depende del modo (compartida/solo-admin/por-usuario):
            //   allowed=false        -> no puede usar el chat (aviso).
            //   canConnect=true      -> puede pegar su token (admin o por-usuario).
            //   canConnect=false     -> no conectada; que la conecte el admin.
            this.state.mode = st.mode || "shared_group";
            this.state.canConnect = !!st.can_connect;
            this.state.allowed = st.allowed !== false;
            if (!this.state.allowed) {
                this.state.connected = false;
                return;
            }
            this.state.connected = !!st.connected;
            this.state.walletCredits = st.wallet_credits || 0;
            this.state.planName = st.plan_name || "";
            this.state.partnerManaged = !!st.partner_managed;
            this.state.email = st.email || "";
            this.state.agentEnabled = !!st.agent_enabled;
            if (!this.state.agentEnabled) {
                this.state.deepMode = false;  // el plan ya no lo incluye
            }
            if (this.state.connected) {
                await this.refreshConversations();
                // Restaura el hilo MAS RECIENTE al recargar la pantalla — sin esto
                // el chat parecia perder todo el historial en cada F5.
                const latest = this.state.conversations[0];
                if (latest) await this.openConversation(latest.id);
            }
        } catch (e) {
            // NO se toca `connected`: que el estado no se pueda leer no
            // significa que la cuenta este desconectada. Marcarla como tal
            // pintaba "Conecta Aski para empezar" a alguien que ya la tenia
            // conectada, y lo empujaba a reconectar sin motivo.
            // `navigator` directo y no `browser.navigator`: lo que expone el
            // envoltorio `browser` cambia entre series (14 a 19) y esto tiene
            // que funcionar en todas.
            const sinRed = typeof navigator !== "undefined" && navigator.onLine === false;
            this.state.loadError = sinRed
                ? _t("You appear to be offline. Check your connection and try again.")
                : this._msgDe(e);
        } finally {
            this.state.loading = false;
        }
    }

    async retryLoad() {
        await this.loadStatus();
    }

    /**
     * Quita el ambito: la × del chip.
     * No borra la conversacion ni lo ya respondido — a partir de aqui las
     * preguntas vuelven a ser sobre TODO el ERP, que es justo lo que el chip
     * dejaba de decir si no se pudiera quitar.
     */
    clearScope() {
        clearRecord();
    }

    async refreshConversations() {
        this.state.conversations = await this.orm.call("aski.account.link", "list_conversations", []);
    }

    async openConversation(conversationId) {
        this.state.drawerOpen = false;
        this.state.conversationId = conversationId;
        this.state.messages = await this.orm.call("aski.account.link", "load_conversation", [conversationId]);
        this._scrollToBottom();
    }

    newConversation() {
        this.state.drawerOpen = false;
        this.state.conversationId = null;
        this.state.messages = [];
    }

    // ------------------------------------------------------------------
    // Gestion de hilos desde el cajon (renombrar / borrar), como en la app.
    // Toda confirmacion es IN-APP: nada de window.confirm.
    // ------------------------------------------------------------------
    askRename(c) {
        this.state.confirmDeleteId = null;
        this.state.renamingId = c.id;
        this.state.renameText = c.title || "";
    }

    cancelRename() {
        this.state.renamingId = null;
        this.state.renameText = "";
    }

    onRenameInput(ev) {
        this.state.renameText = ev.target.value;
    }

    onRenameKeydown(ev) {
        if (ev.key === "Enter") {
            ev.preventDefault();
            this.doRename();
        } else if (ev.key === "Escape") {
            this.cancelRename();
        }
    }

    async doRename() {
        const id = this.state.renamingId;
        const titulo = (this.state.renameText || "").trim();
        if (!id || !titulo) {
            return;
        }
        try {
            await this.orm.call("aski.account.link", "rename_conversation", [id, titulo]);
            const c = this.state.conversations.find((x) => x.id === id);
            if (c) {
                c.title = titulo;
            }
            this.cancelRename();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        }
    }

    askDelete(c) {
        this.state.renamingId = null;
        this.state.confirmDeleteId = c.id;
    }

    cancelDelete() {
        this.state.confirmDeleteId = null;
    }

    async doDelete() {
        const id = this.state.confirmDeleteId;
        if (!id) {
            return;
        }
        try {
            await this.orm.call("aski.account.link", "delete_conversation", [id]);
            this.state.conversations = this.state.conversations.filter((x) => x.id !== id);
            this.state.confirmDeleteId = null;
            // Si el hilo borrado era el que estaba abierto, se limpia la
            // pantalla: dejar sus mensajes a la vista, con el hilo ya archivado,
            // haria creer que se sigue conversando ahi.
            if (this.state.conversationId === id) {
                this.state.conversationId = null;
                this.state.messages = [];
                this.state.detailFor = null;
            }
            this.notification.add(_t("Conversation removed."), { type: "success" });
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        }
    }

    // Mensaje legible de un error de RPC, sin repetir la misma cadena en cada
    // handler.
    // Nombre de la clase de la excepcion, que es lo que permite reaccionar a un
    // fallo CONCRETO sin leer el texto (que viaja traducido a seis idiomas).
    // Igual que con el mensaje, la ruta cambia segun la serie: en unas esta en
    // `e.data.name` y en otras un nivel mas adentro. Cuando no se encontraba, el
    // chat no ofrecia recargar creditos al quedarse sin saldo ni apagaba el
    // interruptor de analisis profundo (visto en la QA de la 14).
    _claseDe(e) {
        const cand = [
            e && e.data && e.data.name,
            e && e.message && e.message.data && e.message.data.name,
        ];
        for (const c of cand) {
            if (typeof c === "string" && c) {
                return c;
            }
        }
        return "";
    }

    _msgDe(e) {
        // El error llega con formas distintas segun la serie: en unas el texto
        // esta en `e.data.message`, en otras `e.message` ES OTRO OBJETO (con su
        // propio .data.message dentro). Sin comprobar que lo devuelto es TEXTO,
        // al usuario le salia un "[object Object]" como mensaje de error (visto
        // en la QA de la 14).
        const cand = [
            e && e.data && e.data.message,
            e && e.message && e.message.data && e.message.data.message,
            e && e.message,
            e && e.data && e.data.arguments && e.data.arguments[0],
        ];
        for (const c of cand) {
            if (typeof c === "string" && c.trim()) {
                return c;
            }
        }
        return _t("Something went wrong. Try again.");
    }

    toggleDrawer() {
        this.state.drawerOpen = !this.state.drawerOpen;
    }

    // Sugerencias del estado de bienvenida. Van AQUI (no como literales en el
    // t-on-click de la plantilla) porque antes la ETIQUETA se traducia pero el
    // texto que se ENVIABA era el literal ingles del handler: el usuario en
    // espanol veia "¿Cuanto vendi este mes?" y a Aski le llegaba "How much did
    // I sell this month?". Un solo string traducido = etiqueta y payload iguales.
    // _t() se evalua en cada render (getter), no al cargar el modulo, para que
    // las traducciones ya esten disponibles.
    get samples() {
        return [
            { icon: "fa-line-chart", text: _t("How much did I sell this month?") },
            { icon: "fa-trophy", text: _t("My top 10 customers") },
            { icon: "fa-clock-o", text: _t("Overdue invoices") },
            { icon: "fa-users", text: _t("How many customers do I have?") },
        ];
    }

    useSample(text) {
        this.state.input = text;
        this.send();
    }

    renderMd(text) {
        // OWL 1 no tiene markup(): se devuelve el HTML crudo y la
        // plantilla lo pinta con t-raw (en 16+ es markup() + t-out).
        return mdToHtml(text);
    }

    // OWL 1 no admite funciones flecha en `t-on-*`: cada handler necesita su
    // propio metodo.
    onHeaderClick() {
        if (this.props.minimized && this.props.onMinimize) {
            this.props.onMinimize();
        }
    }
    onMinimizeClick() {
        if (this.props.onMinimize) { this.props.onMinimize(); }
    }
    onCloseClick() {
        if (this.props.onClose) { this.props.onClose(); }
    }

    conversationTitle(c) {
        return c.title || _t("Untitled");
    }

    async exportPdf() {
        if (this.state.exporting || !this.state.conversationId) return;
        this.state.exporting = true;
        try {
            const tzOffset = -new Date().getTimezoneOffset();
            const r = await this.orm.call("aski.account.link", "export_answer_pdf",
                [this.state.conversationId, tzOffset]);
            printHtml(r.content_html);
        } catch (e) {
            const msg = this._msgDe(e);
            this.notification.add(msg, { type: "danger", sticky: true });
        } finally {
            this.state.exporting = false;
        }
    }

    // El mensaje cuya hoja de detalle esta abierta. La hoja se monta UNA vez al
    // final del chat (no dentro de cada burbuja), asi que necesita resolverlo.
    get detailMsg() {
        if (!this.state.detailFor) {
            return null;
        }
        return this.state.messages.find((x) => x.id === this.state.detailFor) || null;
    }

    closeDetail() {
        this.state.detailFor = null;
    }

    toggleDetail(m) {
        if (this.state.detailFor === m.id) {
            this.state.detailFor = null;
            return;
        }
        this._openDetail(m);
    }

    // Abre el detalle de UN mensaje dejando el campo de motivo en su sitio: con
    // lo que ese mensaje ya tenga escrito, y sin el acuse ni el error del
    // anterior. Sin este reinicio, el motivo tecleado en una respuesta aparecia
    // en la de al lado en cuanto se abria su panel.
    _openDetail(m) {
        this.state.detailFor = m.id;
        this.state.fbComment = m.feedbackComment || "";
        this.state.fbInitial = m.feedbackComment || "";
        this.state.fbSending = false;
        this.state.fbSent = false;
        this.state.fbError = false;
    }

    // Pulgar, tanto el de la burbuja como el grande del panel de detalle.
    //
    // Optimista y SILENCIOSO a proposito: valorar es un gesto de un toque, no
    // una tarea. Si el envio falla se revierte la marca y no se molesta con un
    // error — la respuesta sigue ahi y el usuario no ha perdido nada. (El motivo
    // escrito si avisa: ver sendFeedbackComment.)
    async setFeedback(m, value) {
        // Sin id del backend no hay a quien mandarle el voto: el mensaje aun no
        // se ha reconciliado con load_conversation. La plantilla ya oculta los
        // pulgares en ese caso; esto es la red por si se llama desde otro sitio.
        if (!m.backendId) {
            return;
        }
        const previous = m.feedback;
        const next = previous === value ? null : value;
        m.feedback = next; // optimista
        try {
            await this.orm.call("aski.account.link", "set_feedback", [m.backendId, next]);
            if (next === "dislike") {
                // Al marcar 👎 se abre el detalle: es donde se puede decir POR
                // QUE, lo unico que convierte un pulgar en algo accionable.
                this._openDetail(m);
            } else if (next === null) {
                // Quitar la valoracion se lleva su motivo — el backend tambien
                // lo borra, y un comentario huerfano se contaria como queja
                // vigente.
                m.feedbackComment = null;
                if (this.state.detailFor === m.id) {
                    this.state.fbComment = "";
                    this.state.fbSent = false;
                }
            }
        } catch (e) {
            // Revertir si el backend rechazo el cambio — pero SOLO si nadie ha
            // vuelto a pulsar mientras tanto: con dos clics seguidos, el fallo
            // del primero borraba el voto del segundo.
            if (m.feedback === next) {
                m.feedback = previous;
            }
        }
    }

    onFbCommentInput(ev) {
        this.state.fbComment = ev.target.value;
        // Volver a escribir retira el acuse y el error: si no, el "Gracias" se
        // queda colgado sobre un texto que ya cambio y parece guardado.
        this.state.fbSent = false;
        this.state.fbError = false;
    }

    // El motivo SI informa del resultado, al reves que el pulgar: escribir unas
    // lineas es una tarea, y perderla en silencio seria peor que no haberla
    // pedido.
    async sendFeedbackComment(m) {
        const texto = (this.state.fbComment || "").trim();
        if (this.state.fbSending || !texto) {
            return;
        }
        this.state.fbSending = true;
        this.state.fbError = false;
        try {
            await this.orm.call("aski.account.link", "set_feedback",
                [m.backendId, "dislike", texto]);
            m.feedbackComment = texto;
            this.state.fbSent = true;
        } catch (e) {
            // El texto NO se borra: se queda en el campo para reintentar.
            this.state.fbError = true;
        } finally {
            this.state.fbSending = false;
        }
    }

    // La hora de la burbuja, como en la app y en la web. El backend guarda
    // `created_at` en UTC pero SIN marca de zona ("2026-08-22T19:04:00"), y un
    // ISO sin offset lo interpreta `new Date()` como hora LOCAL: en Lima saldria
    // cinco horas adelantada. Se le pone la Z cuando no la trae, igual que hace
    // ChatRepository en la app (parseCreatedAtMillis).
    bubbleTime(iso) {
        if (!iso) {
            return "";
        }
        const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + "Z");
        if (isNaN(d.getTime())) {
            return "";
        }
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    async exportMessageDetail(m) {
        if (this.state.exporting) return;
        this.state.exporting = true;
        try {
            const tzOffset = -new Date().getTimezoneOffset();
            const r = await this.orm.call("aski.account.link", "export_message_pdf",
                [m.backendId, tzOffset]);
            printHtml(r.content_html);
        } catch (e) {
            const msg = this._msgDe(e);
            this.notification.add(msg, { type: "danger", sticky: true });
        } finally {
            this.state.exporting = false;
        }
    }

    openConnect() {
        this.action.doAction("aski_connector.action_aski_chat_connect");
    }

    askDisconnect() {
        this.state.confirmDisconnect = true;
    }

    cancelDisconnect() {
        this.state.confirmDisconnect = false;
    }

    async doDisconnect() {
        if (this.state.disconnecting) {
            return; // guarda contra doble tap
        }
        this.state.disconnecting = true;
        try {
            const r = await this.orm.call("aski.account.link", "disconnect_account", []);
            this.notification.add(r.message || _t("Aski account disconnected."),
                                  { type: "success" });
            // Corta el chat AQUI mismo (el historial pertenece a la cuenta recien
            // desvinculada, y sin esto el composer seguiria usable hasta la
            // recarga).
            this.state.confirmDisconnect = false;
            this.state.drawerOpen = false;
            this.state.connected = false;
            this.state.messages = [];
            this.state.conversations = [];
            this.state.conversationId = null;
            this.state.detailFor = null;
            // Y ademas RECARGA la pagina completa. Refrescar solo el estado de
            // ESTE widget no basta: el chat puede estar montado DOS veces a la
            // vez (pantalla completa del menu + burbuja del systray) y la otra
            // instancia se quedaria "conectada", con composer usable, dejando
            // mandar preguntas a una cuenta que ya no sirve. Mismo motivo por el
            // que action_connect fuerza una carga completa al conectar.
            // `disconnecting` NO se libera: mantiene el boton bloqueado hasta que
            // la pagina se va.
            window.setTimeout(() => window.location.reload(), DISCONNECT_RELOAD_DELAY_MS);
        } catch (e) {
            const msg = this._msgDe(e);
            this.notification.add(msg, { type: "danger", sticky: true });
            this.state.disconnecting = false;
        }
    }

    openBilling() {
        window.open("https://app.aski.dev/billing", "_blank", "noopener,noreferrer");
    }

    onInput(ev) {
        this.state.input = ev.target.value;
        this._autoGrow(ev.target);
    }

    // El composer crece con el texto hasta un tope y a partir de ahi hace
    // scroll: una pregunta de varias lineas se escribe entera sin taparle el
    // chat al usuario.
    _autoGrow(el) {
        if (!el) {
            return;
        }
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_PX) + "px";
    }

    _resetComposer() {
        this.state.input = "";
        const el = this.composerRef.el;
        if (el) {
            el.value = "";
            el.style.height = "auto";
        }
    }

    onKeydown(ev) {
        // Enter envia; Shift+Enter parte la linea. Antes esto era un <input>, en
        // el que Shift+Enter no puede insertar salto: la promesa del handler no
        // se cumplia y solo se podian hacer preguntas de una linea.
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            this.send();
        }
    }

    toggleDeepMode() {
        if (!this.state.agentEnabled) {
            return;
        }
        this.state.deepMode = !this.state.deepMode;
    }

    async send() {
        const text = (this.state.input || "").trim();
        if (!text || this.state.sending) {
            return; // guarda contra doble tap / doble envio
        }
        if (text.length > MAX_PROMPT) {
            // El backend rechaza por encima de este limite con un 422. Se avisa
            // AQUI, con el texto todavia en el composer, en vez de mandarlo para
            // que vuelva convertido en un error.
            // Sin argumentos en _t(): la 14 y la 15 no los admiten y este
            // fichero tiene que servir en las seis series.
            this.notification.add(
                _t("That question is too long. Make it shorter and ask again.")
                    + " (" + text.length + "/" + MAX_PROMPT + ")",
                { type: "warning" });
            return;
        }
        this._resetComposer();
        // El distintivo de "profundo" va en la PREGUNTA, no en la respuesta: es
        // donde lo guarda el backend (is_agent) y donde lo pintan la app y la
        // web. Asi sobrevive a la recarga del hilo y al historial.
        this.state.messages.push({
            id: `u${Date.now()}`, role: "user", text,
            deep: this.state.deepMode && this.state.agentEnabled,
            // La hora se pinta YA, sin esperar a la recarga del hilo: una
            // burbuja que aparece sin hora y la estrena un segundo despues da
            // un salto feo justo donde el usuario esta mirando.
            createdAt: new Date().toISOString(),
        });
        await this._ask(text);
    }

    async retry(errorMsg) {
        if (this.state.sending) {
            return;
        }
        // La burbuja de error se RETIRA antes de reintentar: dejarla apilaba un
        // error tras otro y el hilo acababa siendo una lista de fallos.
        const i = this.state.messages.indexOf(errorMsg);
        if (i !== -1) {
            this.state.messages.splice(i, 1);
        }
        await this._ask(errorMsg.retryText);
    }

    // El agente pidio confirmacion antes de una consulta pesada y el usuario
    // acepta: se repite la MISMA pregunta con el visto bueno.
    async confirmHeavy() {
        const text = this.state.pendingHeavy;
        if (!text || this.state.sending) {
            return;
        }
        await this._ask(text, { confirmHeavy: true });
    }

    cancelHeavy() {
        this.state.pendingHeavy = null;
    }

    // Cronometro de la espera. Una respuesta normal tarda segundos, pero el
    // analisis profundo puede irse a mas de un minuto: tres puntitos sin mas
    // hacen dudar de si la cosa sigue viva. No se inventan fases que el backend
    // no reporta — se enseña el tiempo real, que si es cierto.
    _startClock() {
        this._stopClock();
        this.state.elapsed = 0;
        this._clock = window.setInterval(() => {
            this.state.elapsed += 1;
        }, 1000);
    }

    _stopClock() {
        if (this._clock) {
            window.clearInterval(this._clock);
            this._clock = null;
        }
        this.state.elapsed = 0;
    }

    async _ask(text, opciones) {
        const confirmarPesada = !!(opciones && opciones.confirmHeavy);
        // El modo profundo solo se usa si el plan lo incluye: `agentEnabled` lo
        // dice el backend, y sin el la llamada volveria con un 403.
        const profundo = this.state.deepMode && this.state.agentEnabled;
        this.state.sending = true;
        this.state.pendingHeavy = null;
        this.state.sendingDeep = profundo;
        this._startClock();
        this._scrollToBottom();
        try {
            const isNewThread = !this.state.conversationId;
            // El ambito viaja en LOS DOS modos: el modo profundo se abre desde el
            // mismo boton del chatter, y una capacidad que solo tuviera uno de los
            // dos se lee como un fallo del otro.
            const rec = this.state.record;
            const recModel = rec ? rec.model : null;
            const recId = rec ? rec.resId : null;
            const r = profundo
                ? await this.orm.call("aski.account.link", "send_message_agent",
                    [text, this.state.conversationId, confirmarPesada, recModel, recId])
                : await this.orm.call("aski.account.link", "send_message",
                    [text, this.state.conversationId, recModel, recId]);
            if (r.conversation_id) {
                this.state.conversationId = r.conversation_id;
            }
            if (isNewThread) this.refreshConversations();
            this.state.messages.push({
                id: `a${Date.now()}`, role: "assistant", text: r.answer || "",
                credits: typeof r.credits === "number" ? r.credits : null,
                chart: r.chart || null,
                backendId: null, rows: null, feedback: null,
                feedbackComment: null, createdAt: new Date().toISOString(),
            });
            if (r.confirmation_required) {
                // El agente avisa de que la consulta es pesada y espera el visto
                // bueno. Se guarda la pregunta para poder repetirla tal cual.
                this.state.pendingHeavy = text;
            }
            if (typeof r.credits === "number") {
                this.state.walletCredits = Math.max(0, this.state.walletCredits - r.credits);
            }
            // Reconciliar con el backend: send_message no devuelve el id real
            // del mensaje assistant, pero el panel de detalle (creditos,
            // registros, like/dislike, exportar ESTE mensaje) lo necesita.
            // Recarga silenciosa -- mismo texto ya visible, solo completa metadata.
            if (this.state.conversationId) {
                try {
                    this.state.messages = await this.orm.call(
                        "aski.account.link", "load_conversation", [this.state.conversationId]);
                } catch (e2) { /* la burbuja optimista ya quedo visible, no molestar */ }
            }
        } catch (e) {
            const msg = this._msgDe(e);
            // "Recargar creditos" solo si el fallo SON los creditos: ante un ERP
            // caido ese boton manda a pagar por algo que no lo arregla. Se mira
            // la clase de la excepcion (Odoo la pone en data.name), no el texto,
            // que viene traducido.
            const clase = this._claseDe(e);
            const sinCreditos = clase.indexOf("AskiCreditsError") !== -1;
            // El plan no incluye el analisis profundo: se APAGA el interruptor
            // en vez de dejarlo encendido reintentando algo que siempre falla, y
            // se reintenta en modo normal, que si esta disponible.
            const sinAgente = clase.indexOf("AskiAgentNotInPlanError") !== -1;
            if (sinAgente) {
                this.state.deepMode = false;
                this.state.agentEnabled = false;
            }
            this.state.messages.push({ id: `e${Date.now()}`, role: "error", text: msg,
                                       retryText: text, sinCreditos, sinAgente });
        } finally {
            this.state.sending = false;
            this.state.sendingDeep = false;
            this._stopClock();
            this._scrollToBottom();
        }
    }

    // =====================================================================
    //  Grafico
    // =====================================================================
    // El grafico viaja DENTRO de la consulta guardada, asi que vale igual para
    // el turno recien mandado y para el historial. Se valida con las MISMAS
    // reglas que la app y la web: solo tres formas, y una serie necesita al
    // menos dos puntos (con uno no hay nada que comparar). Tolerante a
    // proposito: un grafico jamas puede tumbar el render de una respuesta que
    // ya se cobro.
    chartDe(m) {
        const c = m && m.chart;
        if (!c || typeof c !== "object") {
            return null;
        }
        if (["bar", "line", "donut"].indexOf(c.kind) === -1) {
            return null;
        }
        const series = (Array.isArray(c.series) ? c.series : []).filter(
            (s) => s && Array.isArray(s.points) && s.points.length >= 2);
        return series.length ? Object.assign({}, c, { series }) : null;
    }

    // ⛔ Estos tres textos se arman ENTEROS y no partidos en la plantilla.
    // "<t/> days" exportaba "days" a solas y "<t/> of <t/>" exportaba "of":
    // traducidos como fragmentos, el orden de las palabras queda mal en cuanto
    // el idioma no coloca el numero delante.
    // La caducidad, en fecha LOCAL y no el ISO crudo que manda el backend:
    // "2026-09-01T06:24:53.479855" no lo lee nadie.
    get caducidadFmt() {
        const iso = this.state.shareExpires;
        if (!iso) {
            return "";
        }
        const d = new Date(iso.endsWith("Z") || iso.indexOf("+") > 0 ? iso : iso + "Z");
        if (isNaN(d.getTime())) {
            return iso;   // si no se puede leer, se ensena tal cual: nunca vacio
        }
        return d.toLocaleDateString(undefined,
            { year: "numeric", month: "long", day: "numeric" });
    }

    plazoLabel(d) {
        return _t("%s days", d);
    }

    get conteoRegistros() {
        const r = this.state.records || {};
        return _t("%(shown)s of %(total)s", {
            shown: (r.rows || []).length, total: r.total });
    }

    get etiquetaConvertido() {
        return _t("converted");
    }

    openChart(m) {
        // Al abrir esto se CIERRA el panel de detalle de debajo: dejarlo
        // puesto apilaba dos capas y se veia como un descuido. Se cierra de
        // verdad (no se oculta), para que al salir de aqui no reaparezca solo.
        this.closeDetail();
        this.state.chartFor = m.id;
    }

    closeChart() {
        this.state.chartFor = null;
    }

    get chartAbierto() {
        const id = this.state.chartFor;
        if (!id) {
            return null;
        }
        const m = this.state.messages.find((x) => x.id === id);
        return m ? this.chartDe(m) : null;
    }

    // --- Barras -------------------------------------------------------------
    // "Otros" NO entra en la escala: agrupa cientos de entidades, asi que su
    // valor aplasta al resto y las barras reales quedan en una astilla, que es
    // justo lo que el grafico venia a dejar comparar. Se muestra su cifra, sin
    // barra que compita.
    barras(s, spec) {
        const tope = Math.max(...s.points.map((p) => Math.abs(p.value)), 1e-9);
        const filas = s.points.map((p) => ({
            label: p.label,
            valor: this.fmtCifra(p.value, s, spec),
            pct: Math.min(100, (Math.abs(p.value) / tope) * 100),
            otros: false,
        }));
        if (s.other) {
            filas.push({
                label: s.other.label,
                valor: this.fmtCifra(s.other.value, s, spec),
                pct: 0,
                otros: true,
            });
        }
        return filas;
    }

    // --- Linea --------------------------------------------------------------
    // El eje arranca en CERO salvo que haya negativos: un eje truncado exagera
    // las diferencias, que es el error que borra la confianza en las cifras.
    // Y forzar el piso a cero con negativos esconderia las caidas bajo cero.
    linea(s, spec) {
        const vals = s.points.map((p) => p.value);
        const max = Math.max(...vals);
        const min = Math.min(...vals, 0);
        const rango = Math.max(max - min, 1e-9);
        const W = 600;
        const H = 180;
        const paso = s.points.length > 1 ? W / (s.points.length - 1) : W;
        const y = (v) => H - ((v - min) / rango) * H;
        const d = s.points
            .map((p, i) => (i ? "L" : "M") + (paso * i).toFixed(1) + "," + y(p.value).toFixed(1))
            .join(" ");
        return {
            d, W, H,
            arriba: this.fmtCorto(max, s, spec),
            abajo: this.fmtCorto(min, s, spec),
            primero: s.points[0].label,
            ultimo: s.points[s.points.length - 1].label,
            guias: [0, 0.5, 1].map((f) => H * f),
        };
    }

    // --- Dona ---------------------------------------------------------------
    dona(s) {
        const total = s.points.reduce((a, p) => a + p.value, 0);
        if (total <= 0) {
            return null;
        }
        const R = 70;
        const C = 2 * Math.PI * R;
        let acum = 0;
        const trozos = s.points.map((p, i) => {
            const frac = p.value / total;
            const t = {
                clase: "s" + (i % 6),
                dash: (C * frac).toFixed(2) + " " + C.toFixed(2),
                offset: (-C * acum).toFixed(2),
                label: p.label,
                pct: Math.round(frac * 100),
            };
            acum += frac;
            return t;
        });
        return { R, G: 22, trozos };
    }

    // --- Pie del grafico ----------------------------------------------------
    // Sin total afirmable NO se inventa uno: se dice exactamente que se esta
    // viendo ("Top 10 de 240").
    pieGrafico(s, spec) {
        if (s.total === null || s.total === undefined) {
            if (s.partial_of !== null && s.partial_of !== undefined) {
                return _t("Top %(shown)s of %(total)s", {
                    shown: s.points.length, total: s.partial_of });
            }
            return "";
        }
        return _t("Total: %s", this.fmtCifra(s.total, s, spec));
    }

    // --- Formato ------------------------------------------------------------
    // `toLocaleString` y NO el formateador de Odoo: el modulo del formateador y
    // su nombre cambian entre la 14 y la 19, y esto tiene que compilar en las
    // seis series.
    _agrupado(v, dec) {
        return Number(v).toLocaleString(undefined, {
            minimumFractionDigits: dec, maximumFractionDigits: dec });
    }

    // Un conteo no lleva decimales ni simbolo; un importe lleva ambos cuando se
    // conoce el simbolo (al partir por moneda viene vacio A PROPOSITO, porque
    // el codigo ya rotula la seccion). Los centimos se omiten a partir de cinco
    // cifras: en un grafico no aportan y roban el ancho del numero. La cifra
    // exacta sigue en la tabla.
    fmtCifra(v, s, spec) {
        if (spec.is_count) {
            return this._agrupado(v, 0);
        }
        const n = this._agrupado(v, Math.abs(v) >= 10000 ? 0 : 2);
        return s.symbol ? s.symbol + " " + n : n;
    }

    fmtCorto(v, s, spec) {
        const a = Math.abs(v);
        let n = v, sfx = "";
        if (a >= 1e6) { n = v / 1e6; sfx = "M"; }
        else if (a >= 1e3) { n = v / 1e3; sfx = "k"; }
        const cuerpo = this._agrupado(n, sfx && a >= 1e3 ? 1 : 0) + sfx;
        return spec.is_count || !s.symbol ? cuerpo : s.symbol + " " + cuerpo;
    }

    // El saldo, con separador de miles. "60000" se lee mal de un vistazo y en
    // la app y en la web sale agrupado.
    get creditosFmt() {
        return this._agrupado(this.state.walletCredits || 0, 0);
    }

    // =====================================================================
    //  Copiar el texto
    // =====================================================================
    async copyText(m) {
        const texto = m.text || "";
        try {
            await navigator.clipboard.writeText(texto);
            this.notification.add(_t("Answer copied."), { type: "success" });
        } catch (e) {
            // Sin permiso de portapapeles (o sin HTTPS en algunos navegadores):
            // se dice, en vez de dejar creer que se copio.
            this.notification.add(
                _t("Could not copy. Select the text and copy it manually."),
                { type: "warning" });
        }
    }

    // =====================================================================
    //  Compartir enlace
    // =====================================================================
    // ⛔ Solo CREA. Administrar los enlaces (listarlos, revocarlos) se queda
    // fuera a proposito y el backend tampoco lo acepta con token personal: eso
    // se hace donde vive la cuenta, no dentro del Odoo de un cliente.
    openShare(m) {
        // Al abrir esto se CIERRA el panel de detalle de debajo: dejarlo
        // puesto apilaba dos capas y se veia como un descuido. Se cierra de
        // verdad (no se oculta), para que al salir de aqui no reaparezca solo.
        this.closeDetail();
        this.state.shareFor = m.backendId || null;
        this.state.shareUrl = "";
        this.state.shareExpires = "";
        this.state.shareDays = 7;
        this.state.shareBusy = false;
    }

    closeShare() {
        this.state.shareFor = null;
    }

    setShareDays(d) {
        this.state.shareDays = d;
    }

    async doShare() {
        if (this.state.shareBusy || !this.state.shareFor) {
            return; // guarda contra doble tap
        }
        this.state.shareBusy = true;
        try {
            const r = await this.orm.call("aski.account.link", "create_share",
                                          [this.state.shareFor, this.state.shareDays]);
            this.state.shareUrl = r.url || "";
            // Lo que se ENSENA es el vencimiento que VUELVE: el backend recorta
            // los dias al maximo del plan sin avisar, asi que mostrar los que se
            // pidieron seria mentir sobre cuando caduca.
            this.state.shareExpires = r.expires_at || "";
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.shareBusy = false;
        }
    }

    async copyShare() {
        try {
            await navigator.clipboard.writeText(this.state.shareUrl);
            this.notification.add(_t("Link copied."), { type: "success" });
        } catch (e) {
            this.notification.add(
                _t("Could not copy. Select the link and copy it manually."),
                { type: "warning" });
        }
    }

    // =====================================================================
    //  Los registros detras de la cifra
    // =====================================================================
    async openRecords(m) {
        if (!m.backendId) {
            return;
        }
        // Igual que las demas ventanas: cierra el panel de debajo. Va DESPUES de
        // la guarda, o cerraria el panel sin abrir nada.
        this.closeDetail();
        this.state.recordsFor = m.backendId;
        this.state.records = null;
        this.state.recordsBusy = true;
        try {
            this.state.records = await this.orm.call(
                "aski.account.link", "message_records", [m.backendId]);
        } catch (e) {
            this.state.recordsFor = null;
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.recordsBusy = false;
        }
    }

    closeRecords() {
        this.state.recordsFor = null;
        this.state.records = null;
    }

    // Los registros se abren EN Odoo, que es la ventaja de estar dentro: en la
    // app y en la web esto es un enlace que saca al usuario del programa.
    //
    // ⛔ En PESTANA NUEVA, no con `doAction({target: "current"})`. Eso ultimo
    // reemplazaba el chat por la ficha: el usuario perdia la conversacion y
    // tenia que volver y preguntar otra vez. Abriendo aparte, se contrasta la
    // ficha contra la respuesta con las dos a la vista, que es justo para lo
    // que se mira el detalle.
    openRecord(fila) {
        const modelo = (this.state.records || {}).model;
        if (!modelo || !fila.id) {
            return;
        }
        // `noopener` ademas de `_blank`: la pestana nueva no tiene que poder
        // tocar la que deja el chat abierto.
        // `window.open` y no `browser.open`: es lo que ya usa openBilling en este
        // mismo fichero y funciona en las seis series. `noopener` ademas de
        // `_blank`, para que la pestana nueva no pueda tocar la del chat.
        window.open(this._urlRegistro(modelo, fila.id), "_blank",
                    "noopener,noreferrer");
    }

    // La direccion de una ficha cambio de forma entre series: hasta la 16 es el
    // hash de /web y desde la 17 la ruta /odoo/<modelo>/<id>. Se DEDUCE de la
    // pagina en la que estamos en vez de fijar una constante por version, que es
    // lo que habria que tocar en cada serie nueva.
    _urlRegistro(modelo, id) {
        const raiz = window.location.origin;
        if (window.location.pathname.indexOf("/odoo") === 0) {
            return raiz + "/odoo/" + modelo + "/" + id;
        }
        return raiz + "/web#id=" + id + "&model=" + modelo + "&view_type=form";
    }

    // =====================================================================
    //  Excel
    // =====================================================================
    async exportXlsx(m) {
        if (this.state.xlsxBusy || !m.backendId) {
            return;
        }
        this.state.xlsxBusy = true;
        try {
            const r = await this.orm.call("aski.account.link", "export_message_xlsx",
                                          [m.backendId]);
            if (!r.content_b64) {
                this.notification.add(_t("There are no rows to export."),
                                      { type: "warning" });
                return;
            }
            this._descargarB64(r.content_b64, r.filename,
                              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.xlsxBusy = false;
        }
    }

    // Base64 -> descarga. Sin pasar por ir.attachment: no deja basura en la
    // base del cliente y el fichero no queda guardado en su Odoo.
    _descargarB64(b64, nombre, tipo) {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            buf[i] = bin.charCodeAt(i);
        }
        const url = URL.createObjectURL(new Blob([buf], { type: tipo }));
        const a = document.createElement("a");
        a.href = url;
        a.download = nombre;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Se libera despues: revocarlo en el mismo tick cancela la descarga en
        // algunos navegadores.
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    // =====================================================================
    //  Enviar por correo
    // =====================================================================
    openEmail(m) {
        // Al abrir esto se CIERRA el panel de detalle de debajo: dejarlo
        // puesto apilaba dos capas y se veia como un descuido. Se cierra de
        // verdad (no se oculta), para que al salir de aqui no reaparezca solo.
        this.closeDetail();
        this.state.emailFor = m.backendId || null;
        // Se propone el correo de la cuenta Aski conectada: es el destino mas
        // probable y evita teclear. Se toma del estado y NO del servicio de
        // usuario de Odoo, cuya forma cambia entre la 14 y la 19.
        this.state.emailTo = this.state.email || "";
        this.state.emailAttach = true;
        this.state.emailBusy = false;
    }

    closeEmail() {
        this.state.emailFor = null;
    }

    onEmailInput(ev) {
        this.state.emailTo = ev.target.value;
    }

    toggleEmailAttach() {
        this.state.emailAttach = !this.state.emailAttach;
    }

    async doEmail() {
        if (this.state.emailBusy || !this.state.emailFor) {
            return;
        }
        const destinos = (this.state.emailTo || "")
            .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
        if (!destinos.length) {
            this.notification.add(_t("Add at least one email address."),
                                  { type: "warning" });
            return;
        }
        this.state.emailBusy = true;
        try {
            const r = await this.orm.call("aski.account.link", "email_answer",
                [this.state.emailFor, destinos, this.state.emailAttach,
                 -new Date().getTimezoneOffset()]);
            // El backend dice CUANTOS salieron y cuales no, con el motivo. Se
            // repite tal cual: "no se pudo enviar" a secas deja reintentando lo
            // mismo, y una direccion que rebota no se arregla igual que un
            // correo saliente sin configurar.
            if (r.sent) {
                this.notification.add(
                    _t("Sent to %s recipient(s).", r.sent), { type: "success" });
            }
            if ((r.failed || []).length || r.error) {
                this.notification.add(
                    r.error || _t("Could not send to: %s", (r.failed || []).join(", ")),
                    { type: "danger", sticky: true });
            }
            if (r.sent && !((r.failed || []).length || r.error)) {
                this.state.emailFor = null;
            }
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.emailBusy = false;
        }
    }

    // =====================================================================
    //  Empezar de cero
    // =====================================================================
    // Olvida el contexto SIN borrar el hilo: la siguiente pregunta no arrastra
    // lo anterior. Es lo que hace el chip del pie en la app y en la web.
    async clearContext() {
        if (!this.state.conversationId || this.state.clearing) {
            return;
        }
        this.state.clearing = true;
        try {
            await this.orm.call("aski.account.link", "clear_context",
                                [this.state.conversationId]);
            this.notification.add(
                _t("Context cleared. The next question starts fresh."),
                { type: "success" });
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.clearing = false;
        }
    }

    _scrollToBottom() {
        requestAnimationFrame(() => {
            const el = this.messagesRef.el;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    }
}
AskiChatWidget.template = "aski_connector.ChatWidget";

return { AskiChatWidget: AskiChatWidget };
});
