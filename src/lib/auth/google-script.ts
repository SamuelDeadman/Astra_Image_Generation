export const googleScriptSrc = "https://accounts.google.com/gsi/client";
let pending: Promise<void> | undefined;

// Share in-flight loads across mounts; failed scripts must be replaced on retry.
export function loadGoogleScript(timeoutMs = 15000): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (pending) return pending;
  pending = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${googleScriptSrc}"]`);
    const script = existing ?? document.createElement("script");
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    function finish(ok: boolean) {
      window.clearTimeout(timer);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
      if (ok) resolve();
      else {
        script.remove();
        reject(new Error("Google sign-in could not load. Allow accounts.google.com in your browser/network settings, then retry."));
      }
    }
    function loaded() { finish(Boolean(window.google?.accounts?.id)); }
    function failed() { finish(false); }
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = googleScriptSrc;
      script.async = true;
      document.head.appendChild(script);
    }
  }).finally(() => { pending = undefined; });
  return pending;
}
