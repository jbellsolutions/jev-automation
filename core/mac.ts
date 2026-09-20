/** The Mac as a surface: which window is "in front" for the user, and how an accessibility
 *  tree becomes the same PageSnapshot the decision loop reads for web pages. Pure functions
 *  over the shapes cua-driver returns; the driver itself is called from server/executors/mac.ts. */
import { MAX_ELEMENTS, type PageElement, type PageSnapshot } from "./elements.js";

/** One top-level window as `list_windows` reports it. */
export interface MacWindow {
  app_name: string;
  pid: number;
  window_id: number;
  title: string;
  layer: number;
  is_on_screen: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** One row of `get_window_state.elements`. */
export interface AxElement {
  element_index: number;
  element_token?: string;
  role: string;
  label?: string;
  value?: string;
  actions?: string[];
  frame?: { x: number; y: number; w: number; h: number };
  depth?: number;
}

/** Processes whose windows are never "the app the user is in": system chrome, our own
 *  overlay, permission prompts. Matched on `app_name` as WindowServer reports it. */
export const IGNORED_APPS = new Set([
  "Cua Driver",
  "CuaDriver",
  "universalAccessAuthWarn",
  "Window Server",
  "WindowServer",
  "Dock",
  "Control Center",
  "Notification Center",
  "NotificationCenter",
  "Spotlight",
  "CursorUIViewService",
  "Screenshot",
  "loginwindow",
]);

/** Windows smaller than this are tooltips, badges and palettes, not something to act in. */
const MIN_WINDOW = { width: 200, height: 120 };

/** The window the user is looking at. `frontPid` is the frontmost application (from `lsappinfo
 *  front`): the app the keyboard and menu bar belong to, which is not the same as the topmost
 *  window in raw z-order (a document window can float above the active app). When it names an
 *  ordinary app, we take that app's largest on-screen window; otherwise we fall back to the
 *  first ordinary on-screen window in z-order. `ownPids` is our own process (the floating panel). */
export function frontWindow(windows: MacWindow[], ownPids: number[] = [], frontPid?: number | null): MacWindow | null {
  const own = new Set(ownPids);
  const usable = (w: MacWindow) => w.layer === 0 && w.is_on_screen && !own.has(w.pid) && !IGNORED_APPS.has(w.app_name) && w.bounds.width >= MIN_WINDOW.width && w.bounds.height >= MIN_WINDOW.height;
  if (frontPid && !own.has(frontPid)) {
    const mine = windows.filter((w) => w.pid === frontPid && usable(w));
    if (mine.length) return mine.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0]!;
  }
  return windows.find(usable) ?? null;
}

export const BROWSER_APPS = new Set(["Google Chrome", "Google Chrome Beta", "Google Chrome Canary", "Chromium"]);

/** "app://Google Chrome" — the Mac counterpart of a page URL. */
export function appUrl(appName: string): string {
  return `app://${appName}`;
}

const ROLE_NAMES: Record<string, string> = {
  AXButton: "button",
  AXPopUpButton: "dropdown",
  AXMenuButton: "menu button",
  AXMenuItem: "menu item",
  AXMenuBarItem: "menu",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio button",
  AXTabGroup: "tabs",
  AXTab: "tab",
  AXRow: "row",
  AXCell: "cell",
  AXLink: "link",
  AXTextField: "text field",
  AXSecureTextField: "password field",
  AXTextArea: "text area",
  AXComboBox: "combo box",
  AXSearchField: "search field",
  AXSlider: "slider",
  AXIncrementor: "stepper",
  AXDisclosureTriangle: "expander",
  AXImage: "image",
  AXStaticText: "text",
  AXOutline: "list",
  AXList: "list",
  AXTable: "table",
  AXToolbar: "toolbar",
  AXWindow: "window",
  AXWebArea: "web content",
  AXGroup: "group",
  AXSplitter: "splitter",
  AXScrollArea: "scroll area",
};

