/** Panel visibility state machine, kept pure so it can be tested without Electron.
 *  One global hotkey shows/focuses the panel; Escape hides it, or cancels busy work first. */

export interface PanelState {
  visible: boolean;
  /** A command or brain run is in flight. */
  busy: boolean;
  /** Switched off: nothing is heard, said or done until resumed. */
  paused?: boolean;
}

export type PanelEffect = "show" | "hide" | "focus" | "cancel" | "resume";

/** ⌥Space always brings the panel to the front; it never hides it (there is nothing to "stop
 *  listening" to any more — that toggle died with on-device STT). */
export function onHotkey(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  if (s.paused) {
    const effects: PanelEffect[] = ["resume"];
    if (!s.visible) effects.push("show");
    effects.push("focus");
    return { state: { ...s, visible: true, paused: false }, effects };
  }
  if (!s.visible) return { state: { ...s, visible: true }, effects: ["show", "focus"] };
  return { state: s, effects: ["focus"] };
}

/** Escape: cancel in-flight work if the panel is busy (stays open so the outcome is visible),
 *  else tuck the panel away. */
export function onEscape(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  if (s.busy) return { state: s, effects: ["cancel"] };
  if (s.visible) return { state: { ...s, visible: false }, effects: ["hide"] };
  return { state: s, effects: [] };
}

/** The renderer reports whether a command or brain run is in flight. */
export function onRendererBusy(s: PanelState, busy: boolean): PanelState {
  return s.busy === busy ? s : { ...s, busy };
}

/** The hub's pause switch changed (tray, panel or API). Pausing also cancels whatever was busy. */
export function onPaused(s: PanelState, paused: boolean): PanelState {
  if (!!s.paused === paused) return s;
  return paused ? { ...s, paused: true, busy: false } : { ...s, paused: false };
}

export function onWindowVisibility(s: PanelState, visible: boolean): PanelState {
  return s.visible === visible ? s : { ...s, visible };
}
