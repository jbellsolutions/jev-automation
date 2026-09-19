/** Content script: runs in every tab, isolated from the page's own scripts but sharing its
 *  DOM. The background asks it to list elements (the shared page script) or to act. */
import type { Action } from "../core/actions.js";
import type { RawElement } from "../core/remote.js";
import { performInPage } from "./dom-actions.js";
// the page script is a JS source string in core/; the build inlines it as real code
import { listElements } from "virtual:page-script";

export type ContentRequest = { op: "snapshot"; max: number } | { op: "execute"; action: Action } | { op: "ping" };
export type ContentResponse = { ok: true; elements?: RawElement[]; status?: string; title?: string } | { ok: false; error: string };

function handle(req: ContentRequest): ContentResponse {
  switch (req.op) {
    case "ping":
      return { ok: true };
    case "snapshot":
      return { ok: true, elements: listElements(req.max) as RawElement[], title: document.title };
    case "execute":
      return { ok: true, status: performInPage(req.action) };
  }
}

chrome.runtime.onMessage.addListener((req: ContentRequest, _sender, sendResponse) => {
  try {
    sendResponse(handle(req));
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentResponse);
  }
  return false;
});
