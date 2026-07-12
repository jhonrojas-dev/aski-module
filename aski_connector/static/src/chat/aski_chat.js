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
        if (/^>\s?/.test(line)) {
            const buf = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
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
        while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|[-*]\s|\d+\.\s|>\s?|```)/.test(lines[i]) && !_isTableStart(lines, i)) {
            buf.push(lines[i]);
            i++;
        }
        out.push(`<p>${_inline(buf.join("<br/>"))}</p>`);
    }
    return out.join("");
}

export class AskiChatWidget extends Component {
    static template = "aski_connector.ChatWidget";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.messagesRef = useRef("messages");
        this.state = useState({
            loading: true,
            connected: false,
            walletCredits: 0,
            planName: "",
            messages: [],
            input: "",
            sending: false,
            conversationId: null,
        });
        onWillStart(async () => { await this.loadStatus(); });
    }

    async loadStatus() {
        this.state.loading = true;
        try {
            const st = await this.orm.call("aski.account.link", "get_status", []);
            this.state.connected = !!st.connected;
            this.state.walletCredits = st.wallet_credits || 0;
            this.state.planName = st.plan_name || "";
        } catch (e) {
            this.state.connected = false;
        } finally {
            this.state.loading = false;
        }
    }

    renderMd(text) {
        return markup(mdToHtml(text));
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
            const r = await this.orm.call("aski.account.link", "send_message",
                [text, this.state.conversationId]);
            if (r.conversation_id) {
                this.state.conversationId = r.conversation_id;
            }
            this.state.messages.push({
                id: `a${Date.now()}`, role: "assistant", text: r.answer || "",
                credits: typeof r.credits === "number" ? r.credits : null,
            });
            if (typeof r.credits === "number") {
                this.state.walletCredits = Math.max(0, this.state.walletCredits - r.credits);
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
