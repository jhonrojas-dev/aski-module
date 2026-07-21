/** @odoo-module **/
import { Component, useState, useRef, onWillStart, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";

// Markdown -> HTML minimo (bold, italic, code, listas, tablas GFM, blockquote,
// links). Misma cobertura que web/src/chat/MarkdownMessage.tsx (react-markdown
// + remark-gfm) y MISMAS clases CSS (.md, .md-table-wrap) para que Odoo se vea
// igual que la web/app — no se reinventa el formato, solo el motor (OWL no
// puede montar un componente React).
function _escapeHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function _inline(s) {
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a || b}</strong>`);
    s = s.replace(/\*([^*]+)\*/g, (_m, a) => `<em>${a}</em>`);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
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
        this.state = useState({
            loading: true,
            allowed: true,
            mode: "shared_group",
            canConnect: false,
            connected: false,
            walletCredits: 0,
            planName: "",
            messages: [],
            input: "",
            sending: false,
            conversationId: null,
            exporting: false,
            conversations: [],
            drawerOpen: false,
            detailFor: null,
        });
        onWillStart(async () => { await this.loadStatus(); });
    }

    async loadStatus() {
        this.state.loading = true;
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
            if (this.state.connected) {
                await this.refreshConversations();
                // Restaura el hilo MAS RECIENTE al recargar la pantalla — sin esto
                // el chat parecia perder todo el historial en cada F5.
                const latest = this.state.conversations[0];
                if (latest) await this.openConversation(latest.id);
            }
        } catch (e) {
            this.state.connected = false;
        } finally {
            this.state.loading = false;
        }
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

    openBilling() {
        window.open("https://app.aski.dev/billing", "_blank", "noopener,noreferrer");
    }

    onInput(ev) {
        this.state.input = ev.target.value;
    }

    onKeydown(ev) {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            this.send();
        }
    }

    async send() {
        const text = (this.state.input || "").trim();
        if (!text || this.state.sending) {
            return; // guarda contra doble tap / doble envio
        }
        this.state.input = "";
        this.state.messages.push({ id: `u${Date.now()}`, role: "user", text });
        await this._ask(text);
    }

    async retry(text) {
        if (this.state.sending) {
            return;
        }
        await this._ask(text);
    }

    async _ask(text) {
        this.state.sending = true;
        this._scrollToBottom();
        try {
            const isNewThread = !this.state.conversationId;
            const r = await this.orm.call("aski.account.link", "send_message",
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
            this.state.messages.push({ id: `e${Date.now()}`, role: "error", text: msg, retryText: text });
        } finally {
            this.state.sending = false;
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
