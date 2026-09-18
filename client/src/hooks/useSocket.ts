import { useCallback, useEffect, useRef } from "react";
import type { ClientMessage, ServerMessage } from "../../../server/protocol.ts";

/** WebSocket to the server with auto-reconnect. Messages are typed end to end. */
export function useSocket(onMessage: (msg: ServerMessage) => void, onOpen: (connected: boolean) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlers = useRef({ onMessage, onOpen });
  handlers.current = { onMessage, onOpen };

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => handlers.current.onOpen(true);
      ws.onclose = () => {
        handlers.current.onOpen(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (ev) => {
        try {
          handlers.current.onMessage(JSON.parse(ev.data) as ServerMessage);
        } catch (err) {
          console.error("bad message", err);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);
}
