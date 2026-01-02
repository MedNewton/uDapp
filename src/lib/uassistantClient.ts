// src/lib/uassistantClient.ts

export type ChatRole = "user" | "assistant";

export type ChatMessage = Readonly<{
  role: ChatRole;
  content: string;
}>;

export type TxPreview = Readonly<{
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string; // bigint string
}>;

export type AssistantPlan = Readonly<{
  id: string;
  actionType:
    | "STAKE"
    | "UNSTAKE"
    | "STAKE_ALL"
    | "UNSTAKE_ALL"
    | "BUY_USHARE"
    | "SELL_USHARE"
    | "VOTE"
    | "CLAIM_VESTING"
    | "QUESTION"
    | "UNSUPPORTED";
  interpretation: string;
  userMessage: string;
  warnings: string[];

  // new (multi-tx)
  txs?: TxPreview[];

  // legacy (single tx)
  tx?: TxPreview | null;

  docsUrl?: string;
  supportEmail?: string;
}>;

/** Must match backend ChatBodySchema "context" shape (subset). */
export type ChatContext = Readonly<{
  account?: `0x${string}`;
  vesting?: Readonly<{
    data: Readonly<{
      beneficiary: `0x${string}`;
      totalAmount: string;
      cliffInSeconds: string;
      vestingInSeconds: string;
      tgePercentage: string;
    }>;
    merkleProof: readonly `0x${string}`[];
  }>;
}>;

export type StreamEvent =
  | { type: "ready"; id?: string }
  | { type: "plan"; plan: AssistantPlan }
  | { type: "delta"; delta: string }
  | { type: "done" }
  | { type: "error"; error: string; message?: string };

function assertEnv(name: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const API_BASE = (() => {
  const raw = assertEnv(
    "VITE_UASSISTANT_API_BASE",
    import.meta.env.VITE_UASSISTANT_API_BASE
  );
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
})();

const API_KEY = (() => {
  return assertEnv("VITE_UASSISTANT_API_KEY", import.meta.env.VITE_UASSISTANT_API_KEY);
})();

export async function streamChat(args: Readonly<{
  messages: readonly ChatMessage[];
  context?: ChatContext;
  signal?: AbortSignal;
  onEvent: (evt: StreamEvent) => void;
}>): Promise<void> {
  const { messages, context, signal, onEvent } = args;

  const body: { messages: readonly ChatMessage[]; context?: ChatContext } = { messages };
  if (context) body.context = context;

  const res = await fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
  }

  if (!res.body) throw new Error("No response body (stream not supported).");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buf = "";
  let currentEvent: string | null = null;

  const flushBlock = (block: string): void => {
    // Ignore SSE comment / keep-alive blocks like ": ping"
    if (/^\s*:\s*/m.test(block)) return;

    const lines = block.split("\n");
    let ev: string | null = null;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    const dataRaw = dataLines.join("\n").trim();
    const eventName = (ev ?? currentEvent ?? "").trim();
    if (!eventName) return;

    if (eventName === "ready") {
      try {
        const parsed = dataRaw ? (JSON.parse(dataRaw) as { ok?: boolean; id?: string }) : {};
        onEvent({ type: "ready", id: parsed.id });
      } catch {
        onEvent({ type: "ready" });
      }
      return;
    }

    if (eventName === "plan") {
      try {
        const parsed = JSON.parse(dataRaw) as AssistantPlan;
        onEvent({ type: "plan", plan: parsed });
      } catch {
        onEvent({
          type: "error",
          error: "BAD_PLAN_EVENT",
          message: "Could not parse plan payload.",
        });
      }
      return;
    }

    if (eventName === "delta") {
      try {
        const parsed = JSON.parse(dataRaw) as { delta?: string };
        onEvent({ type: "delta", delta: parsed.delta ?? "" });
      } catch {
        onEvent({ type: "delta", delta: dataRaw });
      }
      return;
    }

    if (eventName === "done") {
      onEvent({ type: "done" });
      return;
    }

    if (eventName === "error") {
      try {
        const parsed = JSON.parse(dataRaw) as { error?: string; message?: string };
        onEvent({
          type: "error",
          error: parsed.error ?? "ERROR",
          message: parsed.message,
        });
      } catch {
        onEvent({ type: "error", error: "ERROR", message: dataRaw });
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 2);

        if (block.includes("event:")) {
          const m = block.match(/^event:\s*(.+)$/m);
          currentEvent = m?.[1]?.trim() ?? currentEvent;
        }

        if (block.trim().length > 0) flushBlock(block);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
