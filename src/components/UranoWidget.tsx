import React, { useEffect, useMemo, useRef, useState } from "react";
import { TbMessageChatbot } from "react-icons/tb";
import "../styles/uranoWidget.css";
import { streamChat, type ChatMessage } from "../lib/uassistantClient";

type Msg = Readonly<{
  id: string;
  role: "assistant" | "user";
  text: string;
}>;

const MAX_HISTORY = 30;

export default function UranoWidget(): React.ReactElement {
  const [open, setOpen] = useState<boolean>(true);
  const [input, setInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [messages, setMessages] = useState<Msg[]>(() => [
    {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "Hello. How can I help you today?",
    },
  ]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messages.length]);

  const canSend = useMemo(() => input.trim().length > 0 && !isStreaming, [input, isStreaming]);

  function toggle(): void {
    setOpen((v) => !v);
  }

  function close(): void {
    // Abort any in-flight stream when user closes the widget
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setOpen(false);
  }

  function buildPayload(nextMsgs: readonly Msg[]): ChatMessage[] {
    const sliced = nextMsgs.slice(Math.max(0, nextMsgs.length - MAX_HISTORY));
    return sliced.map((m) => ({ role: m.role, content: m.text })) satisfies ChatMessage[];
  }

  async function startStreaming(payload: ChatMessage[], assistantId: string): Promise<void> {
    // Cancel previous stream if any
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setIsStreaming(true);

    try {
      await streamChat({
        messages: payload,
        signal: ac.signal,
        onEvent: (evt) => {
          if (evt.type === "delta") {
            const delta = evt.delta ?? "";
            if (!delta) return;

            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, text: m.text + delta } : m
              )
            );
          }

          if (evt.type === "error") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      text:
                        m.text.trim().length > 0
                          ? m.text
                          : `Sorry — something went wrong (${evt.error}${evt.message ? `: ${evt.message}` : ""}).`,
                    }
                  : m
              )
            );
          }

          if (evt.type === "done") {
            // handled below in finally as well, but safe
          }
        },
      });
    } catch (err) {
      // If aborted by user action, do not show an error
      const msg = err instanceof Error ? err.message : String(err);
      if (!ac.signal.aborted) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  text:
                    m.text.trim().length > 0
                      ? m.text
                      : `Sorry — streaming failed: ${msg}`,
                }
              : m
          )
        );
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setIsStreaming(false);
    }
  }

  function onSend(): void {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", text };
    const assistantId = crypto.randomUUID();
    const assistantPlaceholder: Msg = { id: assistantId, role: "assistant", text: "" };

    // Optimistically update UI
    setMessages((prev) => [...prev, userMsg, assistantPlaceholder]);
    setInput("");

    // Build payload from the *next* message list (prev + user), but WITHOUT the empty assistant placeholder
    const nextForPayload = [...messages, userMsg];
    const payload = buildPayload(nextForPayload);

    void startStreaming(payload, assistantId);
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
              <div className="uw-subtitle">Ask about uShare sales, staking, governance.</div>
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
                  m.role === "assistant" ? "uw-msg-assistant" : "uw-msg-user",
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
              placeholder={isStreaming ? "Assistant is typing…" : "Type a message…"}
              disabled={isStreaming}
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
        type="button"
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
