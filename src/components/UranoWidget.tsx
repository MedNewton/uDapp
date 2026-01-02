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

type MsgRole = "assistant" | "user" | "system" | "error";

type Msg = Readonly<{
  id: string;
  role: MsgRole;
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

type HexAddress = `0x${string}`;

const MAX_HISTORY = 30;

const MAX_UINT256 = 2n ** 256n - 1n;

/* ----------------------------- Helpers ----------------------------- */

function uid(): string {
  return crypto.randomUUID();
}

function shortHex(v: string, head = 6, tail = 4): string {
  if (!v || v.length <= head + tail + 2) return v;
  return `${v.slice(0, 2 + head)}…${v.slice(v.length - tail)}`;
}

function isHexAddress(v: string): v is HexAddress {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
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
  // "0x" + 8 hex selector = 10 chars, then arg0 64 hex chars
  if (data.length < 10 + 64) throw new Error("Invalid calldata (too short)");
  const arg0 = data.slice(10, 10 + 64);
  return BigInt(`0x${arg0}`);
}

function extractErrorSelector(message: string): string | null {
  const m = message.match(/0x[a-fA-F0-9]{8}/);
  return m ? m[0] : null;
}

function isSendTxResult(v: unknown): v is SendTxResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const h = r["transactionHash"];
  return typeof h === "string" && h.startsWith("0x");
}

function encodeErc20Approve(spender: HexAddress, amount: bigint): `0x${string}` {
  // approve(address,uint256) selector = 0x095ea7b3
  const selector = "0x095ea7b3";
  const spenderPadded = spender.slice(2).padStart(64, "0");
  const amountPadded = amount.toString(16).padStart(64, "0");
  return `${selector}${spenderPadded}${amountPadded}` as `0x${string}`;
}

/* ---------- Minimal ERC20 reads via RPC (balanceOf / allowance) ---------- */

function encodeBalanceOf(owner: HexAddress): `0x${string}` {
  // balanceOf(address) selector = 0x70a08231
  const selector = "0x70a08231";
  const ownerPadded = owner.slice(2).padStart(64, "0");
  return `${selector}${ownerPadded}` as `0x${string}`;
}

function encodeAllowance(owner: HexAddress, spender: HexAddress): `0x${string}` {
  // allowance(address,address) selector = 0xdd62ed3e
  const selector = "0xdd62ed3e";
  const ownerPadded = owner.slice(2).padStart(64, "0");
  const spenderPadded = spender.slice(2).padStart(64, "0");
  return `${selector}${ownerPadded}${spenderPadded}` as `0x${string}`;
}

function parseUint256Hex(result: unknown): bigint {
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error("Bad RPC result (expected 0x...)");
  }
  if (result === "0x") return 0n;
  return BigInt(result);
}

function pickRpcUrls(): string[] {
  // Prefer your env, then Base Sepolia defaults + fallback publicnode.
  const envRpc = (import.meta.env.VITE_RPC_URL as string | undefined)?.trim();
  const list = [
    envRpc && envRpc.length > 0 ? envRpc : null,
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
  ].filter(Boolean) as string[];

  // de-dupe
  return Array.from(new Set(list));
}

async function rpcRequest<T>(
  rpcUrl: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) throw new Error(json.error.message);
  if (!("result" in json)) throw new Error("RPC missing result");
  return json.result as T;
}

async function rpcCallWithFallback<T>(
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ rpcUrl: string; result: T }> {
  const rpcs = pickRpcUrls();
  let lastErr: unknown = null;

  for (const rpcUrl of rpcs) {
    try {
      const result = await rpcRequest<T>(rpcUrl, payload, signal);
      return { rpcUrl, result };
    } catch (e) {
      lastErr = e;
    }
  }

  throw (lastErr instanceof Error ? lastErr : new Error("All RPCs failed"));
}

async function rpcGetReceipt(args: Readonly<{ txHash: `0x${string}`; signal?: AbortSignal }>): Promise<{ rpcUrl: string; receipt: RpcReceipt | null }> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getTransactionReceipt",
    params: [args.txHash],
  };

  const { rpcUrl, result } = await rpcCallWithFallback<RpcReceipt | null>(payload, args.signal);
  return { rpcUrl, receipt: result ?? null };
}

