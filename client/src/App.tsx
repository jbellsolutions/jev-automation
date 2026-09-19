import { useCallback, useEffect, useMemo, useReducer } from "react";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { ClarifyCard } from "./components/ClarifyCard.tsx";
import { CommandInput } from "./components/CommandInput.tsx";
import { ConfirmCard } from "./components/ConfirmCard.tsx";
import { DecisionLog } from "./components/DecisionLog.tsx";
import { Help } from "./components/Help.tsx";
import { LiveView } from "./components/LiveView.tsx";
import { MicButton } from "./components/MicButton.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { useSocket } from "./hooks/useSocket.ts";
import { useVoice } from "./hooks/useVoice.ts";
import { initialState, reducer } from "./state.ts";
import { detectTransport } from "./transport.ts";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const transport = useMemo(() => detectTransport(), []);
  const send = useSocket(transport, dispatch, (connected) => dispatch({ type: "socket", connected }));

  const command = useCallback(
    (text: string, via: "voice" | "text") => {
      const trimmed = text.trim();
      if (trimmed) send({ type: "command", text: trimmed, via });
    },
    [send],
  );
  const speech = useVoice({ transport, sttProvider: state.stt, muted: state.speaking, onUtterance: (text) => command(text, "voice") });
  const desktop = transport.mode === "desktop";

  // Desktop shell: the global hotkey drives the microphone, the tray mirrors its state, Escape hides the panel.
  useEffect(() => {
    if (!desktop) return;
    document.body.classList.add("desktop");
    const bridge = window.jev;
    const offToggle = bridge?.onToggleListening?.(() => speech.toggle());
    const offStop = bridge?.onStopListening?.(() => speech.stop());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (speech.listening ? speech.stop : bridge?.hide)?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offToggle?.();
      offStop?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [desktop, speech.toggle, speech.stop, speech.listening]);
  useEffect(() => {
    if (desktop) window.jev?.setListening?.(speech.listening);
  }, [desktop, speech.listening]);
  useEffect(() => {
    if (desktop && window.jev?.autoListen && state.jev && !speech.listening) {
      console.log("[voice] auto-listen: starting");
      speech.start();
    }
    // once, when the companion has said hello
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, state.jev !== null]);
  useEffect(() => {
    if (speech.error) console.error(`[voice] ${speech.error}`);
  }, [speech.error]);
  useEffect(() => {
    if (speech.listening) console.log(`[voice] listening via ${speech.engine}${speech.provider ? ` (${speech.provider})` : ""}`);
  }, [speech.listening, speech.engine, speech.provider]);

  return (
    <>
      <TopBar jev={state.jev} desktop={desktop} onHide={desktop ? () => window.jev?.hide?.() : undefined} />
      <main className={`layout${desktop ? " desktop" : ""}`}>
        <LiveView page={state.page} status={state.status} connected={state.connected} send={send} fixedViewport={desktop ? { width: 1024, height: 640 } : undefined} />
        <aside className="control-pane">
          <MicButton speech={speech} />
          <CommandInput onSubmit={(t) => command(t, "text")} />
          {state.pending?.kind === "confirm" && (
            <ConfirmCard
              pending={state.pending}
              onReply={(ok) => {
                send({ type: "confirm_reply", ok });
                dispatch({ type: "dismiss_pending" });
              }}
            />
          )}
          {state.approval && (
            <ApprovalCard
              pending={state.approval}
              onChoose={(choice) => {
                send({ type: "approval_reply", choice });
                dispatch({ type: "dismiss_approval" });
              }}
            />
          )}
          {state.pending?.kind === "clarify" && (
            <ClarifyCard
              pending={state.pending}
              onPick={(elementId) => {
                send({ type: "pick", elementId });
                dispatch({ type: "dismiss_pending" });
              }}
            />
          )}
          <DecisionLog entries={state.entries} onClear={() => dispatch({ type: "clear_log" })} />
          <Help />
        </aside>
      </main>
    </>
  );
}