const TEXT_ROLES = new Set(["AXTextField", "AXSecureTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);
const PRESSABLE = new Set(["AXPress", "AXConfirm", "AXPick", "AXOpen"]);
/** Containers that expose AXPress/AXShowMenu without being something one would "click". */
const CONTAINER_ROLES = new Set(["AXWindow", "AXWebArea", "AXGroup", "AXScrollArea", "AXSplitter", "AXToolbar", "AXOutline", "AXList", "AXTable", "AXTabGroup", "AXSplitGroup", "AXLayoutArea"]);

/** Is this something the user could click into or type into? Static text is kept only when
 *  it is pressable (a row's label in some apps), never as decoration. */
export function isInteractive(e: AxElement): boolean {
  if (CONTAINER_ROLES.has(e.role)) return false;
  if (TEXT_ROLES.has(e.role)) return true;
  const actions = e.actions ?? [];
  if (actions.some((a) => PRESSABLE.has(a))) return true;
  return e.role === "AXMenuItem" || e.role === "AXTab" || e.role === "AXLink";
}

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Interactive AX elements as PageElements, ids `e<i>` in tree order. The map back to the
 *  driver's tokens is returned alongside so execute() can address the exact element. */
export function toPageElements(elements: AxElement[], max = MAX_ELEMENTS): { elements: PageElement[]; tokens: Map<string, AxElement> } {
  const out: PageElement[] = [];
  const tokens = new Map<string, AxElement>();
  for (const e of elements) {
    if (!isInteractive(e)) continue;
    const label = (e.label ?? "").trim();
    const value = (e.value ?? "").trim();
    if (!label && !value && !TEXT_ROLES.has(e.role)) continue;
    const id = `e${out.length}`;
    const isText = TEXT_ROLES.has(e.role);
    // a text view with no title reports its contents as its label: that is not a name
    const fieldName = isText && label && label !== value && label.length <= 60 && !label.includes("\n") ? label : "";
    out.push({
      id,
      tag: "ax",
      role: roleName(e.role),
      type: e.role,
      text: isText ? "" : label,
      label: fieldName,
      placeholder: isText ? value.split("\n")[0]!.slice(0, 60) : "",
      name: "",
      hrefShort: null,
      inViewport: !e.frame || (e.frame.w > 1 && e.frame.h > 1),
    });
    tokens.set(id, e);
    if (out.length >= max) break;
  }
  return { elements: out, tokens };
}

export function macSnapshot(win: MacWindow, elements: AxElement[], max = MAX_ELEMENTS): { snapshot: PageSnapshot; tokens: Map<string, AxElement> } {
  const { elements: els, tokens } = toPageElements(elements, max);
  return { snapshot: { url: appUrl(win.app_name), title: win.title || win.app_name, elements: els }, tokens };
}

/** Key names as the decision loop says them -> cua-driver's `press_key` names. */
export function driverKey(key: string): { key: string; modifiers: string[] } {
  const parts = key.toLowerCase().split(/[+\s-]+/).filter(Boolean);
  const modifiers: string[] = [];
  let main = "return";
  for (const p of parts) {
    if (p === "cmd" || p === "command" || p === "meta") modifiers.push("cmd");
    else if (p === "shift") modifiers.push("shift");
    else if (p === "alt" || p === "option" || p === "opt") modifiers.push("option");
    else if (p === "ctrl" || p === "control") modifiers.push("ctrl");
    else main = p;
  }
  const names: Record<string, string> = { enter: "return", esc: "escape", backspace: "delete", del: "delete", pgup: "pageup", pgdn: "pagedown", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right" };
  return { key: names[main] ?? main, modifiers };
}

/** cua-driver refuses an element token once a newer snapshot exists; the Executor contract
 *  wants that reported as the element having left the page. */
export function isStaleTokenError(message: string): boolean {
  return /stale|superseded|snapshot.*(replaced|expired|not found|unknown)|element_token/i.test(message);
}
