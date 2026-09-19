/** Runs in the renderer before the page, with Node isolated away. Exposes only what the UI
 *  needs from the shell: that it is the desktop build, where the companion is, and the hotkey. */
import { contextBridge, ipcRenderer } from "electron";

const baseUrl = process.argv.find((a) => a.startsWith("--jev-base-url="))?.slice("--jev-base-url=".length) ?? "";

contextBridge.exposeInMainWorld("jev", {
  mode: "desktop",
  baseUrl,
  /** Start listening as soon as the companion says hello (JEV_AUTOLISTEN=1, for smoke tests). */
  autoListen: process.argv.includes("--jev-autolisten"),
  onToggleListening(cb: () => void): () => void {
    const handler = () => cb();
    ipcRenderer.on("jev:toggle-listening", handler);
    return () => ipcRenderer.off("jev:toggle-listening", handler);
  },
  onStopListening(cb: () => void): () => void {
    const handler = () => cb();
    ipcRenderer.on("jev:stop-listening", handler);
    return () => ipcRenderer.off("jev:stop-listening", handler);
  },
  setListening(listening: boolean): void {
    ipcRenderer.send("jev:listening", listening);
  },
  hide(): void {
    ipcRenderer.send("jev:hide");
  },
});
