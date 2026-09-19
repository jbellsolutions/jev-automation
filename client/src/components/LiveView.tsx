import { useEffect, useRef } from "react";
import type { ClientMessage } from "../../../core/protocol.ts";
import type { State } from "../state.ts";

interface Props {
  page: State["page"];
  status: State["status"];
  connected: boolean;
  send: (msg: ClientMessage) => void;
  /** Keep the real viewport at this size and scale the frame to fit (small panels). */
  fixedViewport?: { width: number; height: number };
}

/** The streamed view of the controlled browser. Reports its own pixel size so the server
 *  sizes the real viewport to match (no CSS scaling); clicks are forwarded as fractions. */
export function LiveView({ page, status, connected, send, fixedViewport }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !connected) return;
    if (fixedViewport) {
      send({ type: "viewport", ...fixedViewport });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const r = box.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 100) send({ type: "viewport", width: Math.round(r.width), height: Math.round(r.height) });
    };
    report();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(report, 300);
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [connected, send, fixedViewport]);

  const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    send({ type: "click_at", fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height });
  };

  return (
    <section className="browser-pane">
      <div className="urlbar">
        <span id="page-title" className="title">{page.title || "—"}</span>
        <span id="page-url" className="url">{page.url}</span>
      </div>
      <div className={`screen${fixedViewport ? " scaled" : ""}`} ref={boxRef} style={fixedViewport ? { aspectRatio: `${fixedViewport.width} / ${fixedViewport.height}` } : undefined}>
        {page.frame ? (
          <img id="screen" src={page.frame} alt="Live view of the controlled browser" draggable={false} onClick={onClick} />
        ) : (
          <div className="overlay">Waiting for the browser…</div>
        )}
      </div>
      <div id="status" className={`status ${status.level}`}>{status.text}</div>
    </section>
  );
}
