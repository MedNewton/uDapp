import { useMemo, useState } from "react";

type Msg = { id: string; role: "assistant" | "user"; text: string };

export default function ChatWidget() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([
    { id: "m1", role: "assistant", text: "Hi. What do you want to do?" },
  ]);

  const canSend = input.trim().length > 0;

  function onSend() {
    if (!canSend) return;
    const text = input.trim();
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text },
    ]);
  }

  const headerTitle = useMemo(() => "Urano Assistant", []);

  return (
    <div className="uw-wrap">
      <div className="uw-card gradient-border glass">
        <div className="uw-header">
          <div className="uw-title">{headerTitle}</div>
          <div className="uw-subtitle">Connected to Base Sepolia</div>
        </div>

        <div className="uw-messages">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`uw-msg ${m.role === "user" ? "uw-msg-user" : "uw-msg-assistant"}`}
            >
              {m.text}
            </div>
          ))}
        </div>

        <div className="uw-inputRow">
          <input
            className="uw-input"
            placeholder="Type your message…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSend();
            }}
          />
          <button className="uw-send" onClick={onSend} disabled={!canSend}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
