import React, { useEffect, useMemo, useRef, useState } from "react";
import { TbMessageChatbot } from "react-icons/tb";
import "../styles/uranoWidget.css";

type Msg = Readonly<{
    id: string;
    role: "assistant" | "user";
    text: string;
}>;

export default function UranoWidget(): React.ReactElement {
    const [open, setOpen] = useState<boolean>(true);
    const [input, setInput] = useState<string>("");
    const [messages, setMessages] = useState<Msg[]>(() => [
        {
            id: crypto.randomUUID(),
            role: "assistant",
            text: "Hello. How can I help you today?",
        },
    ]);

    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const el = listRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [open, messages.length]);

    const canSend = useMemo(() => input.trim().length > 0, [input]);

    function toggle(): void {
        setOpen((v) => !v);
    }

    function close(): void {
        setOpen(false);
    }

    function onSend(): void {
        const text = input.trim();
        if (!text) return;

        setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "user", text },
            {
                id: crypto.randomUUID(),
                role: "assistant",
                text: "Noted. (Backend not wired yet.)",
            },
        ]);
        setInput("");
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
        if (e.key === "Enter") onSend();
    }

    return (
        <div className="uw-shell">
            {/* WIDGET */}
            <div className={`uw-panel ${open ? "is-open" : "is-closed"}`}>
                <div className="uw-card gradient-border glass">
                    <div className="uw-header">
                        <div>
                            <div className="uw-title">URANO Assistant</div>
                            <div className="uw-subtitle">
                                Ask about uShare sales, staking, governance.
                            </div>
                        </div>

                        <button className="uw-x" onClick={close} aria-label="Close chat" type="button">
                            <span className="uw-xIcon" aria-hidden>
                                ×
                            </span>
                        </button>

                    </div>

                    <div className="uw-messages" ref={listRef}>
                        {messages.map((m) => (
                            <div
                                key={m.id}
                                className={[
                                    "uw-msg",
                                    m.role === "assistant"
                                        ? "uw-msg-assistant"
                                        : "uw-msg-user",
                                ].join(" ")}
                            >
                                {m.text}
                            </div>
                        ))}
                    </div>

                    <div className="uw-inputRow">
                        <input
                            className="uw-input"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="Type a message…"
                        />
                        <button className="uw-send" onClick={onSend} disabled={!canSend}>
                            Send
                        </button>
                    </div>
                </div>
            </div>

            {/* FAB */}
            <button
                className={`uw-fab ${open ? "is-open" : ""}`}
                onClick={toggle}
                aria-label={open ? "Close chat" : "Open chat"}
                title={open ? "Close" : "Open"}
            >
                {open ? (
                    <span className="uw-fab-icon" aria-hidden>
                        ×
                    </span>
                ) : (
                    <TbMessageChatbot className="uw-fab-icon" aria-hidden />
                )}
            </button>
        </div>
    );
}
