# Jev Voice Browser

Speak to your browser. Your words are transcribed live, **TypeSafe's Jev** decides what
you meant, and a Playwright-driven Chromium does it — streamed back into the web app in
realtime.

> “open wikipedia dot org” · “click on pricing” · “type hello world in the search box and
> press enter” · “scroll to the bottom” · “go back”

```
 ┌─ your browser ───────────────┐      ┌─ Node server ───────────────────────────┐
 │ Web Speech API → transcript  │ ws   │ pre-parse URL / text  ─┐                │
 │ live view (JPEG stream)      │─────▶│ snapshot page elements ─┼─▶ Jev (1 call) │
 │ confirm / clarify / log      │◀─────│ confidence gates ◀──────┘   ~100–500 ms  │
 └──────────────────────────────┘      │ Playwright Chromium executes the Action │
                                       └─────────────────────────────────────────┘
```

## Why Jev, and how it's used

[Jev](https://typesafe.ai) is a *System One* model: instead of generating text it returns
**typed decisions** — a `choice` among options you define (with a probability for every
option and a confidence), a yes/no `noul` probability, or a `score` on a rubric. It answers
in roughly 100 ms, which is what makes hands-free browser control feel instant.

Because Jev never generates strings, the split of work is deliberate
(`server/decide.ts`):

| Job | Who | How |
| --- | --- | --- |
| Find URLs / text to type in the transcript | code | regexes over the normalized speech (“google dot com” → `google.com`) |
| What does the user want? | Jev `choice` | `intent` over `open_url, search_web, click, type_text, press_enter, scroll, go_back, …, unclear` |
| Which thing on the page? | Jev `choice` | every visible interactive element becomes an option `e0…eN` with a compact description, plus an explicit `none` (the docs' *semantic find* pattern; ≤255 options) |
| Submit after typing? | Jev `noul` | `submit_after_typing` |
| Is this hard to undo? | Jev `noul` | `risky` — buy / delete / send / post → the app asks you to confirm |
| Which of several spoken URLs? | Jev `choice` | `url_pick`, only when the sentence contains more than one |
| Act | code | Playwright click / fill / goto / scroll with confidence gates |

All questions go in **one** `POST /v1/systemone` request (speculative fan-out); code reads
only the answers the chosen intent needs. Confidence below `THRESHOLDS.target` turns a
click into a “which one did you mean?” prompt with the top alternatives; you can answer by
voice (“the second one”) or by clicking a chip.

Without a `TYPESAFE_API_KEY` the exact same pipeline runs on keyword heuristics
(`decideHeuristically`) so you can try the UI first — the header pill tells you which mode
is active, and every log entry shows the source, intent confidence, latency and token
usage.

## Run it

Requirements: Node 20+, Chrome or Edge for voice input (the Web Speech API), a TypeSafe
API key (optional but recommended).

```bash
npm install
npx playwright install chromium      # once; skip if Playwright's Chromium is already present
cp .env.example .env                  # add TYPESAFE_API_KEY=...
export $(grep -v '^#' .env | xargs)   # or use your shell's dotenv of choice
npm start                             # builds the client, then serves it at http://localhost:3000
```

For development, `npm run dev` runs the Node server (with restart on change) and the Vite
dev server with hot reload side by side — open <http://localhost:5173>.

Open <http://localhost:3000> in Chrome, press the mic (or the space bar), and talk. The
controlled browser starts on Google (`START_URL` to change it); say “open …” to go
anywhere. A small built-in site at `/demo` is there for offline testing and is used
automatically if the start page can't be reached. Set `HEADLESS=false` to also see the
real Chromium window.

Microphone access needs a secure context: `http://localhost` or `https://`. Only *final*
transcripts are sent to the server; interim text is displayed but never acted on.

### Act in your own Chrome (the bridge extension)

By default commands run in a Playwright Chromium that is signed in to nothing. Load the bridge
extension and the same commands act on the tab you are looking at in your own Chrome — Slack,
Gmail, everything you are already logged in to. Hermes reaches it the same way through
`jev_browse`.

```bash
npm run build:extension               # → dist/extension
```

Then once, in Chrome: `chrome://extensions` → turn on **Developer mode** (top right) → **Load
unpacked** → pick `dist/extension`. That is all: the build wrote `dist/extension/config.json`
with this companion's socket and your `JEV_TOKEN`, so the extension pairs itself (the bridge
is refused without a token — it hands over your signed-in tab). The options page is only for
pointing it at another companion (`:3000` for `npm start`). The toolbar badge shows **on** while it is
connected; the companion logs `chrome: bridge connected` and every UI switches to the `chrome`
surface (and back to Playwright if the bridge drops). `chrome://` and the Web Store pages are
off limits to extensions, so switch to a normal tab first.

`npm run bridge:smoke -- "open wikipedia and search for cats"` proves the whole path in a
throwaway Chromium without touching your profile.

### The Mac itself (Hermes computer use)

Anything outside the browser — the desktop, native apps, files — is Hermes' job through its
`computer_use` tool (Cua's `cua-driver`, macOS). Two things Hermes' defaults do not do for you:

1. `hermes computer-use install`, then grant **CuaDriver** both *Accessibility* and *Screen &
   System Audio Recording* in System Settings → Privacy & Security. Check with
   `cua-driver call check_permissions` — the daemon must be the one reporting (launch it with
   `open -g -a CuaDriver --args serve`; run from a shell, macOS attributes the grant to the shell).
2. Hermes' built-in `hermes-api-server` toolset (what this companion talks to) deliberately
   leaves out `computer_use`. Give the API server its own list in `~/.hermes/config.yaml` —
   the `cli` list minus `clarify` and `tts` (Hermes writes the words, this companion speaks
   them) — then `hermes gateway restart`:

   ```yaml
   platform_toolsets:
     api_server:
       - browser
       - computer_use
       - file
       - terminal
       - web
       - vision
       # …the rest of your cli list, without clarify and tts
   ```

   `GET /v1/toolsets` on the API server shows `computer_use` with `enabled: true` when it took.
   The gateway checks tool availability when it starts, so restart it after installing the driver.

## Project layout

```
server/                      Node + TypeScript (Express, ws, Playwright, @typesafe-ai/sdk)
  index.ts                   HTTP + WebSocket server, command queue, confirm/clarify state, frame stream
  decide.ts                  Jev request builder, answer interpretation, thresholds, heuristic fallback
  commands.ts                speech normalization and verbatim extraction (URLs, text to type, yes/no, ordinals)
  elements.ts                in-page script that lists interactive elements → Jev choice options
  browser.ts                 Playwright session: snapshot, screenshot, viewport, execute(Action)
  actions.ts                 the Action union the browser can execute
  protocol.ts                WebSocket message types — imported by BOTH server and client
  demo.ts                    the local demo site
client/                      React 19 + Vite + TypeScript
  src/App.tsx                wires socket, speech and state together
  src/state.ts               one reducer: every server message → UI state (pure, unit-tested)
  src/hooks/useSocket.ts     typed WebSocket with auto-reconnect
  src/hooks/useSpeechRecognition.ts   Web Speech API: continuous listening, interim vs final results
  src/components/            LiveView, MicButton, CommandInput, ConfirmCard, ClarifyCard, DecisionLog, TopBar, Help
extension/                   Chrome bridge (MV3): background.ts socket + tab tracking, content.ts + dom-actions.ts in the page
scripts/build-extension.mjs  bundles it into dist/extension, inlining core/page-script.ts as real code (no eval)
test/                        vitest unit tests for the server logic (Jev client tested with a mocked fetch)
```

```bash
npm test          # unit tests (server logic + client reducer)
npm run typecheck # server and client
npm run check     # typecheck + tests + production build
```

## Safety model

- Jev only ever picks from **observed** elements and pre-parsed spans; it cannot invent a
  selector, URL or string.
- Actions the `risky` question flags (≥ 0.6) wait for a spoken or clicked confirmation.
  Navigation and scrolling are never gated.
- Page text is data, not instructions: it only appears as option descriptions.
- The controlled browser is a fresh Playwright profile; nothing from your own browser is
  shared with it.

## Notes & limits

- Voice input relies on the browser's Web Speech API (Chrome/Edge). Firefox and Safari can
  still drive everything from the text box.
- Jev 1.13 reads literally and is weaker on numbers and multi-hop reasoning (see the docs'
  jaggedness page), so all counting, arithmetic and string handling stay in code.
- `playwright` is pinned to 1.56.x to match a pre-installed Chromium; bump freely and
  re-run `npx playwright install chromium`.

## References

- Jev / TypeSafe docs: <https://docs.typesafe.ai> — API reference, primitives (choice, noul,
  score), patterns (fan-out, confidence routing, intent routing), cookbooks
- JavaScript SDK: `@typesafe-ai/sdk` — <https://docs.typesafe.ai/sdk/javascript>
