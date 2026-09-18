import { useCallback, useReducer } from "react";
import { ClarifyCard } from "./components/ClarifyCard.tsx";
import { CommandInput } from "./components/CommandInput.tsx";
import { ConfirmCard } from "./components/ConfirmCard.tsx";
import { DecisionLog } from "./components/DecisionLog.tsx";
import { Help } from "./components/Help.tsx";
import { LiveView } from "./components/LiveView.tsx";
import { MicButton } from "./components/MicButton.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { useSocket } from "./hooks/useSocket.ts";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition.ts";
import { initialState, reducer } from "./state.ts";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const send = useSocket(dispatch, (connected) => dispatch({ type: "socket", connected }));

  const command = useCallback(
    (text: string, via: "voice" | "text") => {
      const trimmed = text.trim();
      if (trimmed) send({ type: "command", text: trimmed, via });
    },
    [send],
  );
  const speech = useSpeechRecognition((text) => command(text, "voice"));

  return (
    <>
      <TopBar jev={state.jev} />
      <main className="layout">
        <LiveView page={state.page} status={state.status} connected={state.connected} send={send} />
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
