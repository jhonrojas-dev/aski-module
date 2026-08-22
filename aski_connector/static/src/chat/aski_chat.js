/** @odoo-module **/
import { Component, useState, useRef, onWillStart, onWillUnmount, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";

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

export class AskiChatWidget extends Component {
    static template = "aski_connector.ChatWidget";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
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
            detailFor: null,
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
        });
        onWillStart(async () => { await this.loadStatus(); });
        // El chat se cierra (o se cambia de pantalla) con una respuesta en
        // vuelo: el cronometro seguiria latiendo sobre un componente que ya no
        // existe.
        onWillUnmount(() => this._stopClock());
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
                : ((e && e.data && e.data.message) || (e && e.message)
                   || _t("Couldn't load the Aski chat. Try again."));
        } finally {
            this.state.loading = false;
        }
    }

    async retryLoad() {
        await this.loadStatus();
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
    _msgDe(e) {
        return (e && e.data && e.data.message) || (e && e.message)
            || _t("Something went wrong. Try again.");
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
        return markup(mdToHtml(text));
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
            const msg = (e && e.data && e.data.message) || (e && e.message) || _t("Something went wrong. Try again.");
            this.notification.add(msg, { type: "danger", sticky: true });
        } finally {
            this.state.exporting = false;
        }
    }

    toggleDetail(m) {
        this.state.detailFor = this.state.detailFor === m.id ? null : m.id;
    }

    async setFeedback(m, value) {
        const previous = m.feedback;
        const next = previous === value ? null : value;
        m.feedback = next; // optimista
        try {
            await this.orm.call("aski.account.link", "set_feedback", [m.backendId, next]);
        } catch (e) {
            m.feedback = previous; // revertir si el backend rechazo el cambio
        }
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
            const msg = (e && e.data && e.data.message) || (e && e.message) || _t("Something went wrong. Try again.");
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
            browser.setTimeout(() => browser.location.reload(), DISCONNECT_RELOAD_DELAY_MS);
        } catch (e) {
            const msg = (e && e.data && e.data.message) || (e && e.message) || _t("Something went wrong. Try again.");
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
        this._clock = browser.setInterval(() => {
            this.state.elapsed += 1;
        }, 1000);
    }

    _stopClock() {
        if (this._clock) {
            browser.clearInterval(this._clock);
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
            const r = profundo
                ? await this.orm.call("aski.account.link", "send_message_agent",
                    [text, this.state.conversationId, confirmarPesada])
                : await this.orm.call("aski.account.link", "send_message",
                    [text, this.state.conversationId]);
            if (r.conversation_id) {
                this.state.conversationId = r.conversation_id;
            }
            if (isNewThread) this.refreshConversations();
            this.state.messages.push({
                id: `a${Date.now()}`, role: "assistant", text: r.answer || "",
                credits: typeof r.credits === "number" ? r.credits : null,
                backendId: null, rows: null, feedback: null,
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
            const msg = (e && e.data && e.data.message) || (e && e.message) || _t("Something went wrong. Try again.");
            // "Recargar creditos" solo si el fallo SON los creditos: ante un ERP
            // caido ese boton manda a pagar por algo que no lo arregla. Se mira
            // la clase de la excepcion (Odoo la pone en data.name), no el texto,
            // que viene traducido.
            const clase = (e && e.data && typeof e.data.name === "string") ? e.data.name : "";
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

    _scrollToBottom() {
        requestAnimationFrame(() => {
            const el = this.messagesRef.el;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    }
}

registry.category("actions").add("aski_chat_widget", AskiChatWidget);
