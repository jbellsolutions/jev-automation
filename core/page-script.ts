/** The in-page element lister, shared by every DOM-based executor: Playwright evaluates it
 *  as a string, the Chrome bridge bundles it into its content script at build time.
 *
 *  Kept as a plain JS source string (not a TS function) so that bundlers/loaders such as tsx
 *  cannot inject helpers (`__name`) that don't exist in the page context.
 *  Signature: (max: number) => RawElement[] (see elements.ts) */
export const PAGE_SCRIPT = String.raw`(max) => {
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
    // <input type=submit|button|reset|image> are buttons, not fields: their value/alt is their text
    const isButtonInput = tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image");
    const isField = !isButtonInput && (tag === "input" || tag === "textarea" || tag === "select" || el.getAttribute("contenteditable") === "true");
    // no value attribute: the browser still renders a default caption for submit/reset
    const value = isButtonInput ? el.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "") : "";
    const labelledBy = el.getAttribute("aria-labelledby");
    const labelledByText = labelledBy ? clean(document.getElementById(labelledBy)?.textContent, 80) : "";
    const htmlLabel = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    const label = clean(el.getAttribute("aria-label") || labelledByText || htmlLabel || el.getAttribute("title") || el.getAttribute("alt") || (el.querySelector("img") || {}).alt, 80);
    const text = isField ? "" : clean(el.innerText || el.textContent, 80) || clean(value, 80);
    const placeholder = clean(el.getAttribute("placeholder"), 60);
    const name = clean(el.getAttribute("name"), 40);
    // a tick changes no text, so without this a checkbox or radio click looks like no change
    const ariaChecked = el.getAttribute("aria-checked");
    const checked = tag === "input" && (type === "checkbox" || type === "radio") ? !!el.checked : ariaChecked === "true" ? true : ariaChecked === "false" ? false : null;
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
    if (!text && !label && !placeholder && !name && !hrefShort && !isField && !isButtonInput) continue;

    const item = {
      el, tag,
      role: clean(el.getAttribute("role"), 20).toLowerCase(),
      type, text, label, placeholder, name, hrefShort, checked,
      inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
      top: r.top, left: r.left,
    };
    const desc = [item.tag, item.role, item.type, item.text, item.label, item.placeholder, item.hrefShort, item.checked].join("|");
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
