import { useCallback, useEffect, useMemo, useReducer } from "react";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { ClarifyCard } from "./components/ClarifyCard.tsx";
import { CommandInput } from "./components/CommandInput.tsx";
import { ConfirmCard } from "./components/ConfirmCard.tsx";
import { DecisionLog } from "./components/DecisionLog.tsx";
import { Help } from "./components/Help.tsx";
import { LiveView } from "./components/LiveView.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { useSocket } from "./hooks/useSocket.ts";
import { initialState, reducer } from "./state.ts";
import { detectTransport } from "./transport.ts";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const transport = useMemo(() => detectTransport(), []);
  const send = useSocket(transport, dispatch, (connected) =>
    dispatch({ type: "socket", connected }),
  );

  const command = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) send({ type: "command", text: trimmed });
    },
    [send],
  );
  const paused = state.paused;
  const interrupt = useCallback(() => send({ type: "interrupt" }), [send]);
  /** Stop everything now: the brain run and the browser step. */
  const stopAll = useCallback(() => {
    send({ type: "interrupt" });
    send({ type: "command", text: "stop" });
  }, [send]);
  const setPaused = useCallback((p: boolean) => send({ type: "pause", paused: p }), [send]);
  const busy = state.status.level === "busy" || state.entries.some((e) => e.brain?.state === "running" || e.brain?.state === "waiting");
  const desktop = transport.mode === "desktop";

  // Desktop shell: the hotkey shows/focuses the panel; Escape hides it.
  useEffect(() => {
    if (!desktop) return;
    document.body.classList.add("desktop");
    const bridge = window.jev;
    const offInterrupt = bridge?.onInterrupt?.(() => interrupt());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      bridge?.hide?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offInterrupt?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [desktop, interrupt]);

  return (
    <>
      <TopBar
        jev={state.jev}
        desktop={desktop}
        paused={paused}
        busy={busy}
        onStop={stopAll}
        onPause={setPaused}
        onHide={desktop ? () => window.jev?.hide?.() : undefined}
      />
      <main className={`layout${desktop ? " desktop" : ""}`}>
        <LiveView
          page={state.page}
          status={state.status}
          connected={state.connected}
          send={send}
          fixedViewport={desktop ? { width: 1024, height: 640 } : undefined}
        />
        <aside className="control-pane">
          <CommandInput onSubmit={command} />
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
          <DecisionLog
            entries={state.entries}
            onClear={() => dispatch({ type: "clear_log" })}
          />
          <Help />
        </aside>
      </main>
    </>
  );
}
