/** The Jev desktop face: a floating always-on-top panel over the same companion the CLI runs,
 *  in-process. ⌥Space shows the panel and starts listening; the tray shows what it is doing. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, nativeImage, screen, session, systemPreferences } from "electron";
import { createDecider } from "../core/decide.js";
import { createCompanion } from "../server/companion.js";
import { selectComputer } from "../server/computer.js";
import { loadEnvFile } from "../server/env.js";
import { createBrain } from "../server/hermes.js";
import { PlaywrightExecutor } from "../server/executors/playwright.js";
import { describeSpeaker, selectSpeaker } from "../server/speak/select.js";
import { selectSttProvider } from "../server/stt/select.js";
import { type PanelState, onEscape, onHotkey, onRendererListening, onRendererSpeaking, onWindowVisibility } from "./hotkey.js";
import { trayIconPng } from "./tray-icon.js";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/app
const root = path.join(here, "..", "..");
// The app is launched from the Dock / at login with no shell around it: read the project's .env itself.
const envKeys = loadEnvFile(path.join(root, ".env"));
const PORT = Number(process.env.JEV_APP_PORT ?? 3111);
const HOTKEY = process.env.JEV_HOTKEY ?? "Alt+Space";
const PANEL = { width: 440, height: 720 };

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let panel: PanelState = { visible: false, listening: false };
let baseUrl = "";

function icon(kind: "idle" | "listening" | "busy") {
  const img = nativeImage.createFromBuffer(trayIconPng(kind, 44), { scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function applyEffects(effects: ReturnType<typeof onHotkey>["effects"]) {
  for (const e of effects) {
    switch (e) {
      case "show":
        showPanel();
        break;
      case "hide":
        win?.hide();
        break;
      case "focus":
        win?.focus();
        break;
      case "start_listening":
      case "stop_listening":
        // the renderer owns the microphone; it toggles and reports back through jev:listening
        win?.webContents.send(e === "start_listening" ? "jev:toggle-listening" : "jev:stop-listening");
        break;
      case "interrupt":
        // the renderer holds the companion socket; it asks the session to stop talking
        win?.webContents.send("jev:interrupt");
        break;
    }
  }
  refreshTray();
}

function refreshTray() {
  tray?.setImage(icon(panel.listening ? "listening" : "idle"));
  tray?.setToolTip(panel.listening ? "Jev — listening (⌥Space or Esc to stop)" : `Jev — ${HOTKEY.replace("Alt", "⌥").replace("+", "")} to talk`);
}

function placeBottomRight(w: BrowserWindow) {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  w.setPosition(workArea.x + workArea.width - PANEL.width - 16, workArea.y + workArea.height - PANEL.height - 16, false);
}

function showPanel() {
  if (!win) return;
  if (!win.isVisible()) placeBottomRight(win);
  win.show();
  panel = onWindowVisibility(panel, true);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    ...PANEL,
    minWidth: 360,
    minHeight: 480,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    titleBarStyle: "hidden",
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#10141b",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--jev-base-url=${baseUrl}`, ...(process.env.JEV_AUTOLISTEN ? ["--jev-autolisten"] : [])],
    },
  });
  // renderer console → our stdout, so `electron .` logs tell the whole story
  w.webContents.on("console-message", (ev) => {
    const level = ev.level === "error" ? "ERR" : ev.level === "warning" ? "WARN" : "LOG";
    console.log(`[renderer ${level}] ${ev.message}`);
  });
  w.setAlwaysOnTop(true, "floating");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.on("close", (e) => {
    // closing the panel just hides it; the tray keeps the assistant alive
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on("hide", () => {
    panel = onWindowVisibility(panel, false);
    refreshTray();
  });
  w.on("show", () => {
    panel = onWindowVisibility(panel, true);
    refreshTray();
  });
  void w.loadURL(`${baseUrl}/?mode=desktop`);
  return w;
}

let quitting = false;

async function main() {
  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  // The renderer captures the mic; ask up front (without blocking startup on the dialog) so the
  // first ⌥Space is not a permission prompt.
  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    console.log(`microphone access: ${status}`);
    if (status !== "granted") void systemPreferences.askForMediaAccess("microphone").then((ok) => console.log(`microphone access: ${ok ? "granted" : "denied"}`));
  }

  const decider = createDecider();
  const stt = selectSttProvider(process.env, { appleBin: path.join(root, "native", "jev-speech", "jev-speech") });
  const speaker = selectSpeaker();
  const brain = createBrain();
  const computer = selectComputer();
  const companion = createCompanion({
    decider,
    token: process.env.JEV_TOKEN,
    clientDir: path.join(root, "dist", "client"),
    defaultSession: process.env.JEV_DEFAULT_SESSION,
    stt,
    speaker,
    brain,
    computer,
  });
  if (brain) void brain.health().then((h) => console.log(h.ok ? `brain: Hermes (${h.detail})` : `brain: Hermes not reachable — ${h.detail}`));
  else console.log("brain: none (set HERMES_API_KEY)");
  const port = await companion.listen(PORT);
  baseUrl = `http://127.0.0.1:${port}`;
  const playwright = new PlaywrightExecutor({
    headless: (process.env.HEADLESS ?? "true").toLowerCase() !== "false",
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    args: (process.env.CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean),
    startUrl: process.env.START_URL ?? "https://www.google.com",
    fallbackUrl: `${baseUrl}/demo`,
    viewport: { width: 1024, height: 640 },
    deviceScaleFactor: Number(process.env.DEVICE_SCALE_FACTOR ?? 2),
    jpegQuality: Number(process.env.JPEG_QUALITY ?? 80),
  });
  companion.register(playwright);
  void playwright.start();

  // Only our own renderer gets the microphone.
  if (!process.env.JEV_DEBUG_NO_PERM) {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ok = permission === "media" && wc.getURL().startsWith(baseUrl);
      console.log(`permission request: ${permission} ${JSON.stringify(details)} → ${ok}`);
      callback(ok);
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
      const ok = permission === "media" && origin.startsWith(baseUrl);
      console.log(`permission check: ${permission} ${origin} → ${ok}`);
      return ok;
    });
  }

  win = createWindow();
  tray = new Tray(icon("idle"));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Jev", click: () => showPanel() },
      { label: `Talk (${HOTKEY})`, click: () => applyEffects(onHotkey(panel).effects) },
      { type: "separator" },
      { label: `Voice in: ${stt ? stt.name : "browser speech"} · out: ${describeSpeaker(speaker)}`, enabled: false },
      { label: `Jev: ${decider.enabled ? decider.model : "heuristics"}`, enabled: false },
      { type: "separator" },
      { label: "Quit Jev", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => (win?.isVisible() ? win.hide() : showPanel()));
  refreshTray();

  ipcMain.on("jev:listening", (_e, listening: boolean) => {
    panel = onRendererListening(panel, !!listening);
    refreshTray();
  });
  ipcMain.on("jev:speaking", (_e, speaking: boolean) => {
    panel = onRendererSpeaking(panel, !!speaking);
  });
  ipcMain.on("jev:hide", () => applyEffects(onEscape({ ...panel, listening: false, speaking: false }).effects));

  if (!globalShortcut.register(HOTKEY, () => applyEffects(onHotkey(panel).effects))) {
    console.error(`Could not register the ${HOTKEY} hotkey; use the tray menu.`);
  }
  showPanel();
  console.log(`Jev desktop → ${baseUrl}  hotkey ${HOTKEY}  voice in: ${stt?.name ?? "web speech"}  out: ${describeSpeaker(speaker)}${envKeys.length ? `  (.env: ${envKeys.length} keys)` : ""}`);

  app.on("before-quit", () => {
    quitting = true;
    globalShortcut.unregisterAll();
    void companion.close();
  });
}

app.on("window-all-closed", () => {
  /* stay in the tray */
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.quit());

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  app.exit(1);
});
