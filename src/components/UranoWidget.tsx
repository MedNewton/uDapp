// src/components/UranoWidget.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { TbMessageChatbot } from "react-icons/tb";
import "../styles/uranoWidget.css";

import {
  streamChat,
  type ChatMessage,
  type StreamEvent,
  type AssistantPlan,
} from "../lib/uassistantClient";

import { thirdwebClient } from "../lib/thidwebClient";
import {
  ConnectButton,
  useActiveAccount,
  useActiveWalletChain,
  useSendTransaction,
  useSwitchActiveWalletChain,
} from "thirdweb/react";
import { defineChain, prepareTransaction } from "thirdweb";

/* ----------------------------- Types ----------------------------- */

type MsgRole = "assistant" | "user";
type MsgKind = "normal" | "status" | "error";

type Msg = Readonly<{
  id: string;
  role: MsgRole;
  kind: MsgKind;
  text: string;
  /**
   * Only attach plan when it is ACTIONABLE (plan.tx !== null and not QUESTION/UNSUPPORTED).
   * This prevents a “card” for messages like "hi".
   */
  plan?: AssistantPlan;
}>;

type SendTxResult = Readonly<{ transactionHash: `0x${string}` }>;

type RpcReceipt = Readonly<{
  status?: `0x${string}`; // "0x1" success, "0x0" revert
  transactionHash: `0x${string}`;
}>;

type JsonRpcResponse<T> = Readonly<{
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}>;

const MAX_HISTORY = 30;

/* ----------------------------- Helpers ----------------------------- */

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

/** Only show a card when plan is actionable. */
function isActionablePlan(plan: AssistantPlan): boolean {
  if (!plan.tx) return false;
  if (plan.actionType === "QUESTION") return false;
  if (plan.actionType === "UNSUPPORTED") return false;
  return true;
}

/** Extract first uint256 arg from calldata: 0x + 4-byte selector + 32-byte arg0 + ... */
function decodeFirstUint256Arg(data: `0x${string}`): bigint {
  if (data.length < 10 + 64) throw new Error("Invalid calldata (too short)");
  const arg0 = data.slice(10, 10 + 64);
  return BigInt(`0x${arg0}`);
}

function extractErrorSignature(message: string): string | null {
  const m = message.match(/0x[a-fA-F0-9]{8}/);
  return m ? m[0] : null;
}

function isSendTxResult(v: unknown): v is SendTxResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const h = r["transactionHash"];
  return typeof h === "string" && h.startsWith("0x");
}

function isHexAddress(v: string): v is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

function encodeErc20Approve(spender: `0x${string}`, amount: bigint): `0x${string}` {
  // approve(address,uint256) selector = 0x095ea7b3
  const selector = "0x095ea7b3";
  const spenderPadded = spender.slice(2).padStart(64, "0");
  const amountPadded = amount.toString(16).padStart(64, "0");
  return `${selector}${spenderPadded}${amountPadded}` as `0x${string}`;
}

const MAX_UINT256 = 2n ** 256n - 1n;

async function rpcGetReceipt(args: Readonly<{ rpcUrl: string; txHash: `0x${string}`; signal?: AbortSignal }>): Promise<RpcReceipt | null> {
  const payload = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "eth_getTransactionReceipt",
    params: [args.txHash],
  };

  const res = await fetch(args.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: args.signal,
  });

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

  const json = (await res.json()) as JsonRpcResponse<RpcReceipt | null>;
  if (json.error) throw new Error(json.error.message);
  return json.result ?? null;
}

async function waitForReceipt(args: Readonly<{ rpcUrl: string; txHash: `0x${string}`; signal?: AbortSignal }>): Promise<RpcReceipt> {
  const maxTries = 60;
  let delayMs = 1200;

  for (let i = 0; i < maxTries; i += 1) {
    const r = await rpcGetReceipt(args);
    if (r) return r;

    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => resolve(), delayMs);
      args.signal?.addEventListener(
        "abort",
        () => {
          window.clearTimeout(t);
          reject(new Error("Aborted"));
        },
        { once: true }
      );
    });

    delayMs = Math.min(2000, Math.floor(delayMs * 1.15));
  }

  throw new Error("Timed out waiting for transaction receipt");
}

/* ----------------------------- Component ----------------------------- */

