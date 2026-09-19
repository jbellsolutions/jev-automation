/** Options page: where the companion is and the token it expects. */
const urlInput = document.getElementById("url") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const statusEl = document.getElementById("status")!;

chrome.storage.local.get(["url", "token"]).then((s) => {
  urlInput.value = (s.url as string | undefined) ?? "ws://127.0.0.1:3111/ws/bridge";
  tokenInput.value = (s.token as string | undefined) ?? "";
});

document.getElementById("save")!.addEventListener("click", async () => {
  await chrome.storage.local.set({ url: urlInput.value.trim(), token: tokenInput.value.trim() });
  statusEl.textContent = "Saved — reconnecting…";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});
