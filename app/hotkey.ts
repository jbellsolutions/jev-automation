/** Push-to-talk / panel state machine, kept pure so it can be tested without Electron.
 *  One global hotkey does the obvious thing for the state the panel is in. */

export interface PanelState {
  visible: boolean;
  listening: boolean;
  /** The assistant is talking (the microphone is muted meanwhile). */
  speaking?: boolean;
  /** Switched off: nothing is heard, said or done until resumed. */
  paused?: boolean;
}

export type PanelEffect = "show" | "hide" | "start_listening" | "stop_listening" | "focus" | "interrupt" | "resume";

export function onHotkey(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  // switched off: the hotkey switches it back on and listens
  if (s.paused) {
    const effects: PanelEffect[] = ["resume"];
    if (!s.visible) effects.push("show");
    effects.push("focus", "start_listening");
    return { state: { visible: true, listening: true, speaking: false, paused: false }, effects };
  }
  // while the assistant talks, the hotkey first shuts it up, then makes sure we are listening
  if (s.speaking) {
    const effects: PanelEffect[] = ["interrupt"];
    if (!s.visible) effects.push("show");
    if (!s.visible || !s.listening) effects.push("focus");
    if (!s.listening) effects.push("start_listening");
    return { state: { visible: true, listening: true, speaking: false }, effects };
  }
  if (!s.visible) return { state: { ...s, visible: true, listening: true }, effects: ["show", "focus", "start_listening"] };
  if (!s.listening) return { state: { ...s, listening: true }, effects: ["focus", "start_listening"] };
  return { state: { ...s, listening: false }, effects: ["stop_listening"] };
}

/** Escape in the panel: cut the assistant off if it is talking, else stop listening if we
 *  are, otherwise tuck the panel away. */
export function onEscape(s: PanelState): { state: PanelState; effects: PanelEffect[] } {
  if (s.speaking) return { state: { ...s, speaking: false }, effects: ["interrupt"] };
  if (s.listening) return { state: { ...s, listening: false }, effects: ["stop_listening"] };
  if (s.visible) return { state: { ...s, visible: false }, effects: ["hide"] };
  return { state: s, effects: [] };
}

/** The renderer reports what it is actually doing; the state follows it. */
export function onRendererListening(s: PanelState, listening: boolean): PanelState {
  return s.listening === listening ? s : { ...s, listening };
}

export function onRendererSpeaking(s: PanelState, speaking: boolean): PanelState {
  return !!s.speaking === speaking ? s : { ...s, speaking };
}

/** The hub's pause switch changed (tray, panel, voice or API). Pausing also means not listening. */
export function onPaused(s: PanelState, paused: boolean): PanelState {
  if (!!s.paused === paused) return s;
  return paused ? { ...s, paused: true, listening: false, speaking: false } : { ...s, paused: false };
}

export function onWindowVisibility(s: PanelState, visible: boolean): PanelState {
  return s.visible === visible ? s : { ...s, visible };
}