async function waitForReceipt(args: Readonly<{ txHash: `0x${string}`; signal?: AbortSignal }>): Promise<{ rpcUrl: string; receipt: RpcReceipt }> {
  const maxTries = 60;
  let delayMs = 1200;

  for (let i = 0; i < maxTries; i += 1) {
    const { rpcUrl, receipt } = await rpcGetReceipt({ txHash: args.txHash, signal: args.signal });
    if (receipt) return { rpcUrl, receipt };

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

function sanitizeTxError(raw: string): { headline: string; detail?: string } {
  // Common viem/thirdweb decode message for custom errors
  if (raw.includes("Encoded error signature") || raw.includes("decodeErrorResult")) {
    const sel = extractErrorSelector(raw);
    const headline = sel
      ? `Transaction reverted with a custom contract error (${sel}).`
      : "Transaction reverted with a custom contract error.";
    const detail =
      sel
        ? `This is a revert coming from the contract. The ABI you have locally doesn’t include this custom error, so it cannot be decoded.\n\nNext checks: (1) confirm you have enough token balance, (2) confirm URANO token + staking addresses are correct for this chain, (3) confirm staking is active/not paused.\n\nLookup: https://openchain.xyz/signatures?query=${sel}`
        : `This is a revert coming from the contract. Next checks: balance, addresses, paused/active state.`;
    return { headline, detail };
  }

  // Default
  return { headline: raw };
}

/* ----------------------------- Component ----------------------------- */

export default function UranoWidget(): React.ReactElement {
  const [open, setOpen] = useState<boolean>(true);
  const [input, setInput] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [isSendingTx, setIsSendingTx] = useState<boolean>(false);

  const [messages, setMessages] = useState<Msg[]>(() => [
    { id: uid(), role: "assistant", text: "Hello. How can I help you today?" },
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

  const canSend = useMemo(() => input.trim().length > 0 && !isStreaming, [input, isStreaming]);

  function pushMessage(msg: Msg): void {
    setMessages((prev) => [...prev, msg]);
  }

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
    const sliced = nextMsgs
      .filter((m) => m.role === "user" || m.role === "assistant") // only chat roles go to LLM
      .slice(Math.max(0, nextMsgs.length - MAX_HISTORY));

    return sliced.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.text,
    })) satisfies ChatMessage[];
  }

  async function startStreaming(payload: ChatMessage[], assistantId: string): Promise<void> {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setIsStreaming(true);

    // CRITICAL FIX: once we receive a "plan" event, we ignore any subsequent "delta"
    // (your backend currently emits plan -> delta(out.userMessage), which otherwise duplicates text)
    let planReceived = false;

    try {
      await streamChat({
        messages: payload,
        signal: ac.signal,
        onEvent: (evt: StreamEvent) => {
          if (evt.type === "plan") {
            planReceived = true;

            const plan = evt.plan;

            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId) return m;

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
            // Ignore deltas after plan to prevent duplicates
            if (planReceived) return;

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
            // Do not append into the assistant text; create a separate error message
            pushMessage({
              id: uid(),
              role: "error",
              text: `Assistant error: ${evt.error}${evt.message ? ` — ${evt.message}` : ""}`,
            });
          }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!ac.signal.aborted) {
        pushMessage({ id: uid(), role: "error", text: `Streaming failed: ${msg}` });
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setIsStreaming(false);
    }
  }

  function onSend(): void {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: Msg = { id: uid(), role: "user", text };
    const assistantId = uid();
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

  async function erc20ReadUint256(args: {
    token: HexAddress;
    data: `0x${string}`;
  }): Promise<bigint> {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: args.token,
          data: args.data,
        },
        "latest",
      ],
    };

    const { result } = await rpcCallWithFallback<`0x${string}`>(payload);
    return parseUint256Hex(result);
  }

  async function preflightStake(args: {
    token: HexAddress;
    owner: HexAddress;
    spender: HexAddress;
    amountWei: bigint;
  }): Promise<void> {
    const [bal, allow] = await Promise.all([
      erc20ReadUint256({ token: args.token, data: encodeBalanceOf(args.owner) }),
      erc20ReadUint256({ token: args.token, data: encodeAllowance(args.owner, args.spender) }),
    ]);

    if (bal < args.amountWei) {
      throw new Error(
        `Insufficient URANO balance. You have ${bal.toString()} wei, need ${args.amountWei.toString()} wei.`
      );
    }

    // allowance check is still useful after approve (in case approve was for a different spender/token)
    if (allow < args.amountWei) {
      throw new Error(
        `Allowance is still insufficient after approval. Allowance=${allow.toString()} wei, need ${args.amountWei.toString()} wei.`
      );
    }
  }

  async function sendPlanToWallet(plan: AssistantPlan): Promise<void> {
    if (!plan.tx) throw new Error("No transaction to send.");
    if (!account?.address) throw new Error("Connect your wallet first.");

    const chain = defineChain(plan.tx.chainId);

    if (!walletChain || walletChain.id !== plan.tx.chainId) {
      await switchChain(chain);
    }

    const owner = account.address as HexAddress;

    // -------- 1) Pre-approval steps --------

    if (plan.actionType === "STAKE") {
      const tokenRaw = (import.meta.env.VITE_URANO_TOKEN as string | undefined)?.trim();
      if (!tokenRaw || !isHexAddress(tokenRaw)) {
        throw new Error("Missing/invalid VITE_URANO_TOKEN in frontend env.");
      }

      const stakeAmountWei = decodeFirstUint256Arg(plan.tx.data);

      pushMessage({ id: uid(), role: "system", text: "Preparing approval…" });

      const approveTx = prepareTransaction({
        client: thirdwebClient,
        chain,
        to: tokenRaw,
        data: encodeErc20Approve(plan.tx.to as HexAddress, stakeAmountWei),
        value: 0n,
      });

      const approveRes = await sendTx(approveTx);
      if (!isSendTxResult(approveRes)) throw new Error("Unexpected approve result (missing transactionHash).");

      const { receipt: approveReceipt } = await waitForReceipt({ txHash: approveRes.transactionHash });
      if (approveReceipt.status && approveReceipt.status !== "0x1") {
        throw new Error(`Approve reverted (status=${approveReceipt.status}).`);
      }

      pushMessage({ id: uid(), role: "system", text: "Approval confirmed." });

      // Preflight read checks (balance + allowance)
      await preflightStake({
        token: tokenRaw,
        owner,
        spender: plan.tx.to as HexAddress,
        amountWei: stakeAmountWei,
      });
    }

    if (plan.actionType === "BUY_USHARE") {
      const usdcRaw = (import.meta.env.VITE_USDC_TOKEN as string | undefined)?.trim();
      if (!usdcRaw || !isHexAddress(usdcRaw)) {
        throw new Error("Missing/invalid VITE_USDC_TOKEN in frontend env.");
      }

      pushMessage({ id: uid(), role: "system", text: "Preparing USDC approval…" });

      const approveTx = prepareTransaction({
        client: thirdwebClient,
        chain,
        to: usdcRaw,
        data: encodeErc20Approve(plan.tx.to as HexAddress, MAX_UINT256),
        value: 0n,
      });

      const approveRes = await sendTx(approveTx);
      if (!isSendTxResult(approveRes)) throw new Error("Unexpected approve result (missing transactionHash).");

      const { receipt: approveReceipt } = await waitForReceipt({ txHash: approveRes.transactionHash });
      if (approveReceipt.status && approveReceipt.status !== "0x1") {
        throw new Error(`USDC approve reverted (status=${approveReceipt.status}).`);
      }

      pushMessage({ id: uid(), role: "system", text: "USDC approval confirmed." });
    }

    // -------- 2) Send the planned tx --------

    pushMessage({ id: uid(), role: "system", text: "Preparing transaction…" });

    const tx = prepareTransaction({
      client: thirdwebClient,
      chain,
      to: plan.tx.to,
      data: plan.tx.data,
      value: BigInt(plan.tx.value),
    });

    const res = await sendTx(tx);
    if (!isSendTxResult(res)) throw new Error("Unexpected send result (missing transactionHash).");

    const { receipt } = await waitForReceipt({ txHash: res.transactionHash });
    if (receipt.status && receipt.status !== "0x1") {
      throw new Error(`Transaction reverted (status=${receipt.status}).`);
    }

    pushMessage({ id: uid(), role: "system", text: "Transaction confirmed." });
  }

  async function onClickSendToWallet(plan: AssistantPlan): Promise<void> {
    setIsSendingTx(true);
    try {
      await sendPlanToWallet(plan);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const { headline, detail } = sanitizeTxError(raw);

      pushMessage({
        id: uid(),
        role: "error",
        text: detail ? `${headline}\n\n${detail}` : headline,
      });
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
            {isSendingTx ? "Sending…" : account ? "Send to wallet" : "Connect wallet"}
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
              <div
                key={m.id}
                className={[
                  "uw-msg",
                  m.role === "assistant"
                    ? "uw-msg-assistant"
                    : m.role === "user"
                    ? "uw-msg-user"
                    : m.role === "error"
                    ? "uw-msg-error"
                    : "uw-msg-system",
                ].join(" ")}
              >
                {m.text}
                {m.role === "assistant" && m.plan?.tx ? renderAssistantPlan(m.plan) : null}
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
