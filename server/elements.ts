import type { Page } from "playwright";

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
}

/** Jev's Choice accepts 255 options; keep room for the "none" escape hatch and keep the
 *  state small (accuracy drops with irrelevant detail). */
export const MAX_ELEMENTS = 180;

type RawElement = Omit<PageElement, "id">;

/** Runs inside the page. Kept as a plain JS source string (not a TS function) so that
 *  bundlers/loaders such as tsx cannot inject helpers (`__name`) that don't exist in the
 *  page context. Signature: (max: number) => RawElement[] */
const PAGE_SCRIPT = String.raw`(max) => {
  const SELECTOR =
    'a[href], button, input:not([type="hidden"]), textarea, select, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], ' +
    '[role="radio"], [role="option"], [role="textbox"], [role="combobox"], [role="switch"], ' +
    '[contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clean = (s, n) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim().slice(0, n);
  const found = [];
  const seenDesc = new Set();

  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0" || cs.pointerEvents === "none") continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.disabled) continue;
    // skip wrappers whose only content is another interactive element (a > button)
    const inner = el.querySelector(SELECTOR);
    if (inner && clean(el.innerText, 200) === clean(inner.innerText, 200)) continue;

    const tag = el.tagName.toLowerCase();
    const type = clean(el.getAttribute("type"), 20).toLowerCase();
    const isField = tag === "input" || tag === "textarea" || tag === "select" || el.getAttribute("contenteditable") === "true";
    const value = tag === "input" && (type === "submit" || type === "button" || type === "reset") ? el.value : "";
    const labelledBy = el.getAttribute("aria-labelledby");
    const labelledByText = labelledBy ? clean(document.getElementById(labelledBy)?.textContent, 80) : "";
    const htmlLabel = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    const label = clean(el.getAttribute("aria-label") || labelledByText || htmlLabel || el.getAttribute("title") || el.getAttribute("alt") || (el.querySelector("img") || {}).alt, 80);
    const text = isField ? "" : clean(el.innerText || el.textContent, 80) || clean(value, 80);
    const placeholder = clean(el.getAttribute("placeholder"), 60);
    const name = clean(el.getAttribute("name"), 40);
    let hrefShort = null;
    if (tag === "a") {
      const href = el.getAttribute("href") || "";
      if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) {
        try {
          const u = new URL(href, location.href);
          hrefShort = (u.host === location.host ? "" : u.host) + (u.pathname === "/" && u.host !== location.host ? "" : u.pathname) + (u.host === location.host ? u.search : "");
          if (hrefShort.length > 60) hrefShort = hrefShort.slice(0, 57) + "...";
        } catch (_) {
          hrefShort = null;
        }
      }
    }
    if (!text && !label && !placeholder && !name && !hrefShort && !isField) continue;

    const item = {
      el, tag,
      role: clean(el.getAttribute("role"), 20).toLowerCase(),
      type, text, label, placeholder, name, hrefShort,
      inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
      top: r.top, left: r.left,
    };
    const desc = [item.tag, item.role, item.type, item.text, item.label, item.placeholder, item.hrefShort].join("|");
    if (seenDesc.has(desc)) continue;
    seenDesc.add(desc);
    found.push(item);
  }

  found.sort((a, b) => (a.inViewport === b.inViewport ? a.top - b.top || a.left - b.left : a.inViewport ? -1 : 1));
  document.querySelectorAll("[data-jev-id]").forEach((e) => e.removeAttribute("data-jev-id"));
  return found.slice(0, max).map((item, idx) => {
    item.el.setAttribute("data-jev-id", "e" + idx);
    const { el, top, left, ...rest } = item;
    return rest;
  });
}`;

export async function extractElements(page: Pick<Page, "evaluate">, max = MAX_ELEMENTS): Promise<PageElement[]> {
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
