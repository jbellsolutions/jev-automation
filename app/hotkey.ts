/** Push-to-talk / panel state machine, kept pure so it can be tested without Electron.
 *  One global hotkey does the obvious thing for the state the panel is in. */

export interface PanelState {
  visible: boolean;
  listening: boolean;
}

export type PanelEffect = "show" | "hide" | "start_listening" | "stop_listening" | "focus";

export function onHotkey(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  if (!s.visible) return { state: { visible: true, listening: true }, effects: ["show", "focus", "start_listening"] };
  if (!s.listening) return { state: { ...s, listening: true }, effects: ["focus", "start_listening"] };
  return { state: { ...s, listening: false }, effects: ["stop_listening"] };
}

/** Escape in the panel: stop listening if we are, otherwise tuck the panel away. */
export function onEscape(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  if (s.listening) return { state: { ...s, listening: false }, effects: ["stop_listening"] };
  if (s.visible) return { state: { ...s, visible: false }, effects: ["hide"] };
  return { state: s, effects: [] };
}

/** The renderer reports what it is actually doing; the state follows it. */
export function onRendererListening(s: PanelState, listening: boolean): PanelState {
  return s.listening === listening ? s : { ...s, listening };
}

export function onWindowVisibility(s: PanelState, visible: boolean): PanelState {
  return s.visible === visible ? s : { ...s, visible };
}
