/** Everything the browser can be asked to do. Jev never produces these directly:
 *  code assembles an Action from Jev's typed answers plus text pre-parsed from the
 *  transcript, so every field here is either a closed-set pick or a verbatim span. */
export type ScrollDirection = "up" | "down" | "top" | "bottom";

export type Action =
  | { kind: "navigate"; url: string }
  | { kind: "search"; query: string; url: string }
  | { kind: "click"; elementId: string; label: string }
  | { kind: "click_at"; x: number; y: number }
  | { kind: "type"; elementId: string | null; label: string | null; text: string; submit: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; direction: ScrollDirection }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "stop" }
  /** Launch or switch to an application on the Mac (the computer lane, not the browser). */
  | { kind: "open_app"; app: string }
  | { kind: "none"; reason: string };

/** Short human-readable summary used in the UI log and confirmation prompts. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "navigate":
      return `Open ${a.url}`;
    case "search":
      return `Search the web for "${a.query}"`;
    case "click":
      return `Click ${a.label}`;
    case "click_at":
      return `Click at (${a.x}, ${a.y})`;
    case "type":
      return `Type "${a.text}"${a.label ? ` into ${a.label}` : ""}${a.submit ? " and press Enter" : ""}`;
    case "press":
      return `Press ${a.key}`;
    case "scroll":
      return a.direction === "top" || a.direction === "bottom" ? `Scroll to ${a.direction}` : `Scroll ${a.direction}`;
    case "back":
      return "Go back";
    case "forward":
      return "Go forward";
    case "reload":
      return "Reload the page";
    case "stop":
      return "Stop";
    case "open_app":
      return `Open ${a.app}`;
    case "none":
      return a.reason;
  }
}