export default function UranoWidget(): React.ReactElement {
  const [open, setOpen] = useState<boolean>(true);
  const [input, setInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [isSendingTx, setIsSendingTx] = useState<boolean>(false);

  const [messages, setMessages] = useState<Msg[]>(() => [
    { id: crypto.randomUUID(), role: "assistant", kind: "normal", text: "Hello. How can I help you today?" },
  ]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Thirdweb
  const account = useActiveAccount();
  const walletChain = useActiveWalletChain();
  const switchChain = useSwitchActiveWalletChain();
  const { mutateAsync: sendTx } = useSendTransaction();

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
    return sliced
      .filter((m) => m.kind === "normal") // Only send real conversation content to the planner
      .map((m) => ({ role: m.role, content: m.text })) satisfies ChatMessage[];
  }

  function pushMessage(msg: Msg): void {
    setMessages((prev) => [...prev, msg]);
  }

  function pushAssistantStatus(text: string): void {
    pushMessage({ id: crypto.randomUUID(), role: "assistant", kind: "status", text });
  }

  function pushAssistantError(text: string): void {
    pushMessage({ id: crypto.randomUUID(), role: "assistant", kind: "error", text });
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
            const plan = evt.plan;

            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId) return m;

                // always show assistant text (even if non-actionable)
                const text = plan.userMessage ?? "";

                // attach plan ONLY if actionable => card only for real transactions
                if (isActionablePlan(plan)) return { ...m, text, plan };

                // ensure plan is removed for non-actionable ("hi", questions, unsupported)
                return { ...m, text, plan: undefined };
              })
            );
            return;
          }

          if (evt.type === "delta") {
            const delta = evt.delta ?? "";
            if (!delta) return;

            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId) return m;
                if (m.plan) return m; // ignore deltas once a plan card is attached
                return { ...m, text: m.text + delta };
              })
            );
            return;
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
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!ac.signal.aborted) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text: m.text.trim().length > 0 ? m.text : `Sorry — streaming failed: ${msg}` }
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

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", kind: "normal", text };
    const assistantId = crypto.randomUUID();
    const assistantPlaceholder: Msg = { id: assistantId, role: "assistant", kind: "normal", text: "" };

    setMessages((prev) => [...prev, userMsg, assistantPlaceholder]);
    setInput("");

    // Build payload from the messages that will exist next (prev + userMsg),
    // and do NOT include the empty assistant placeholder.
    const nextForPayload = [...messages, userMsg];
    const payload = buildPayload(nextForPayload);

    void startStreaming(payload, assistantId);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") onSend();
  }

  async function sendPlanToWallet(plan: AssistantPlan): Promise<void> {
    if (!plan.tx) throw new Error("No transaction to send.");
    if (!account) throw new Error("Connect your wallet first.");

    const chain = defineChain(plan.tx.chainId);

    if (!walletChain || walletChain.id !== plan.tx.chainId) {
      await switchChain(chain);
    }

    const rpcUrlRaw = (import.meta.env.VITE_RPC_URL as string | undefined)?.trim();
    const rpcUrl = rpcUrlRaw && rpcUrlRaw.length > 0 ? rpcUrlRaw : "https://sepolia.base.org";

    // -------- 1) Pre-approval steps --------

    // A) STAKE => approve URANO to staking contract for exact stake amount
    if (plan.actionType === "STAKE") {
      const tokenRaw = (import.meta.env.VITE_URANO_TOKEN as string | undefined)?.trim();
      if (!tokenRaw || !isHexAddress(tokenRaw)) {
        throw new Error("Missing/invalid VITE_URANO_TOKEN in frontend env.");
      }

      const stakeAmountWei = decodeFirstUint256Arg(plan.tx.data);

      const approveTx = prepareTransaction({
        client: thirdwebClient,
        chain,
        to: tokenRaw,
        data: encodeErc20Approve(plan.tx.to, stakeAmountWei),
        value: 0n,
      });

      const approveRes = await sendTx(approveTx);
      if (!isSendTxResult(approveRes)) throw new Error("Unexpected approve result (missing transactionHash).");

      const approveReceipt = await waitForReceipt({ rpcUrl, txHash: approveRes.transactionHash });
      if (approveReceipt.status && approveReceipt.status !== "0x1") {
        throw new Error(`Approve reverted (status=${approveReceipt.status}).`);
      }
    }

    // B) BUY_USHARE => approve USDC to market contract (spender = plan.tx.to)
    if (plan.actionType === "BUY_USHARE") {
      const usdcRaw = (import.meta.env.VITE_USDC_TOKEN as string | undefined)?.trim();
      if (!usdcRaw || !isHexAddress(usdcRaw)) {
        throw new Error("Missing/invalid VITE_USDC_TOKEN in frontend env.");
      }

      const approveTx = prepareTransaction({
        client: thirdwebClient,
        chain,
        to: usdcRaw,
        data: encodeErc20Approve(plan.tx.to, MAX_UINT256),
        value: 0n,
      });

      const approveRes = await sendTx(approveTx);
      if (!isSendTxResult(approveRes)) throw new Error("Unexpected approve result (missing transactionHash).");

      const approveReceipt = await waitForReceipt({ rpcUrl, txHash: approveRes.transactionHash });
      if (approveReceipt.status && approveReceipt.status !== "0x1") {
        throw new Error(`USDC approve reverted (status=${approveReceipt.status}).`);
      }
    }

    // -------- 2) Send the planned tx --------

    const tx = prepareTransaction({
      client: thirdwebClient,
      chain,
      to: plan.tx.to,
      data: plan.tx.data,
      value: BigInt(plan.tx.value),
    });

    const res = await sendTx(tx);
    if (!isSendTxResult(res)) throw new Error("Unexpected send result (missing transactionHash).");

    const receipt = await waitForReceipt({ rpcUrl, txHash: res.transactionHash });
    if (receipt.status && receipt.status !== "0x1") {
      throw new Error(`Transaction reverted (status=${receipt.status}).`);
    }
  }

  async function onClickSendToWallet(plan: AssistantPlan): Promise<void> {
    if (!plan.tx) return;

    setIsSendingTx(true);
    try {
      // IMPORTANT: independent message (not appended to the plan message)
      pushAssistantStatus("Preparing transaction…");

      await sendPlanToWallet(plan);

      // IMPORTANT: independent message (not appended)
      pushAssistantStatus("Transaction confirmed.");
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const sig = extractErrorSignature(raw);
      const extra = sig ? `\nRevert selector: ${sig}\nLookup: https://openchain.xyz/signatures?query=${sig}` : "";

      // IMPORTANT: independent ERROR message (not appended)
      pushAssistantError(`Could not send transaction: ${raw}${extra}`);
    } finally {
      setIsSendingTx(false);
    }
  }

  function renderAssistantPlan(plan: AssistantPlan): React.ReactElement {
    if (!plan.tx) return <></>;

    const label = actionLabel(plan.actionType);
    const canSendWallet = Boolean(account) && !isSendingTx;

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
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13, color: "var(--text-primary)" }}>{label} preview</div>

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

        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>{plan.interpretation}</div>

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
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{plan.tx.chainId}</span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ color: "var(--text-secondary)" }}>To</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{shortHex(plan.tx.to)}</span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ color: "var(--text-secondary)" }}>Value</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{plan.tx.value}</span>
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
            disabled={!canSendWallet}
            onClick={() => void onClickSendToWallet(plan)}
            style={{
              height: 38,
              padding: "0 12px",
              borderRadius: 12,
              border: "1px solid rgba(94, 187, 195, 0.35)",
              background: "rgba(94, 187, 195, 0.12)",
              color: "var(--text-primary)",
              fontWeight: 800,
              cursor: canSendWallet ? "pointer" : "not-allowed",
              opacity: canSendWallet ? 1 : 0.6,
            }}
          >
            {isSendingTx ? "Sending…" : account ? "Send to wallet" : "Connect wallet first"}
          </button>

          {plan.docsUrl ? (
            <a href={plan.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Docs
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  function msgClassName(m: Msg): string {
    const base = ["uw-msg", m.role === "assistant" ? "uw-msg-assistant" : "uw-msg-user"];
    if (m.kind === "status") base.push("uw-msg-status");
    if (m.kind === "error") base.push("uw-msg-error");
    return base.join(" ");
  }

  return (
    <div className="uw-shell">
      {/* WIDGET */}
      <div className={`uw-panel ${open ? "is-open" : "is-closed"}`}>
        <div className="uw-card gradient-border glass">
          <div
            className="uw-header"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
          >
            <div>
              <div className="uw-title">URANO Assistant</div>
              <div className="uw-subtitle">Ask about uShare sales, staking, governance.</div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ConnectButton client={thirdwebClient} />
              <button className="uw-x" onClick={close} aria-label="Close chat" type="button">
                <span className="uw-xIcon" aria-hidden>
                  ×
                </span>
              </button>
            </div>
          </div>

          <div className="uw-messages" ref={listRef}>
            {messages.map((m) => (
              <div key={m.id} className={msgClassName(m)}>
                {m.text}

                {/* Card renders ONLY if plan exists AND plan.tx exists */}
                {m.role === "assistant" && m.kind === "normal" && m.plan?.tx ? renderAssistantPlan(m.plan) : null}
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
