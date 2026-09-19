import { PAGE_SCRIPT } from "./page-script.js";

/** One interactive element observed on the page. Ids (e0, e1, ...) are also written to
 *  the DOM as data-jev-id so the chosen element can be located again after Jev picks it. */
export interface PageElement {
  id: string;
  tag: string;
  role: string;
  type: string;
  text: string;
  label: string;
  placeholder: string;
  name: string;
  hrefShort: string | null;
  inViewport: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: PageElement[];
  /** JavaScript dialogs (alert/confirm/prompt) shown since the previous snapshot, as
   *  "alert: message". They never appear in the DOM, so this is the only evidence of them. */
  dialogs?: string[];
}

/** Jev's Choice accepts 255 options; keep room for the "none" escape hatch and keep the
 *  state small (accuracy drops with irrelevant detail). */
export const MAX_ELEMENTS = 180;

type RawElement = Omit<PageElement, "id">;

/** Anything that can evaluate a JS source string in a page context (a Playwright Page, a bridge). */
export interface Evaluator {
  evaluate(source: string): Promise<unknown>;
}

export async function extractElements(page: Evaluator, max = MAX_ELEMENTS): Promise<PageElement[]> {
  const raw = (await page.evaluate(`(${PAGE_SCRIPT})(${Math.max(0, Math.floor(max))})`)) as RawElement[];
  return raw.map((e, i) => ({ id: `e${i}`, ...e }));
}

export function elementKind(e: PageElement): string {
  if (e.role) return e.role;
  switch (e.tag) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "select":
      return "dropdown";
    case "textarea":
      return "text area";
    case "summary":
      return "expander";
    case "input":
      switch (e.type) {
        case "submit":
        case "button":
        case "reset":
        case "image":
          return "button";
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio button";
        case "search":
          return "search box";
        case "email":
          return "email field";
        case "password":
          return "password field";
        case "file":
          return "file picker";
        case "":
        case "text":
          return "text box";
        default:
          return `${e.type} field`;
      }
    default:
      return e.tag;
  }
}

/** Compact one-line description used both as Jev's option description and in the UI. */
export function describeElement(e: PageElement): string {
  const primary = e.text || e.label || e.placeholder || e.name;
  let s = elementKind(e);
  if (primary) s += ` "${primary}"`;
  if (e.label && e.text && e.label !== e.text) s += ` (${e.label})`;
  if (e.placeholder && primary !== e.placeholder) s += ` placeholder "${e.placeholder}"`;
  if (e.hrefShort) s += ` → ${e.hrefShort}`;
  if (!e.inViewport) s += " [off-screen]";
  return s;
}

export const NONE_OPTION = "none";

/** Choice criteria for "which element": ids -> descriptions, plus an explicit "none". */
export function elementCriteria(elements: PageElement[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const e of elements.slice(0, MAX_ELEMENTS)) criteria[e.id] = describeElement(e);
  criteria[NONE_OPTION] = "The command does not refer to any element listed here";
  return criteria;
}
