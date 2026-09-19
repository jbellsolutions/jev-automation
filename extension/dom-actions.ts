/** Acting on the page from inside it. Pure DOM code, no extension APIs, so the same functions
 *  run in the content script and in headless Chromium under test. Element ids are the
 *  `data-jev-id` attributes the page script wrote on its last run. */
import type { Action } from "../core/actions.js";

export const STALE = (label: string) => `${label} is no longer on the page`;

const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"], [role="searchbox"]';

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none";
}

function byId(elementId: string): HTMLElement | null {
  if (!/^e\d+$/.test(elementId)) throw new Error(`Bad element id ${elementId}`);
  const el = document.querySelector(`[data-jev-id="${elementId}"]`);
  return el instanceof HTMLElement ? el : null;
}

function firstField(): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll(FIELD_SELECTOR))) if (el instanceof HTMLElement && visible(el)) return el;
  return null;
}

/** Real-looking pointer sequence, then the element's own click() for default actions. */
export function clickElement(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 };
  for (const type of ["pointerdown", "mousedown"]) el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, init));
  if (document.activeElement !== el && typeof el.focus === "function") el.focus({ preventScroll: true });
  for (const type of ["pointerup", "mouseup"]) el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...init, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, { ...init, buttons: 0 }));
  el.click();
}

function isTextInput(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** Set a value the way frameworks notice: through the native setter, then input + change. */
export function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Type into a field: inputs get their value replaced; rich editors (Slack, Gmail, Notion)
 *  get the text inserted at the caret through the editing command they listen for. */
export function typeInto(el: HTMLElement, text: string): void {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  el.focus({ preventScroll: true });
  if (isTextInput(el)) {
    el.select?.();
    setFieldValue(el, text);
    return;
  }
  // contenteditable / role=textbox: select what is there, then insert
  const sel = window.getSelection();
  if (sel && el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
}

const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Space: { key: " ", code: "Space", keyCode: 32 },
};

/** Synthetic keys reach the page's handlers but not the browser's defaults, so Enter in a
 *  form field submits the form explicitly. Returns false when nothing was there to receive it. */
export function pressKey(key: string): boolean {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const k = KEYS[key] ?? { key, code: key, keyCode: 0 };
  const init: KeyboardEventInit = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
  const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (down) target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  if (key === "Enter" && down && target instanceof HTMLInputElement && target.form && target.type !== "textarea") {
    if (typeof target.form.requestSubmit === "function") target.form.requestSubmit();
    else target.form.submit();
  }
  return true;
}

export function scrollPage(direction: "up" | "down" | "top" | "bottom"): void {
  const step = Math.round(window.innerHeight * 0.75);
  if (direction === "top") window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  else if (direction === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" as ScrollBehavior });
  else window.scrollBy({ top: direction === "up" ? -step : step, behavior: "instant" as ScrollBehavior });
}

/** Perform the DOM half of an Action (navigation is the background's job). */
export function performInPage(action: Action): string {
  switch (action.kind) {
    case "click": {
      const el = byId(action.elementId);
      if (!el) throw new Error(STALE(action.label));
      clickElement(el);
      return `Clicked ${action.label}`;
    }
    case "click_at": {
      const el = document.elementFromPoint(action.x, action.y);
      if (!(el instanceof HTMLElement)) throw new Error(`Nothing to click at (${action.x}, ${action.y})`);
      clickElement(el);
      return `Clicked at (${action.x}, ${action.y})`;
    }
    case "type": {
      const el = action.elementId ? byId(action.elementId) : firstField();
      if (!el) throw new Error(action.elementId ? STALE(action.label ?? "that field") : "There's no text field to type into on this page");
      typeInto(el, action.text);
      if (action.submit) pressKey("Enter");
      return `Typed "${action.text}"${action.submit ? " and pressed Enter" : ""}`;
    }
    case "press":
      pressKey(action.key);
      return `Pressed ${action.key}`;
    case "scroll":
      scrollPage(action.direction);
      return `Scrolled ${action.direction}`;
    default:
      throw new Error(`${action.kind} is not a page action`);
  }
}
