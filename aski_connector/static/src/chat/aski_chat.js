/** @odoo-module **/
import { Component, useState, useRef, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";

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
            this.state.messages.push({ id: `a${Date.now()}`, role: "assistant", text: r.answer || "" });
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
