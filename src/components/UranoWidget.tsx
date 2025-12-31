import React, { useEffect, useMemo, useRef, useState } from "react";
import { TbMessageChatbot } from "react-icons/tb";
import "../styles/uranoWidget.css";
import {
  streamChat,
  type ChatMessage,
  type AssistantPlan,
  type StreamEvent,
} from "../lib/uassistantClient";

type Msg = Readonly<{
  id: string;
  role: "assistant" | "user";
  text: string;
  plan?: AssistantPlan;
}>;

const MAX_HISTORY = 30;

const ACTIONABLE: ReadonlySet<AssistantPlan["actionType"]> = new Set([
  "STAKE",
  "UNSTAKE",
  "STAKE_ALL",
  "UNSTAKE_ALL",
  "BUY_USHARE",
  "SELL_USHARE",
  "VOTE",
  "CLAIM_UNLOCKED",
]);

function shortHex(v: string, head = 6, tail = 4): string {
  if (!v || v.length <= head + tail + 2) return v;
  return `${v.slice(0, 2 + head)}…${v.slice(v.length - tail)}`;
}

function actionLabel(actionType: AssistantPlan["actionType"]): string {
  switch (actionType) {
    case "STAKE":
      return "Stake";
    case "UNSTAKE":
      return "Unstake";
    case "STAKE_ALL":
      return "Stake all";
    case "UNSTAKE_ALL":
      return "Unstake all";
    case "BUY_USHARE":
      return "Buy uShare";
    case "SELL_USHARE":
      return "Sell uShare";
    case "VOTE":
      return "Governance vote";
    case "CLAIM_UNLOCKED":
      return "Claim unlocked";
    case "QUESTION":
      return "Info";
    case "UNSUPPORTED":
      return "Unavailable";
    default:
      return "Action";
  }
}

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

  const canSend = useMemo(
    () => input.trim().length > 0 && !isStreaming,
    [input, isStreaming]
  );

  function toggle(): void {
    setOpen((v) => !v);
  }

  function close(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setOpen(false);
  }

  function buildPayload(nextMsgs: readonly Msg[]): ChatMessage[] {
    const sliced = nextMsgs.slice(Math.max(0, nextMsgs.length - MAX_HISTORY));
    return sliced.map((m) => ({ role: m.role, content: m.text })) satisfies ChatMessage[];
  }

  function applyPlanToAssistantMessage(assistantId: string, plan: AssistantPlan): void {
    const shouldShowCard = ACTIONABLE.has(plan.actionType) && plan.tx !== null;

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== assistantId) return m;

        // For QUESTION/UNSUPPORTED or tx-less plans, show plain text only.
        if (!shouldShowCard) {
          return { ...m, plan: undefined, text: plan.userMessage ?? "" };
        }

        // For actionable tx plans, attach the plan and show the message + card.
        return { ...m, plan, text: plan.userMessage ?? "" };
      })
    );
  }

  function appendDeltaToAssistantMessage(assistantId: string, delta: string): void {
    if (!delta) return;

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== assistantId) return m;
        // If a plan card is present, ignore deltas to prevent duplicated text.
        if (m.plan) return m;
        return { ...m, text: m.text + delta };
      })
    );
  }

  function applyErrorToAssistantMessage(
    assistantId: string,
    error: string,
    message?: string
  ): void {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              text:
                m.text.trim().length > 0
                  ? m.text
                  : `Sorry — something went wrong (${error}${message ? `: ${message}` : ""}).`,
            }
          : m
      )
    );
  }

  async function startStreaming(payload: ChatMessage[], assistantId: string): Promise<void> {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setIsStreaming(true);

    try {
      await streamChat({
        messages: payload,
        signal: ac.signal,
        onEvent: (evt: StreamEvent) => {
          if (evt.type === "plan") {
            applyPlanToAssistantMessage(assistantId, evt.plan);
            return;
          }

          if (evt.type === "delta") {
            appendDeltaToAssistantMessage(assistantId, evt.delta);
            return;
          }

          if (evt.type === "error") {
            applyErrorToAssistantMessage(assistantId, evt.error, evt.message);
          }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!ac.signal.aborted) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  text: m.text.trim().length > 0 ? m.text : `Sorry — streaming failed: ${msg}`,
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

    setMessages((prev) => [...prev, userMsg, assistantPlaceholder]);
    setInput("");

    const nextForPayload = [...messages, userMsg];
    const payload = buildPayload(nextForPayload);

    void startStreaming(payload, assistantId);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") onSend();
  }

  function renderAssistantPlan(plan: AssistantPlan): React.ReactElement {
    // Safety: we only call this when ACTIONABLE + tx exists, but keep it robust.
    if (!plan.tx) return <></>;

    const label = actionLabel(plan.actionType);

    return (
      <div
        style={{
          marginTop: 10,
          borderRadius: 14,
          border: "1px solid var(--card-border-1)",
          background: "rgba(0,0,0,0.20)",
          padding: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 13, color: "var(--text-primary)" }}>
            {label} preview
          </div>

          <div
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 999,
              border: "1px solid var(--card-border-1)",
              color: "var(--text-secondary)",
              background: "rgba(0,0,0,0.22)",
              whiteSpace: "nowrap",
            }}
          >
            {plan.actionType}
          </div>
        </div>

        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>
          {plan.interpretation}
        </div>

        {plan.warnings?.length > 0 && (
          <div
            style={{
              marginTop: 10,
              borderRadius: 12,
              border: "1px solid rgba(255, 170, 0, 0.30)",
              background: "rgba(255, 170, 0, 0.08)",
              padding: 10,
              fontSize: 12,
              color: "var(--text-primary)",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Warnings</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {plan.warnings.map((w, i) => (
                <li key={`${w}-${i}`}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div
          style={{
            marginTop: 10,
            borderRadius: 12,
            border: "1px solid var(--card-border-1)",
            background: "rgba(0,0,0,0.18)",
            padding: 10,
            fontSize: 12,
            color: "var(--text-primary)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Transaction</div>

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ color: "var(--text-secondary)" }}>Chain</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {plan.tx.chainId}
              </span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ color: "var(--text-secondary)" }}>To</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {shortHex(plan.tx.to)}
              </span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ color: "var(--text-secondary)" }}>Value</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {plan.tx.value}
              </span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ color: "var(--text-secondary)" }}>Data</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {shortHex(plan.tx.data, 10, 8)}
              </span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          <button
            type="button"
            disabled
            title="Next step: we will connect this to the wallet"
            style={{
              height: 38,
              padding: "0 12px",
              borderRadius: 12,
              border: "1px solid rgba(94, 187, 195, 0.35)",
              background: "rgba(94, 187, 195, 0.12)",
              color: "var(--text-primary)",
              fontWeight: 800,
              cursor: "not-allowed",
              opacity: 0.75,
            }}
          >
            Send to wallet (next)
          </button>

          {plan.docsUrl ? (
            <a
              href={plan.docsUrl}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: "var(--text-secondary)" }}
            >
              Docs
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="uw-shell">
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

                {m.role === "assistant" && m.plan ? renderAssistantPlan(m.plan) : null}
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
            <button className="uw-send" onClick={onSend} disabled={!canSend} type="button">
              Send
            </button>
          </div>
        </div>
      </div>

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
