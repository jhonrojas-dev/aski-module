/** @odoo-module **/
import { Component, useState, useRef, onWillStart, onWillUnmount, onMounted, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";
import { getRecord, clearRecord, subscribe } from "@aski_connector/record/aski_record";

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

// Buscar en el historial. Por debajo de dos caracteres casi todo coincide, y
// ademas es el minimo que valida el backend (app/chat/search.py): cortar aqui
// evita gastar una peticion en algo que ya se sabe que no ayuda.
const MIN_SEARCH_LEN = 2;
// 350 ms, y no los 300 de la app y la web, A PROPOSITO: el limite de
// /chat/search va por IP y desde un Odoo TODOS los usuarios salen por la misma,
// asi que aqui una pausa un poco mas larga rinde mas que alli.
const SEARCH_DEBOUNCE_MS = 350;
// Cuanto dura el aro que senala la burbuja a la que se acaba de saltar.
const JUMP_HIGHLIGHT_MS = 2000;
// Cuanto se ensena del termino buscado en el aviso de "sin resultados": una
// consulta larga entera desbordaria el cajon.
const MAX_TERM_SHOWN = 40;
// Chips de arranque en la burbuja del systray. El backend manda cuatro y a
// pantalla completa se leen en fila, pero en la burbuja cada una ocupa la suya:
// con las cuatro, el boton de la biblioteca quedaba fuera de la vista y no habia
// forma de enterarse de que existe el resto del catalogo.
const MAX_CHIPS_MINI = 2;

// El icono de cada chip sale de la SECCION que declara el backend y no de su
// texto: asi una pregunta nueva del catalogo nunca aparece sin icono. Las claves
// son las de `SECCIONES` en app/suggestions/catalog.py.
const ICONO_SECCION = {
    ventas: "fa-line-chart",
    cobranza: "fa-clock-o",
    clientes: "fa-users",
    inventario: "fa-cubes",
    compras: "fa-truck",
    oportunidades: "fa-trophy",
    finanzas: "fa-bank",
};

// El widget se monta DOS veces en la misma pagina (pantalla completa y burbuja
// del systray) y cada instancia pediria por su cuenta las cifras al ERP del
// cliente. El modulo JS es UNO solo para las dos, asi que la promesa compartida
// vive aqui. Mismo patron que `canUseChat()` en record/aski_access.js.
let _sugPromesa = null;
function pedirSugerencias(orm, refresh) {
    if (refresh || !_sugPromesa) {
        _sugPromesa = orm.call("aski.account.link", "get_suggestions", [!!refresh])
            // Una promesa RECHAZADA que se quedara cacheada convertiria un corte
            // de red de un segundo en un arranque roto para el resto de la
            // sesion: el reintento recibiria el mismo fallo sin volver a
            // preguntar.
            .catch((e) => { _sugPromesa = null; throw e; });
    }
    return _sugPromesa;
}

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
            // --- Asiento de equipo ---
            // Quien abre el chat sin cuenta propia puede estar sentado en la
            // cuenta de su empresa. `seat` guarda lo que dice el backend; null
            // mientras no se ha preguntado.
            seat: null,
            seatBusy: false,
            // A quien le llego la peticion: "partner" | "owner". Se guarda para
            // poder decirlo en pantalla en vez de un "listo" mudo.
            seatAsked: "",
            seatPartner: "",
            // --- Avisos programados ---
            insightsOpen: false,
            // Mi equipo dentro de Odoo: quien mas pregunta con esta cuenta.
            equipoOpen: false,
            equipo: null,
            equipoCargando: false,
            creditosPedidos: false,
            // Alta y acciones del equipo, DENTRO de Odoo.
            invAbierto: false,
            invEmail: "",
            invRol: "member",
            invTope: "",
            invBusy: false,
            invEnlace: "",
            seatPorQuitar: null,
            seatBusyId: null,
            // --- Pedirle cosas al proveedor, DESDE Odoo ---
            // ⛔ Aqui no se enlaza a la pasarela ni se manda a "contactar a
            // ventas": quien usa Aski dentro del ERP esta ahi por no salir a
            // otra pantalla, y ademas su tarifa la pone su socio. Se deja una
            // peticion REGISTRADA que el socio ve en su panel.
            pedidos: [],
            catalogo: null,
            pidiendo: "",
            pedirAbierto: "",
            // El asiento que se esta editando (rol y tope). Null = ninguno.
            seatEdit: null,
            seatEditRol: "member",
            seatEditTope: "",
            insights: [],
            insightsLoading: false,
            // Distinto de "no tienes ninguno": el backend no contesto. Son dos
            // pantallas distintas y pintarlas igual manda a buscar donde no es.
            insightsErr: false,
            insightLimit: null,
            insightUsed: 0,
            insightPorPersona: [],
            insightBusy: null,
            // Alta rapida desde la ultima respuesta: la pregunta ya resuelta se
            // guarda tal cual y el aviso la repite sin volver a pensar nada.
            insightNewFor: null,
            // Alta de los otros tipos: 'watch' | 'reminder' | null. El resumen y
            // el cierre no pasan por aqui — son interruptores, no formularios.
            newKind: null,
            catalogoCargando: false,
            metricas: [],
            temas: [],
            watchMetric: "", watchOp: ">", watchValue: "",
            remTopic: "", remDays: 3,
            insightHour: 8,
            insightFreq: "daily",
            insightSaving: false,
            // --- Acciones sobre el ERP ---
            actions: [],
            actionsEnabled: false,
            // El modo de acceso permite acciones (solo "por usuario"). Se guarda
            // para poder EXPLICAR por que no estan, en vez de esconderlas.
            actionsModeOk: true,
            actionBusy: null,
            confirmActionId: null,
            // --- Buscar dentro del historial, desde el cajon ---
            // `searchQ` es lo TECLEADO y `searchTerm` lo ya consultado. Tenerlos
            // separados es lo que permite que la lista de hilos ceda el sitio en
            // cuanto se empieza a escribir, y que el aviso de "sin resultados"
            // cite lo que de verdad se busco y no lo que se esta escribiendo.
            searchQ: "", searchTerm: "", searchResults: [],
            searchLoading: false, searchCode: "",
            // Burbuja senalada tras saltar desde un resultado. Se apaga sola.
            jumpHit: null,
            // --- Arranque: las cifras de esta conexion y que preguntarle ---
            sugs: null, sugsLoading: false, sugsCode: "", libraryOpen: false,
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
        // Una busqueda en vuelo al cerrar la burbuja del systray: el
        // temporizador dispararia sobre un componente que ya no existe.
        onWillUnmount(() => this._cancelSearchTimer());
        // Esc cierra la hoja de detalle, como cualquier dialogo de Odoo. Va en
        // el documento porque la hoja no tiene el foco por si sola, y se retira
        // al desmontar: el widget se monta DOS veces (pantalla completa y
        // burbuja del systray) y dejar el listener colgado haria que la hoja de
        // una cerrase por la otra.
        this._onEsc = (ev) => {
            if (ev.key !== "Escape") {
                return;
            }
            // La biblioteca va DELANTE de la hoja de detalle: con las dos
            // abiertas, Esc cierra la de encima, que es la que se esta viendo.
            if (this.state.libraryOpen) {
                this.state.libraryOpen = false;
                return;
            }
            if (this.state.detailFor) {
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
                // El arranque solo tiene sentido con la bienvenida a la vista.
                // Y NO se espera a proposito: la primera pantalla no puede
                // quedarse colgada de un ERP lento, asi que el chat se pinta ya
                // y la tarjeta de cifras llega cuando llegue.
                if (!this.state.messages.length) {
                    this.loadSuggestions();
                }
                // Ni las acciones ni el asiento se ESPERAN: la primera pantalla
                // no puede quedarse colgada de dos llamadas mas. Llegan cuando
                // llegan y el chat ya esta usable.
                this._cargarAcciones();
                this._cargarAsiento();
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

    async openConversation(conversationId, saltarA) {
        this.state.drawerOpen = false;
        this.state.conversationId = conversationId;
        this.state.messages = await this.orm.call("aski.account.link", "load_conversation", [conversationId]);
        if (saltarA) {
            // ⛔ El salto EN VEZ del scroll al final, no ademas: haciendo los
            // dos, el ultimo mensaje del hilo se lleva la vista y el mensaje
            // buscado ni se ve. Solo se nota buscando uno del medio, que es
            // justo el caso por el que existe el buscador.
            this._jumpToMessage(saltarA);
        } else {
            this._scrollToBottom();
        }
    }

    newConversation() {
        this.state.drawerOpen = false;
        this.state.conversationId = null;
        this.state.messages = [];
        // Vuelve a verse el arranque. La promesa esta memoizada en el modulo,
        // asi que esto no vuelve a pegarle al ERP del cliente.
        this.loadSuggestions();
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
    // La ruta cambia segun la serie: en unas esta en `e.data.name` y en otras un
    // nivel mas adentro. Cuando no se encontraba, el chat no ofrecia recargar
    // creditos al quedarse sin saldo ni apagaba el interruptor de analisis
    // profundo (visto en la QA de la 14).
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
        const delBackend = (this.state.sugs && this.state.sugs.questions) || [];
        if (delBackend.length) {
            const lista = this.enBurbuja
                ? delBackend.slice(0, MAX_CHIPS_MINI)
                : delBackend;
            return lista.map((q) => ({
                key: q.key,
                text: q.text,
                icon: ICONO_SECCION[q.section] || "fa-comment-o",
            }));
        }
        // Respaldo: sin red, con el ERP caido o mientras las cifras vienen en
        // camino, la fila NO puede quedar vacia — una pantalla de arranque muda
        // es peor que cuatro preguntas genericas. Se quedan las cuatro enteras
        // aunque sea la burbuja: por este camino no hay biblioteca a la que
        // llegar, asi que el recorte no ahorraria nada.
        return [
            { key: "f1", icon: "fa-line-chart", text: _t("How much did I sell this month?") },
            { key: "f2", icon: "fa-trophy", text: _t("My top 10 customers") },
            { key: "f3", icon: "fa-clock-o", text: _t("Overdue invoices") },
            { key: "f4", icon: "fa-users", text: _t("How many customers do I have?") },
        ];
    }

    // Este montaje es el de la burbuja del systray y no el de pantalla completa.
    // Se deduce de las props porque son las que pone el systray (`aski_systray.xml`)
    // y la accion de pantalla completa no: no hace falta una prop nueva que
    // habria que pasar en dos sitios y mantener en las seis series.
    get enBurbuja() {
        return !!this.props.onMinimize;
    }

    useSample(text) {
        this.state.input = text;
        this.send();
    }

    // ==================================================================
    // Buscar DENTRO del historial, desde el cajon. Lo que uno recuerda esta
    // en el cuerpo de un mensaje, no en el titulo del hilo.
    // ==================================================================
    onSearchInput(ev) {
        const q = (ev && ev.target ? ev.target.value : "") || "";
        this.state.searchQ = q;
        this._cancelSearchTimer();
        if (q.trim().length < MIN_SEARCH_LEN) {
            // Se limpia YA: dejar los resultados de la consulta anterior debajo
            // de un cuadro casi vacio se lee como si siguieran valiendo.
            this.state.searchResults = [];
            this.state.searchTerm = "";
            this.state.searchLoading = false;
            this.state.searchCode = "";
            return;
        }
        this.state.searchLoading = true;
        this.state.searchCode = "";
        // `setTimeout` pelado y no `browser.setTimeout`: la serie 14 no importa
        // el envoltorio `browser`, y este fichero tiene que ser el mismo en las
        // seis (lo unico que lo adapta es el script de port a OWL 1).
        this._searchTimer = setTimeout(() => this._doSearch(), SEARCH_DEBOUNCE_MS);
    }

    _cancelSearchTimer() {
        if (this._searchTimer) {
            clearTimeout(this._searchTimer);
            this._searchTimer = null;
        }
    }

    async _doSearch() {
        this._searchTimer = null;
        const q = this.state.searchQ.trim();
        if (q.length < MIN_SEARCH_LEN) {
            return;
        }
        // Numero de peticion: una respuesta lenta que llegue DESPUES de otra mas
        // nueva pintaria resultados de algo que el usuario ya dejo de buscar. El
        // RPC de la serie 14 no se puede abortar; contar si.
        const seq = (this._searchSeq = (this._searchSeq || 0) + 1);
        let r = null;
        try {
            r = await this.orm.call("aski.account.link", "search_history", [q, 30]);
        } catch (e) {
            if (seq !== this._searchSeq) {
                return;
            }
            this.state.searchLoading = false;
            this.state.searchResults = [];
            this.state.searchTerm = q;
            this.state.searchCode = "error";
            return;
        }
        if (seq !== this._searchSeq) {
            return;
        }
        this.state.searchLoading = false;
        this.state.searchCode = (r && r.ok) ? "" : ((r && r.code) || "error");
        this.state.searchResults = (r && r.results) || [];
        this.state.searchTerm = q;
    }

    retrySearch() {
        if (this.state.searchQ.trim().length < MIN_SEARCH_LEN) {
            return;
        }
        this.state.searchLoading = true;
        this.state.searchCode = "";
        this._doSearch();
    }

    clearSearch() {
        this._cancelSearchTimer();
        // Se invalida lo que venga en vuelo: si no, una respuesta en camino
        // repintaria resultados sobre un cajon que el usuario acaba de limpiar.
        this._searchSeq = (this._searchSeq || 0) + 1;
        this.state.searchQ = "";
        this.state.searchTerm = "";
        this.state.searchResults = [];
        this.state.searchLoading = false;
        this.state.searchCode = "";
    }

    // Con busqueda activa el cajon ensena RESULTADOS en vez de hilos. Mira lo
    // TECLEADO y no lo consultado, para que la lista de hilos ceda el sitio sin
    // esperar a la pausa del teclado (si no, se ve medio segundo de lista vieja
    // debajo de lo que se acaba de escribir).
    get searchActive() {
        return this.state.searchQ.trim().length >= MIN_SEARCH_LEN;
    }

    get searchTermCorto() {
        const q = this.state.searchTerm;
        return q.length > MAX_TERM_SHOWN ? q.slice(0, MAX_TERM_SHOWN) + "\u2026" : q;
    }

    /**
     * El fragmento partido en tres TROZOS DE TEXTO para resaltar la coincidencia.
     *
     * ⛔ No se devuelve HTML. El fragmento es texto del usuario y de las
     * respuestas sobre SUS datos: inyectarlo como markup obligaria a escaparlo a
     * mano y ademas el mecanismo cambia por serie (markup() + t-out en 16-19,
     * t-raw en 14/15). Con tres `t-esc` el navegador escapa solo, por definicion,
     * y se escribe igual en las seis series.
     *
     * Los offsets vienen del BACKEND (app/chat/search.py) porque buscar `q` aqui
     * no encontraria nada si el usuario tecleo "credito" y el texto dice
     * "credito" con tilde: haria falta duplicar la tabla de acentos en JS. Se
     * acotan por si acaso — un desajuste entre cliente y backend degrada a texto
     * plano, nunca a un recorte absurdo.
     */
    snippetPartes(r) {
        const texto = (r && r.snippet) || "";
        const ini = Math.max(0, Math.min(r.matchStart || 0, texto.length));
        const largo = Math.max(0, Math.min(r.matchLen || 0, texto.length - ini));
        return {
            pre: texto.slice(0, ini),
            hit: texto.slice(ini, ini + largo),
            post: texto.slice(ini + largo),
        };
    }

    async openSearchResult(r) {
        // La busqueda se limpia al saltar: volver del hilo a una lista de
        // resultados que ya no viene a cuento desorienta mas que ayuda.
        const destino = r.domId;
        this.clearSearch();
        await this.openConversation(r.conversationId, destino);
    }

    /**
     * Lleva la vista a la burbuja de un resultado y la senala.
     *
     * Dos detalles que NO son cosmeticos:
     *
     * 1) Se busca DENTRO de `messagesRef.el`, nunca en `document`: el widget se
     *    monta DOS veces a la vez (pantalla completa y burbuja del systray) y un
     *    querySelector global encontraria la burbuja de la OTRA instancia.
     * 2) Se mueve el scroll del CONTENEDOR a mano en vez de usar
     *    `scrollIntoView`: en el systray el chat vive dentro de un panel
     *    `position: fixed` y scrollIntoView arrastraria tambien a los ancestros
     *    del web client.
     *
     * Y una pasada no basta: al abrir el hilo las burbujas se pintan antes de que
     * su contenido ocupe sitio (tablas anchas, markdown que reflowea), asi que el
     * destino se calcula sobre una maqueta a medio hacer. Se corrige por MEDIDA
     * REAL hasta que de verdad quede a la vista, igual que en la app y en la web.
     */
    _jumpToMessage(domId) {
        let intentos = 0;
        const paso = () => {
            const cont = this.messagesRef.el;
            if (!cont) {
                return;
            }
            const el = cont.querySelector('[data-msg-id="' + domId + '"]');
            if (!el) {
                intentos += 1;
                if (intentos < 6) setTimeout(paso, 150);
                return;
            }
            const c = el.getBoundingClientRect();
            const s = cont.getBoundingClientRect();
            const dentro = c.top >= s.top - 1 && c.top <= s.bottom;
            if (!dentro) {
                cont.scrollTop += (c.top - s.top)
                    - Math.max(0, (cont.clientHeight - c.height) / 2);
                intentos += 1;
                if (intentos < 6) {
                    setTimeout(paso, 150);
                    return;
                }
            }
            this.state.jumpHit = domId;
            setTimeout(() => {
                if (this.state.jumpHit === domId) {
                    this.state.jumpHit = null;
                }
            }, JUMP_HIGHLIGHT_MS);
        };
        requestAnimationFrame(paso);
    }

    // ==================================================================
    // Arranque del chat: las cifras REALES de esta conexion y que preguntarle.
    // ==================================================================
    async loadSuggestions(refresh) {
        if (!this.state.connected || this.state.sugsLoading) {
            return;
        }
        this.state.sugsLoading = true;
        let r = null;
        try {
            r = await pedirSugerencias(this.orm, !!refresh);
        } catch (e) {
            this.state.sugsLoading = false;
            // ⛔ Un fallo NO borra lo que ya se sabia: se sigue pintando con su
            // edad, que es mas util que un hueco. Y NUNCA por `notification.add`:
            // en la serie 14 eso no es un aviso flotante, sino una burbuja de
            // error empujada dentro del hilo.
            this.state.sugsCode = "erp_down";
            return;
        }
        this.state.sugsLoading = false;
        this.state.sugsCode = (r && r.ok) ? "" : ((r && r.code) || "erp_down");
        if (r && r.ok) {
            this.state.sugs = r;
        }
    }

    get startMetrics() {
        return (this.state.sugs && this.state.sugs.metrics) || [];
    }

    get startSections() {
        return (this.state.sugs && this.state.sugs.sections) || [];
    }

    // Los importes de una cifra, uno por renglon. El motor ya decidio NO sumar
    // monedas distintas y las unio con el punto medio: aqui solo se parten.
    // ⛔ Nunca se reformatea un importe en el cliente.
    metricLineas(m) {
        return ((m && m.value) || "").split(" \u00b7 ");
    }

    // "3 empresas". El numero se sustituye sobre la cadena YA traducida y no con
    // _t("%s companies", n): las series 14 y 15 no admiten argumentos en _t() y
    // ahi el usuario veria el "%s" tal cual.
    metricEmpresas(m) {
        return String(_t("across %s companies")).replace("%s", String(m.companies));
    }

    // Edad del dato. Misma razon que arriba para sustituir a mano.
    get startAge() {
        const iso = this.state.sugs && this.state.sugs.asOf;
        if (!iso) {
            return "";
        }
        const t = Date.parse(iso);
        if (isNaN(t)) {
            return "";
        }
        const min = Math.floor((Date.now() - t) / 60000);
        if (min < 1) {
            return _t("just now");
        }
        if (min < 60) {
            return String(_t("%s min ago")).replace("%s", String(min));
        }
        const h = Math.floor(min / 60);
        if (h < 48) {
            return String(_t("%s h ago")).replace("%s", String(h));
        }
        return String(_t("%s d ago")).replace("%s", String(Math.floor(h / 24)));
    }

    openLibrary() {
        this.state.libraryOpen = true;
    }

    closeLibrary() {
        this.state.libraryOpen = false;
    }

    useLibraryQuestion(q) {
        this.state.libraryOpen = false;
        this.useSample(q.text);
    }

    /**
     * Los textos nuevos, TODOS por _t() y desde aqui.
     *
     * ⛔ No van como literales en la plantilla: en las series 14 y 15 el texto
     * estatico de una plantilla OWL no se traduce NUNCA (el bundle de plantillas
     * se sirve crudo y sin idioma), asi que un literal en el .xml se veria en
     * ingles aunque el .po estuviera perfecto.
     *
     * Es un getter y no una constante de modulo para que _t() se evalue en cada
     * render, cuando el catalogo de traducciones ya esta cargado.
     */
    get txt() {
        return {
            searchPh: _t("Search your history"),
            invitePh: _t("name@company.com"),
            searchClear: _t("Clear search"),
            searching: _t("Searching..."),
            searchErr: _t("Couldn't complete the search."),
            searchBusy: _t("Too many searches right now. Try again in a moment."),
            searchNone: _t("No results for"),
            retry: _t("Try again"),
            startTitle: _t("Your figures right now"),
            startRefresh: _t("Refresh"),
            startErpDown: _t("Your ERP did not answer"),
            startBusy: _t("Too many refreshes. Try again in a while."),
            startEmpty: _t("No movements to show in this connection yet."),
            startStale: _t("Showing the last known figures."),
            startMore: _t("See more questions"),
            libTitle: _t("What you can ask"),
            close: _t("Close"),
        };
    }

    // "Sin resultados para «lo que sea»". Se arma por concatenacion: _t() con
    // argumentos no funciona en 14/15.
    get searchEmptyTxt() {
        return this.txt.searchNone + " \u00ab" + this.searchTermCorto + "\u00bb";
    }

    // El aviso de un fallo de busqueda, por CODIGO y no por el texto del backend:
    // el backend responde en su idioma y esta instancia puede estar en otro.
    get searchErrTxt() {
        return this.state.searchCode === "rate_limited"
            ? this.txt.searchBusy
            : this.txt.searchErr;
    }

    get startErrTxt() {
        return this.state.sugsCode === "rate_limited"
            ? this.txt.startBusy
            : this.txt.startErpDown;
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
    // Un ISO del backend a Date local. Llega en UTC y a veces SIN marca de zona:
    // sin la "Z" el navegador lo leeria como hora local y la burbuja saldria con
    // horas de desfase. Lo usan la hora de la burbuja y la fecha de un resultado
    // de busqueda — un solo parseo, para que no puedan contar cosas distintas.
    _fechaDe(iso) {
        if (!iso) {
            return null;
        }
        const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : iso + "Z");
        return isNaN(d.getTime()) ? null : d;
    }

    bubbleTime(iso) {
        const d = this._fechaDe(iso);
        return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    }

    // En un resultado va la FECHA y no la hora: puede ser de hace meses, y un
    // "14:32" suelto no situa nada. `toLocaleDateString` respeta el idioma.
    searchFecha(r) {
        const d = this._fechaDe(r && r.createdAt);
        return d ? d.toLocaleDateString() : "";
    }

    // El titulo del hilo al que pertenece un resultado. Es CONTEXTO, no el
    // contenido: por eso en el cajon pesa menos que el fragmento.
    searchConvTitle(r) {
        return (r && r.conversationTitle) || _t("Untitled");
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
            browser.setTimeout(() => browser.location.reload(), DISCONNECT_RELOAD_DELAY_MS);
        } catch (e) {
            const msg = this._msgDe(e);
            this.notification.add(msg, { type: "danger", sticky: true });
            this.state.disconnecting = false;
        }
    }

    /** Donde vive la web de Aski. La manda el MODULO (parametro del sistema
     *  `aski.web_base`): en Odoo `window.location.origin` es el dominio del
     *  cliente, y un despliegue propio no vive en app.aski.dev. */
    get baseWeb() {
        return (this.state.equipo && this.state.equipo.web_base) || "https://app.aski.dev";
    }

    abrirWeb(ruta) {
        window.open(this.baseWeb + ruta, "_blank", "noopener,noreferrer");
    }

    openBilling() {
        this.abrirWeb("/billing");
    }

    /** Cuenta PROPIA: aqui no hay a quien pedirle asientos —no hay socio— asi que
     *  se lleva a comprarlos.
     *
     *  ⛔ Y aqui SI se puede enlazar a la compra: la regla que lo prohibe es de
     *  Google Play y afecta a la app de Android, no a una pagina dentro de Odoo.
     *  Copiar alli el "contactar a ventas" habria sido arrastrar una limitacion
     *  ajena y dejar a esta gente sin salida. */
    comprarAsientos() {
        this.abrirWeb("/settings/team");
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
            // Y el saldo con lo que dice el SERVIDOR: la resta local de arriba
            // es una estimacion y se desfasa si el cobro real difiere.
            try {
                const w = await this.orm.call("aski.account.link", "get_wallet", []);
                if (typeof w.wallet_credits === "number") {
                    this.state.walletCredits = w.wallet_credits;
                }
                if (w.plan_name) {
                    this.state.planName = w.plan_name;
                }
            } catch (e3) { /* se queda la estimacion local, que ya es util */ }
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
        // ⛔ La sustitucion va sobre la cadena YA traducida y no por `_t(txt, val)`:
        // en las series 14 y 15 `_t` es `translatedTerms[term] || term` — un solo
        // argumento y cero interpolacion — asi que ahi el usuario veia el "%s"
        // literal. Con `.replace()` se comporta igual en las seis.
        return String(_t("%s days")).replace("%s", String(d));
    }

    get conteoRegistros() {
        const r = this.state.records || {};
        return String(_t("%(shown)s of %(total)s"))
            .replace("%(shown)s", String((r.rows || []).length))
            .replace("%(total)s", String(r.total));
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
                return String(_t("Top %(shown)s of %(total)s"))
                    .replace("%(shown)s", String(s.points.length))
                    .replace("%(total)s", String(s.partial_of));
            }
            return "";
        }
        return String(_t("Total: %s")).replace("%s", this.fmtCifra(s.total, s, spec));
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
            await browser.navigator.clipboard.writeText(texto);
            // La accion TERMINO: la hoja de detalle se cierra, como ya hacen las
            // que abren otra ventana (`openRecords`, `openShare`, `emailAnswer`).
            // Dejarla puesta con el aviso de "copiado" encima se siente atascada:
            // el usuario ya obtuvo lo que vino a buscar. Reportado sobre la
            // instancia real el 25/08.
            this.closeDetail();
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
            await browser.navigator.clipboard.writeText(this.state.shareUrl);
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
        const raiz = browser.location.origin;
        if (browser.location.pathname.indexOf("/odoo") === 0) {
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
            // Igual que copiar: la accion termino, asi que la hoja se va. El
            // resultado (o el error) ya lo dice el aviso.
            this.closeDetail();
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
        browser.setTimeout(() => URL.revokeObjectURL(url), 4000);
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
                    String(_t("Sent to %s recipient(s).")).replace("%s", String(r.sent)),
                    { type: "success" });
            }
            if ((r.failed || []).length || r.error) {
                this.notification.add(
                    r.error || String(_t("Could not send to: %s"))
                        .replace("%s", (r.failed || []).join(", ")),
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

    // =====================================================================
    //  Asiento de equipo
    // =====================================================================
    // Quien abre el chat aqui y no tiene cuenta puede estar sentado en la de su
    // empresa. Preguntarlo cuesta una llamada y evita el peor camino que tenia
    // el conector: mandar a alguien a crear una cuenta y que descubra el precio
    // de un plan entero al final.
    async _cargarAsiento() {
        try {
            this.state.seat = await this.orm.call("aski.account.link", "seat_status", []);
        } catch {
            this.state.seat = null;
        }
    }

    async pedirAsiento() {
        if (this.state.seatBusy) {
            return;
        }
        this.state.seatBusy = true;
        try {
            const r = await this.orm.call("aski.account.link", "request_seat", []);
            this.state.seatAsked = r.routed_to || "owner";
            this.state.seatPartner = r.partner_name || "";
            this.notification.add(
                r.already_pending
                    ? _t("You had already asked. We let them know again.")
                    : _t("Done. We passed your request along."),
                { type: "success" });
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.seatBusy = false;
        }
    }

    // Frases COMPLETAS, no trozos pegados alrededor de una interpolacion.
    // Partirlas en el XML producia msgid como "Sent to", "of" y ", who manages
    // this account." — imposibles de traducir bien (cada idioma ordena distinto)
    // y sin contexto para quien traduce. Mismo patron que ya usa el resto del
    // widget: `%s` y `.replace`, porque las series 14 y 15 no admiten argumentos
    // en `_t()`.
    get textoAsientoPedido() {
        if (this.state.seatAsked === "partner") {
            return String(_t("Sent to %s, who manages this account."))
                .replace("%s", this.state.seatPartner || _t("your provider"));
        }
        return _t("Sent to the account owner.");
    }

    /** Por que esta en pausa, no solo QUE lo esta.
     *
     *  ⛔ Los tres motivos «del titular» van aparte: a un asiento no se le dice
     *  «te quedaste sin creditos» por una bolsa que no es suya, que no puede
     *  recargar y que no decide. Antes esto devolvia «en pausa» a secas, asi que
     *  no habia forma de saber si lo arreglabas tu o tenia que arreglarlo otro.
     */
    motivoPausa(f) {
        return {
            no_plan: _t("paused: your plan no longer includes it"),
            no_credits: _t("paused: you ran out of credits"),
            failing: _t("paused: we could not reach your ERP"),
            over_limit: _t("paused: your plan includes fewer alerts"),
            owner_no_plan: _t("paused: the account plan no longer includes it"),
            owner_no_credits: _t("paused: the account ran out of credits"),
            owner_over_limit: _t("paused: the account includes fewer alerts now"),
        }[f.paused_reason] || _t("paused");
    }

    /** «· Ana 3, Luis 2, tú 2». Solo cuando hay mas de una persona: en una
     *  cuenta de uno, repetirse el propio nombre es ruido. */
    get desgloseCupo() {
        const filas = (this.state.insightPorPersona || []).filter((p) => p.count > 0);
        if (filas.length < 2) {
            return "";
        }
        const yo = _t("you");
        return " · " + filas
            .map((p) => `${p.is_me ? yo : (p.email || "").split("@")[0]} ${p.count}`)
            .join(", ");
    }

    get textoCupoAvisos() {
        // ⛔ DOS `%s`, no huecos inventados. Un `%u`/`%m` en el msgid rompe el
        // analisis del catalogo de Odoo y descarta TODAS las cadenas que vengan
        // despues en el fichero — se comio 59 traducciones sin decir nada.
        // `replace` con cadena sustituye solo la primera aparicion, asi que dos
        // llamadas encadenadas rellenan los dos huecos en orden.
        const usados = Number(this.state.insightUsed) || 0;
        const tope = Number(this.state.insightLimit);
        const quien = this.desgloseCupo;
        // ⛔ Sin tope, el backend manda `null`. Escribiendolo tal cual salia
        // «2 de false», que no significa nada para nadie.
        if (!isFinite(tope) || tope <= 0) {
            return String(_t("%s scheduled alerts on this account."))
                .replace("%s", String(usados)) + quien;
        }
        return String(_t("%s of %s alerts used — the quota belongs to the whole account."))
            .replace("%s", String(usados))
            .replace("%s", String(tope)) + quien;
    }

    // =====================================================================
    //  Avisos programados
    // =====================================================================
    // -----------------------------------------------------------------
    //  Mi equipo, dentro de Odoo
    // -----------------------------------------------------------------
    // ⛔ Las etiquetas se copian de la app (`team_*` en strings.xml). Hasta hoy
    // el conector SABIA si quien mira es un asiento —`seat_status` se pedia al
    // arrancar— y no lo enseñaba en ningun sitio: quien se sienta en la cuenta
    // de otro no veia ni de quien es la cuenta ni cuanto llevaba gastado.

    async openTeam() {
        this.state.detailFor = null;
        this.state.equipoOpen = true;
        this.state.equipoCargando = true;
        this.state.pedirAbierto = "";
        this.state.seatEdit = null;
        try {
            this.state.equipo = await this.orm.call("aski.account.link", "team_seats", []);
        } catch {
            this.state.equipo = null;
        } finally {
            this.state.equipoCargando = false;
        }
        // Lo pendiente y el catalogo van DESPUES y sin bloquear: la hoja ya se
        // puede leer con el equipo, y si el catalogo tarda no hay por que dejar
        // la pantalla en blanco esperandolo.
        this.cargarPedidos();
    }

    /** Lo que esta cuenta ya pidio y sigue sin resolver, mas lo que se puede
     *  pedir. Sin lo primero, el boton no sabe que ya se pulso y la persona lo
     *  repite — cinco filas de ruido en el panel del socio por una intencion. */
    async cargarPedidos() {
        try {
            const r = await this.orm.call("aski.account.link", "my_partner_requests", []);
            this.state.pedidos = (r && r.requests) || [];
        } catch {
            this.state.pedidos = [];
        }
        if (!this.state.catalogo) {
            try {
                this.state.catalogo = await this.orm.call(
                    "aski.account.link", "billing_catalog", []);
            } catch {
                this.state.catalogo = null;
            }
        }
    }

    /** ¿Ya se pidió esto y sigue esperando? `id` vacio = cualquiera de ese tipo
     *  (los asientos no llevan producto: se pide capacidad, no un articulo). */
    yaPedido(kind, id) {
        return (this.state.pedidos || []).some(
            (p) => p.kind === kind && (!id || p.plan_id === id || p.pack_id === id));
    }

    get esDeSocio() {
        const e = this.state.equipo || {};
        return !!e.partner_managed;
    }

    get nombreProveedor() {
        const e = this.state.equipo || {};
        return e.partner_name || _t("your provider");
    }

    /** Quien va a recibir la peticion. Se dice con NOMBRE: "se lo pedimos a tu
     *  proveedor" deja a la persona sin saber a quien recordarselo si tarda. */
    get notaProveedor() {
        return String(_t("%s gets it in their panel and turns it on."))
            .replace("%s", this.nombreProveedor);
    }

    abrirPedir(kind) {
        this.state.pedirAbierto = this.state.pedirAbierto === kind ? "" : kind;
    }

    /** Deja la peticion registrada. Un asiento no lleva `id`: lo que se pide es
     *  capacidad, y el precio del siguiente lo pone el socio. */
    async pedirAlProveedor(kind, id) {
        if (this.state.pidiendo) {
            return;
        }
        this.state.pidiendo = kind + (id || "");
        try {
            const args = [kind];
            if (kind === "plan") {
                args.push(id, null);
            } else if (kind === "topup") {
                args.push(null, id);
            }
            await this.orm.call("aski.account.link", "request_to_partner", args);
            this.state.pedirAbierto = "";
            await this.cargarPedidos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger" });
        } finally {
            this.state.pidiendo = "";
        }
    }

    // --- Editar un asiento ya creado (rol y tope) ---------------------
    // El backend lo admite desde hoy; hasta ahora la hoja solo sabia quitar y
    // devolver, asi que subirle el tope a alguien obligaba a salir a la web.

    abrirEditarAsiento(p) {
        this.state.seatEdit = p;
        this.state.seatEditRol = p.role || "member";
        this.state.seatEditTope = p.monthly_credit_cap ? String(p.monthly_credit_cap) : "";
    }

    cerrarEditarAsiento() {
        this.state.seatEdit = null;
    }

    async guardarAsiento() {
        const p = this.state.seatEdit;
        if (!p || this.state.seatBusyId) {
            return;
        }
        this.state.seatBusyId = p.id;
        try {
            // ⛔ El tope se quita mandando 0, no vacio: en un PATCH parcial "no
            // lo mande" y "ponlo en nada" son indistinguibles.
            const tope = String(this.state.seatEditTope || "").trim();
            await this.orm.call("aski.account.link", "update_seat", [p.id, {
                role: this.state.seatEditRol,
                monthly_credit_cap: tope === "" ? 0 : parseInt(tope, 10),
            }]);
            this.state.seatEdit = null;
            await this.openTeam();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger" });
        } finally {
            this.state.seatBusyId = null;
        }
    }

    abrirInvitar() {
        this.state.invAbierto = true;
        this.state.invEmail = "";
        this.state.invRol = "member";
        this.state.invTope = "";
        this.state.invEnlace = "";
    }

    cerrarInvitar() {
        this.state.invAbierto = false;
    }

    /** El precio SOLO cuando el asiento se va a cobrar. Si queda uno libre, ya
     *  esta pagado y enseñar un importe asusta sin motivo. */
    get costoAsiento() {
        const e = this.state.equipo || {};
        const c = e.capacity || {};
        if ((Number(c.available) || 0) > 0 || e.next_seat_price_usd == null) {
            return "";
        }
        const linea = String(_t("Seat %s — US$ %s / month"))
            .replace("%s", String((Number(c.total) || 0) + 1))
            .replace("%s", Number(e.next_seat_price_usd).toFixed(2));
        // ⛔ Y lo que se cobra HOY, que casi nunca es el mes entero: el asiento
        // se factura con el plan y muere con el, asi que sumarlo tres dias antes
        // de renovar cuesta tres dias. Enseñar solo el precio del mes hace que
        // el primer cobro no cuadre con lo que se leyo aqui.
        if (e.next_seat_prorated_usd == null) {
            return linea;
        }
        return linea + " · " + String(_t("US$ %s today, until it renews"))
            .replace("%s", Number(e.next_seat_prorated_usd).toFixed(2));
    }

    async enviarInvitacion() {
        const correo = (this.state.invEmail || "").trim();
        if (!correo || !correo.includes("@")) {
            this.notification.add(_t("Type the email of the person you want to invite."),
                                  { type: "warning" });
            return;
        }
        this.state.invBusy = true;
        try {
            const tope = parseInt(this.state.invTope, 10);
            const r = await this.orm.call("aski.account.link", "invite_seat", [{
                email: correo,
                role: this.state.invRol,
                monthly_credit_cap: isFinite(tope) && tope > 0 ? tope : null,
            }]);
            // El enlace se enseña UNA vez: despues solo queda su huella. Quien
            // invita tiene que poder pasarselo sin salir de Odoo.
            this.state.invEnlace = (r && r.invite_link) || "";
            this.state.invEmail = "";
            this.state.invAbierto = false;
            this.notification.add(_t("Invitation ready."), { type: "success" });
            await this.openTeam();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.invBusy = false;
        }
    }

    /** Quitar el asiento CORTA el acceso de una persona: se pregunta antes, aqui
     *  dentro, como en la app y en la web. Devolverlo va directo — sumar acceso
     *  no rompe nada. */
    pedirQuitar(p) {
        this.state.seatPorQuitar = p;
    }

    cancelarQuitar() {
        this.state.seatPorQuitar = null;
    }

    async _accionAsiento(p, fn) {
        this.state.seatBusyId = p.id;
        try {
            await fn();
            await this.openTeam();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.seatBusyId = null;
            this.state.seatPorQuitar = null;
        }
    }

    confirmarQuitar() {
        const p = this.state.seatPorQuitar;
        if (!p) {
            return;
        }
        return this._accionAsiento(p, () => this.orm.call(
            "aski.account.link", "set_seat_active", [p.id, false]));
    }

    devolverAsiento(p) {
        return this._accionAsiento(p, () => this.orm.call(
            "aski.account.link", "set_seat_active", [p.id, true]));
    }

    anularInvitacion(p) {
        return this._accionAsiento(p, () => this.orm.call(
            "aski.account.link", "cancel_seat_invite", [p.id]));
    }

    /** Lo que se le pregunta antes de cortarle el acceso a alguien: CON su
     *  correo delante, y diciendo que se puede devolver. */
    get textoQuitarAsiento() {
        const p = this.state.seatPorQuitar;
        return p
            ? String(_t("%s will stop being able to ask with this account. You can give the seat back whenever you want."))
                .replace("%s", p.email || "")
            : "";
    }

    async copiarEnlaceInvitacion() {
        try {
            await navigator.clipboard.writeText(this.state.invEnlace || "");
            this.notification.add(_t("Link copied."), { type: "success" });
        } catch {
            // Sin portapapeles el enlace sigue a la vista para copiarlo a mano:
            // no se molesta con un error por algo que no impide nada.
        }
    }

    cerrarEquipo() {
        this.state.equipoOpen = false;
    }

    async pedirMasCreditos() {
        if (this.state.creditosPedidos) {
            return;
        }
        try {
            const r = await this.orm.call("aski.account.link", "request_more_credits", []);
            this.state.creditosPedidos = true;
            this.notification.add(
                String(_t("We told %s.")).replace("%s", (r && r.owner_email) || ""),
                { type: "success" });
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        }
    }

    get esAsiento() {
        return !!(this.state.seat && this.state.seat.is_seat);
    }

    /** De quien es la cuenta en la que se sienta. */
    get textoAsientoCuenta() {
        const s = this.state.seat || {};
        return String(_t("You are using the account of %s. Your plan and credits are handled by whoever pays for it."))
            .replace("%s", s.owner_email || "");
    }

    /** Lo que lleva gastado, con su tope si lo tiene. */
    get textoAsientoConsumo() {
        const s = this.state.seat || {};
        const usado = Number(s.credits_used) || 0;
        const tope = Number(s.monthly_credit_cap);
        if (isFinite(tope) && tope > 0) {
            return String(_t("You have used %s of %s credits this period."))
                .replace("%s", String(usado)).replace("%s", String(tope));
        }
        return String(_t("You have used %s credits this period."))
            .replace("%s", String(usado));
    }

    /** La bolsa con el MISMO formato que el saldo de la cabecera: verla como
     *  "60000" en un sitio y "60.000" en otro se lee como dos cifras distintas. */
    get bolsaFmt() {
        const e = this.state.equipo || {};
        return this._agrupado(Number(e.pool_balance) || 0, 0);
    }

    get capacidadEquipo() {
        return (this.state.equipo && this.state.equipo.capacity) || null;
    }

    /** Cuanto ocupa cada tramo de la barra. */
    get pctAsientos() {
        const c = this.capacidadEquipo || {};
        const total = Math.max(1, Number(c.total) || 0);
        return {
            usados: Math.round(((Number(c.used) || 0) / total) * 100),
            invitados: Math.round(((Number(c.invited) || 0) / total) * 100),
        };
    }

    /** La leyenda, con PLURAL de verdad: "1 invitados" se lee mal y es el caso
     *  mas comun, porque se invita de uno en uno. */
    get leyendaAsientos() {
        const c = this.capacidadEquipo || {};
        const usados = Number(c.used) || 0;
        const invitados = Number(c.invited) || 0;
        const libres = Math.max(0, (Number(c.total) || 0) - usados - invitados);
        return {
            usados: usados === 1 ? String(_t("%s seat taken")).replace("%s", "1")
                                 : String(_t("%s seats taken")).replace("%s", String(usados)),
            invitados: invitados === 1 ? String(_t("%s invited")).replace("%s", "1")
                                    : String(_t("%s people invited")).replace("%s", String(invitados)),
            libres: libres === 1 ? String(_t("%s seat free")).replace("%s", "1")
                              : String(_t("%s seats free")).replace("%s", String(libres)),
        };
    }

    get textoCuotaPlan() {
        const e = this.state.equipo || {};
        if (!e.pool_total) {
            return "";
        }
        return String(_t("plan quota: %s")).replace("%s", this._agrupado(Number(e.pool_total) || 0, 0));
    }

    get personasEquipo() {
        return (this.state.equipo && this.state.equipo.seats) || [];
    }

    /** "de N", como en la app: la cifra grande es la ocupacion. */
    get textoDeTotal() {
        const c = this.capacidadEquipo || {};
        return String(_t("of %s")).replace("%s", String(Number(c.total) || 0));
    }

    /** Lo que consume cada persona, o su estado si todavia no entra. */
    subDePersona(p) {
        if (p.status === "invited") {
            return _t("Invited, not in yet");
        }
        if (p.status === "suspended") {
            return _t("No seat right now");
        }
        const usado = Number(p.credits_used) || 0;
        const tope = Number(p.monthly_credit_cap);
        const texto = (isFinite(tope) && tope > 0)
            ? String(_t("%s of %s credits this period"))
                .replace("%s", String(usado)).replace("%s", String(tope))
            : String(_t("%s credits this period")).replace("%s", String(usado));
        // ⛔ El `_t()` FUERA de la plantilla literal: dentro de un `${...}` el
        // extractor de Odoo no lo ve y la cadena nunca llega al catalogo. Salia
        // "Account owner" en ingles en medio de una hoja en español.
        const titular = _t("Account owner");
        return p.is_owner ? titular + " · " + texto : texto;
    }

    /** A quien tiene sentido ofrecerle pedir un asiento estando YA conectado:
     *  a quien su plan no le da equipo. Al titular de un plan con equipo no se le
     *  ofrece — el asiento lo da el, no lo pide. */
    get puedePedirAsiento() {
        const c = this.capacidadEquipo;
        return !this.esAsiento && !!c && !c.supported;
    }

    async openInsights() {
        // Cierra el panel de detalle de debajo, como las demas ventanas: dejarlo
        // abierto deja dos hojas apiladas y la de abajo se ve por los bordes.
        this.state.detailFor = null;
        this.state.insightsOpen = true;
        await this._cargarAvisos();
    }

    closeInsights() {
        this.state.insightsOpen = false;
        this.state.insightNewFor = null;
    }

    async _cargarAvisos() {
        this.state.insightsLoading = true;
        this.state.insightsErr = false;
        try {
            const r = await this.orm.call("aski.account.link", "list_insights", []);
            this.state.insights = r.insights || [];
            this.state.insightLimit = r.alert_limit ?? null;
            this.state.insightUsed = r.alert_used || 0;
            this.state.insightPorPersona = r.by_person || [];
            this.state.insightsErr = !r.ok;
        } catch {
            this.state.insightsErr = true;
        } finally {
            this.state.insightsLoading = false;
        }
    }

    async toggleInsight(f) {
        if (this.state.insightBusy) {
            return;
        }
        this.state.insightBusy = f.id;
        try {
            await this.orm.call("aski.account.link", "set_insight_enabled",
                                [f.id, !f.enabled]);
            await this._cargarAvisos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.insightBusy = null;
        }
    }

    async reanudarAviso(f) {
        this.state.insightBusy = f.id;
        try {
            await this.orm.call("aski.account.link", "resume_insight", [f.id]);
            this.notification.add(_t("Alert resumed."), { type: "success" });
            await this._cargarAvisos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.insightBusy = null;
        }
    }

    async borrarAviso(f) {
        this.state.insightBusy = f.id;
        try {
            await this.orm.call("aski.account.link", "delete_insight", [f.id]);
            this.notification.add(_t("Alert removed."), { type: "success" });
            await this._cargarAvisos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.insightBusy = null;
        }
    }

    // El alta nace de una respuesta que Aski YA resolvio: se guarda esa consulta
    // y el aviso la repite cada dia sin volver a pensarla. Por eso el boton vive
    // en la burbuja y no en un formulario en blanco.
    abrirAltaAviso(m) {
        // ⛔ CIERRA el panel de detalle antes de abrir la hoja del aviso. Sin
        // esto quedaban dos hojas apiladas: la nueva salia por DEBAJO de la que
        // ya estaba y parecia que el boton no habia hecho nada. Es la misma
        // regla que siguen el resto de ventanas del widget.
        this.state.detailFor = null;
        this.state.insightNewFor = m;
        this.state.insightHour = 8;
        this.state.insightFreq = "daily";
        this.state.insightsOpen = true;
    }

    async guardarAviso() {
        const m = this.state.insightNewFor;
        if (!m || this.state.insightSaving) {
            return;
        }
        this.state.insightSaving = true;
        try {
            await this.orm.call("aski.account.link", "create_insight", [{
                kind: "alert",
                title: (this._preguntaDe(m) || _t("Alert")).slice(0, 120),
                prompt: this._preguntaDe(m),
                message_id: m.backendId,
                frequency: this.state.insightFreq,
                send_hour_local: Number(this.state.insightHour) || 8,
            }]);
            this.state.insightNewFor = null;
            this.notification.add(
                _t("Saved. It will land in your Odoo inbox."), { type: "success" });
            await this._cargarAvisos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.insightSaving = false;
        }
    }

    // -----------------------------------------------------------------
    //  Los otros tres tipos de aviso
    // -----------------------------------------------------------------
    // ⛔ Las etiquetas son las MISMAS que la app y la web, copiadas de sus
    // catalogos. Tres nombres distintos para el mismo aviso segun donde lo mires
    // es lo que hace que nadie se fie de lo que lee.

    /** El aviso de ese tipo que ya existe en esta conexion, si lo hay. El resumen
     *  y el cierre son unicos: se encienden y se apagan, no se crean dos. */
    _avisoDe(kind) {
        return (this.state.insights || []).find((f) => f.kind === kind) || null;
    }

    /** La frecuencia con la MISMA palabra que la app (`insights_freq_*`). La fila
     *  enseñaba el valor crudo del backend ("daily"): ni traducido, ni lo que el
     *  usuario habia leido al crear el aviso. */
    etiquetaFrecuencia(f) {
        return {
            daily: _t("Every day"),
            weekdays: _t("Monday to Friday"),
            weekly: _t("Once a week"),
        }[f.frequency] || f.frequency;
    }

    /** La lista de abajo, SIN el resumen ni el cierre: esos dos son los
     *  interruptores de arriba y repetirlos era ruido. */
    get avisosListados() {
        return (this.state.insights || []).filter(
            (f) => f.kind !== "digest" && f.kind !== "closing");
    }

    /** "Hoy: <valor>" en UNA cadena, como en la app: partirla en dos nodos deja
     *  la mitad fuera del catalogo y sin traducir. */
    get textoHoy() {
        const m = this.metricaElegida;
        return m ? String(_t("Today: %s")).replace("%s", m.value) : "";
    }

    get resumenDiario() { return this._avisoDe("digest"); }
    get cierreDelDia() { return this._avisoDe("closing"); }

    async _alternarFijo(kind) {
        if (this.state.insightBusy) {
            return;
        }
        const fila = this._avisoDe(kind);
        this.state.insightBusy = fila ? fila.id : -1;
        try {
            if (fila) {
                await this.orm.call("aski.account.link", "set_insight_enabled",
                                    [fila.id, !fila.enabled]);
            } else {
                await this.orm.call("aski.account.link", "create_insight", [{
                    kind,
                    // La hora por defecto la eligen igual la app y la web: 8 para
                    // el resumen, 18 para el cierre. Cambiarla es un toque.
                    send_hour_local: kind === "closing" ? 18 : 8,
                    frequency: "daily",
                }]);
            }
            await this._cargarAvisos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.insightBusy = null;
        }
    }

    alternarResumen() { return this._alternarFijo("digest"); }
    alternarCierre() { return this._alternarFijo("closing"); }

    async abrirVigia() {
        this.state.newKind = "watch";
        this.state.catalogoCargando = true;
        this.state.watchMetric = "";
        this.state.watchOp = ">";
        this.state.watchValue = "";
        try {
            const r = await this.orm.call("aski.account.link", "watch_metrics", []);
            this.state.metricas = r.metrics || [];
            if (this.state.metricas.length) {
                this.state.watchMetric = this.state.metricas[0].id;
            }
        } catch {
            this.state.metricas = [];
        } finally {
            this.state.catalogoCargando = false;
        }
    }

    async abrirRecordatorio() {
        this.state.newKind = "reminder";
        this.state.catalogoCargando = true;
        this.state.remTopic = "";
        this.state.remDays = 3;
        try {
            const r = await this.orm.call("aski.account.link", "reminder_topics", []);
            this.state.temas = r.topics || [];
            if (this.state.temas.length) {
                this.state.remTopic = this.state.temas[0].id;
            }
        } catch {
            this.state.temas = [];
        } finally {
            this.state.catalogoCargando = false;
        }
    }

    cerrarAlta() {
        this.state.newKind = null;
        this.state.insightNewFor = null;
    }

    /** La metrica elegida, para poder enseñar su valor de hoy junto al umbral: sin
     *  eso, el numero que se teclea no tiene contra que compararse. */
    get metricaElegida() {
        return (this.state.metricas || []).find((m) => m.id === this.state.watchMetric) || null;
    }

    get esVariacion() {
        return ["%>", "%<"].includes(this.state.watchOp);
    }

    /** La unidad del umbral, pegada al campo. Sin esto se teclea un numero a
     *  secas contra una cifra que puede venir en dolares, en soles o en dias. */
    get sufijoLimite() {
        if (this.esVariacion) {
            return "%";
        }
        const m = this.metricaElegida;
        if (!m) {
            return "";
        }
        if (m.unit === "pct") {
            return "%";
        }
        if (m.unit === "days") {
            return _t("days");
        }
        // La moneda la decide el BACKEND por metrica; el widget no la adivina ni
        // la trae de la compania, que puede no ser la de la cifra.
        return m.currency || "";
    }

    /** Aviso cuando la cifra se enseña en VARIAS monedas.
     *
     *  El backend manda `value` ya formateado con todas ("$ … · S/ … · € …") pero
     *  `value_num` —y por tanto la comparacion— va en UNA sola, la de `currency`.
     *  Callarlo lleva a poner un limite pensando en la moneda equivocada. */
    get avisoMoneda() {
        if (this.esVariacion) {
            return "";
        }
        const m = this.metricaElegida;
        if (!m || m.unit !== "money" || !m.currency) {
            return "";
        }
        if (!String(m.value || "").includes("·")) {
            return "";
        }
        return String(_t("This figure comes in several currencies. The limit is compared against %s."))
            .replace("%s", m.currency);
    }

    async guardarVigia() {
        const valor = parseFloat(String(this.state.watchValue).replace(",", "."));
        if (!this.state.watchMetric || !isFinite(valor)) {
            this.notification.add(_t("Enter a number"), { type: "warning" });
            return;
        }
        this.state.insightSaving = true;
        try {
            const m = this.metricaElegida;
            await this.orm.call("aski.account.link", "create_insight", [{
                kind: "watch",
                title: (m && m.label) || _t("New watch"),
                watch_metric: this.state.watchMetric,
                watch_op: this.state.watchOp,
                watch_value: valor,
                watch_currency: (m && m.currency) || "",
                frequency: "daily",
                send_hour_local: 8,
            }]);
            this.state.newKind = null;
            this.notification.add(_t("Saved. It will land in your Odoo inbox."),
                                  { type: "success" });
            await this._cargarAvisos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.insightSaving = false;
        }
    }

    async guardarRecordatorio() {
        const dias = parseInt(this.state.remDays, 10);
        if (!this.state.remTopic || !isFinite(dias) || dias < 0 || dias > 365) {
            this.notification.add(_t("A whole number between 0 and 365"),
                                  { type: "warning" });
            return;
        }
        this.state.insightSaving = true;
        try {
            const t = (this.state.temas || []).find((x) => x.id === this.state.remTopic);
            await this.orm.call("aski.account.link", "create_insight", [{
                kind: "reminder",
                title: (t && t.label) || _t("New reminder"),
                reminder_topic: this.state.remTopic,
                reminder_days: dias,
                frequency: "daily",
                send_hour_local: 8,
            }]);
            this.state.newKind = null;
            this.notification.add(_t("Saved. It will land in your Odoo inbox."),
                                  { type: "success" });
            await this._cargarAvisos();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.insightSaving = false;
        }
    }

    // La pregunta que dio pie a la respuesta: es el mensaje de usuario anterior.
    // Sin ella el aviso no tiene que repetir.
    _preguntaDe(m) {
        const i = this.state.messages.indexOf(m);
        for (let k = i - 1; k >= 0; k--) {
            if (this.state.messages[k].role === "user") {
                // ⛔ El campo es `text`. Buscar `content` devolvia SIEMPRE vacio:
                // el alta salia sin la pregunta arriba y el backend la rechazaba
                // con «una alerta necesita su pregunta». Es decir, programar una
                // respuesta desde el conector no funciono nunca. Se aceptan los
                // dos nombres por si algun dia llega un mensaje de otra forma.
                const q = this.state.messages[k];
                return q.text || q.content || "";
            }
        }
        return "";
    }

    // =====================================================================
    //  Acciones sobre el ERP
    // =====================================================================
    async _cargarAcciones() {
        try {
            const r = await this.orm.call("aski.account.link", "list_actions", []);
            this.state.actions = r.actions || [];
            this.state.actionsEnabled = !!r.feature_enabled;
            this.state.actionsModeOk = r.mode_ok !== false;
        } catch {
            this.state.actions = [];
        }
    }

    // Confirmar SIEMPRE pregunta antes, y la pregunta es in-app: nunca
    // window.confirm. Lo que se ejecuta escribe en el ERP de verdad.
    pedirConfirmacion(a) {
        this.state.confirmActionId = a.id;
    }

    cancelarConfirmacion() {
        this.state.confirmActionId = null;
    }

    async confirmarAccion(a) {
        if (this.state.actionBusy) {
            return;
        }
        this.state.actionBusy = a.id;
        this.state.confirmActionId = null;
        try {
            const r = await this.orm.call("aski.account.link", "confirm_action", [a.id]);
            this.notification.add(r.result_message || _t("Done."), { type: "success" });
            await this._cargarAcciones();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.actionBusy = null;
        }
    }

    async descartarAccion(a) {
        this.state.actionBusy = a.id;
        try {
            await this.orm.call("aski.account.link", "cancel_action", [a.id]);
            await this._cargarAcciones();
        } catch (e) {
            this.notification.add(this._msgDe(e), { type: "danger", sticky: true });
        } finally {
            this.state.actionBusy = null;
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
