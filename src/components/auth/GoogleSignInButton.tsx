"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { announceSessionChanged, sessionChangedEvent } from "@/components/studio/events";
import { loadGoogleScript } from "@/lib/auth/google-script";
import { apiErrorMessage, fetchWithTimeout } from "@/lib/http/client";

declare global {
  interface Window {
    google?: {
      accounts: { id: {
        initialize(config: { client_id: string; callback: (response: { credential?: string }) => void; ux_mode?: "popup" | "redirect" }): void;
        renderButton(element: HTMLElement, options: { theme?: "outline"; size?: "large"; type?: "standard"; shape?: "rectangular"; text?: "signin_with"; width?: number }): void;
        disableAutoSelect(): void;
      } };
    };
  }
}

type AuthenticatedUser = { id: string; email?: string; displayName?: string; role: string };
export type SessionState = "checking" | "authenticated" | "unauthenticated" | "error";

export function GoogleSignInButton({ onSessionStateChange }: { onSessionStateChange?(state: SessionState): void }) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const operation = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);
  const confirmedSession = useRef(false);
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [status, setStatus] = useState<"loading" | "ready" | "signing-in" | "signing-out" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => { onSessionStateChange?.(sessionState); }, [onSessionStateChange, sessionState]);

  useEffect(() => {
    mounted.current = true;
    async function loadCurrentUser() {
      if (busy.current) return;
      const requestId = ++operation.current;
      setSessionState("checking");
      setUser(null);
      try {
        const response = await fetchWithTimeout("/api/me", { cache: "no-store" });
        const payload = await response.json().catch(() => null) as { user?: AuthenticatedUser } | null;
        if (!mounted.current || requestId !== operation.current) return;
        if (response.status === 401) {
          confirmedSession.current = false;
          setSessionState("unauthenticated");
          setStatus("loading");
          setMessage(null);
        } else if (response.ok && payload?.user) {
          confirmedSession.current = true;
          setUser(payload.user);
          setSessionState("authenticated");
          setStatus("ready");
          setMessage(null);
        } else {
          confirmedSession.current = false;
          setSessionState("error");
          setStatus("error");
          setMessage(apiErrorMessage(payload, "Unable to check your session. Retry."));
        }
      } catch {
        if (mounted.current && requestId === operation.current) {
          setSessionState("error");
          setStatus("error");
          setMessage("Unable to check your session. Check your connection, then retry.");
        }
      }
    }
    void loadCurrentUser();
    function refreshOnFocus() { if (confirmedSession.current) void loadCurrentUser(); }
    window.addEventListener(sessionChangedEvent, loadCurrentUser);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      mounted.current = false;
      operation.current += 1;
      window.removeEventListener(sessionChangedEvent, loadCurrentUser);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [retryKey]);

  useEffect(() => {
    if (sessionState !== "unauthenticated") return;
    let cancelled = false;
    async function initialise() {
      try {
        const configResponse = await fetchWithTimeout("/api/auth/config", { cache: "no-store" });
        const configPayload = await configResponse.json().catch(() => null) as { clientId?: string } | null;
        const clientId = configPayload?.clientId?.trim();
        if (!configResponse.ok || !clientId) {
          throw new Error(apiErrorMessage(configPayload, "Google sign-in configuration is unavailable."));
        }
        await loadGoogleScript();
        if (cancelled || !buttonRef.current || !window.google?.accounts.id) return;
        buttonRef.current.replaceChildren();
        window.google.accounts.id.initialize({
          client_id: clientId, ux_mode: "popup",
          callback: async ({ credential }) => {
            if (cancelled || busy.current || !mounted.current) return;
            if (!credential) { setStatus("error"); setMessage("Google did not return a credential. Retry sign-in."); return; }
            busy.current = true;
            const requestId = ++operation.current;
            setStatus("signing-in");
            setMessage(null);
            try {
              const response = await fetchWithTimeout("/api/auth/session", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential, clientId })
              });
              const payload = await response.json().catch(() => null);
              if (!response.ok) throw new Error(apiErrorMessage(payload, "Google sign-in failed. Retry."));
              // A POST response alone does not prove the browser stored the HttpOnly cookie.
              const me = await fetchWithTimeout("/api/me", { cache: "no-store" });
              const current = await me.json().catch(() => null) as { user?: AuthenticatedUser } | null;
              if (!me.ok || !current?.user) throw new Error(apiErrorMessage(current, "Session could not be confirmed. Allow cookies; production sign-in requires HTTPS. Retry."));
              if (!mounted.current || requestId !== operation.current) return;
              setUser(current.user);
              confirmedSession.current = true;
              setSessionState("authenticated");
              setStatus("ready");
              setMessage(null);
              announceSessionChanged();
            } catch (error) {
              if (mounted.current && requestId === operation.current) {
                setUser(null);
                setSessionState("error");
                setStatus("error");
                setMessage(error instanceof Error ? error.message : "Google sign-in failed. Retry.");
              }
            } finally { busy.current = false; }
          }
        });
        window.google.accounts.id.renderButton(buttonRef.current, { theme: "outline", size: "large", type: "standard", shape: "rectangular", text: "signin_with", width: 182 });
        setStatus("ready");
      } catch (error) {
        if (!cancelled) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Google sign-in could not load. Retry."); }
      }
    }
    void initialise();
    const container = buttonRef.current;
    return () => { cancelled = true; container?.replaceChildren(); };
  }, [retryKey, sessionState]);

  async function logout() {
    if (busy.current) return;
    busy.current = true;
    const requestId = ++operation.current;
    setStatus("signing-out");
    setSessionState("checking");
    setMessage(null);
    try {
      const response = await fetchWithTimeout("/api/auth/session", { method: "DELETE" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(payload, "Sign-out failed. Retry."));
      if (!mounted.current || requestId !== operation.current) return;
      window.google?.accounts.id.disableAutoSelect();
      confirmedSession.current = false;
      setUser(null);
      setSessionState("unauthenticated");
      setStatus("loading");
      announceSessionChanged();
    } catch (error) {
      if (mounted.current && requestId === operation.current) {
        setUser(null);
        setSessionState("error");
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Sign-out could not be confirmed. Retry to check your session.");
      }
    } finally { busy.current = false; }
  }

  return (
    <div className="google-button-shell">
      {sessionState === "checking" ? <span className="auth-message">Checking session...</span> : null}
      {user ? <div className="account-widget">
        <div className="account-copy"><span>{user.displayName ?? user.email ?? "Signed in"}</span><small>{user.role}</small></div>
        <button className="icon-button" disabled={status === "signing-out"} onClick={logout} title="Sign out" type="button" aria-label="Sign out"><LogOut size={16} aria-hidden="true" /></button>
      </div> : null}
      <div ref={buttonRef} hidden={sessionState !== "unauthenticated" || status === "signing-in"} />
      {status === "loading" && sessionState === "unauthenticated" ? <span className="auth-message">Loading Google sign-in...</span> : null}
      {status === "ready" && sessionState === "unauthenticated" ? <small className="auth-message">If Google rejects this site, add its exact origin (scheme, host and port) to Authorized JavaScript origins in Google Console.</small> : null}
      {status === "signing-in" || status === "signing-out" ? <span className="auth-message">{status === "signing-in" ? "Signing in..." : "Signing out..."}</span> : null}
      {status === "error" ? <div className="auth-error" role="alert"><span>{message}</span><button className="button subtle" onClick={() => setRetryKey((value) => value + 1)} type="button">Retry</button></div> : null}
    </div>
  );
}
