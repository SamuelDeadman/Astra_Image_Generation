"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { KeyRound, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { announceStudioDataChanged, sessionChangedEvent, studioDataChangedEvent } from "@/components/studio/events";

type Credential = {
  id: string;
  provider: string;
  label: string;
  mode: string;
  maskedSecret: string;
  createdAt: string;
  lastUsedAt?: string;
};

type Provider = {
  id: string;
  name: string;
  route: string;
  credentialSchema?: unknown;
};

export function ProviderKeysPanel() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "auth" | "error">("loading");
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId),
    [providers, selectedProviderId]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadProviders() {
      setState("loading");
      try {
        const response = await fetch("/api/providers", { cache: "no-store" });

        if (response.status === 401) {
          if (!cancelled) {
            setProviders([]);
            setCredentials([]);
            setState("auth");
          }
          return;
        }

        const payload = (await response.json()) as { providers?: Provider[]; credentials?: Credential[] };

        if (!cancelled) {
          const loadedProviders = payload.providers ?? [];
          setProviders(loadedProviders);
          setCredentials(payload.credentials ?? []);
          setSelectedProviderId((current) => current || loadedProviders[0]?.id || "");
          setState(response.ok ? "ready" : "error");
        }
      } catch {
        if (!cancelled) {
          setState("error");
        }
      }
    }

    loadProviders();
    window.addEventListener(sessionChangedEvent, loadProviders);
    window.addEventListener(studioDataChangedEvent, loadProviders);

    return () => {
      cancelled = true;
      window.removeEventListener(sessionChangedEvent, loadProviders);
      window.removeEventListener(studioDataChangedEvent, loadProviders);
    };
  }, []);

  async function submitCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedProviderId) {
      setMessage("Choose a BYOK provider before saving a credential.");
      return;
    }

    setSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(selectedProviderId)}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, mode: "saved-encrypted", secret })
      });
      const payload = (await response.json()) as { error?: { message?: string } | string };

      if (!response.ok) {
        const errorMessage = typeof payload.error === "string" ? payload.error : payload.error?.message;
        setMessage(errorMessage ?? "Credential could not be saved.");
        return;
      }

      setLabel("");
      setSecret("");
      setFormOpen(false);
      setMessage("Credential saved and encrypted.");
      announceStudioDataChanged();
    } catch {
      setMessage("Credential could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteCredential(providerId: string) {
    const shouldDelete = window.confirm("Delete saved credentials for this provider?");

    if (!shouldDelete) {
      return;
    }

    setMessage(null);
    const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/credentials`, {
      method: "DELETE"
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      setMessage(payload?.error?.message ?? "Credential could not be deleted.");
      return;
    }

    setMessage("Credential deleted.");
    announceStudioDataChanged();
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">BYOK Providers</h2>
        <div className="panel-actions">
          <button
            className="icon-button compact"
            disabled={state !== "ready" || providers.length === 0}
            onClick={() => {
              setFormOpen(true);
              setMessage(null);
            }}
            title="Add credential"
            type="button"
            aria-label="Add credential"
          >
            <KeyRound size={16} aria-hidden="true" />
          </button>
          <button className="icon-button compact" onClick={() => announceStudioDataChanged()} title="Refresh providers" type="button" aria-label="Refresh providers">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="provider-list">
          {state === "loading" ? <p className="item-meta">Loading provider credentials...</p> : null}
          {state === "auth" ? (
            <div className="provider-item">
              <p className="item-title">Sign in required</p>
              <p className="item-meta">Saved provider credentials are encrypted and account-scoped.</p>
            </div>
          ) : null}
          {state === "error" ? (
            <div className="provider-item">
              <p className="item-title">Provider service unavailable</p>
              <p className="item-meta">Check database and KMS configuration before saving credentials.</p>
            </div>
          ) : null}
          {state === "ready" && providers.length === 0 ? (
            <div className="provider-item">
              <p className="item-title">No BYOK providers enabled</p>
              <p className="item-meta">Only Google AI Studio keys are currently supported. GCP and Vertex are app-managed; no user cloud keys.</p>
            </div>
          ) : null}
          {state === "ready" && providers.length > 0 ? (
            <div className="provider-item">
              <p className="item-title">Provider route</p>
              <div className="chip-row">
                {providers.map((provider) => (
                  <button
                    className={provider.id === selectedProviderId ? "chip chip-button selected" : "chip chip-button"}
                    disabled={provider.id !== "google-ai-studio" || provider.route !== "google-ai-studio-image"}
                    key={provider.id}
                    onClick={() => setSelectedProviderId(provider.id)}
                    type="button"
                  >
                    {provider.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {formOpen ? (
            <form className="provider-form" onSubmit={submitCredential}>
              <label>
                <span>Label</span>
                <input value={label} onChange={(event) => setLabel(event.target.value)} minLength={1} maxLength={80} required />
              </label>
              <label>
                <span>Secret</span>
                <input value={secret} onChange={(event) => setSecret(event.target.value)} minLength={12} maxLength={4096} required type="password" />
              </label>
              <div className="chip-row">
                <button className="button primary" disabled={submitting || !selectedProvider} type="submit">
                  Save encrypted key
                </button>
                <button className="button subtle" onClick={() => setFormOpen(false)} type="button">
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          {message ? <p className="form-message">{message}</p> : null}
          {state === "ready" && credentials.length === 0 ? (
            <div className="provider-item">
              <p className="item-title">No saved credentials</p>
              <p className="item-meta">Session-only keys can be used later without storage; saved keys require Cloud KMS.</p>
            </div>
          ) : null}
          {credentials.map((credential) => (
            <div className="provider-item" key={credential.id}>
              <div className="item-top">
                <div>
                  <p className="item-title">{credential.provider}</p>
                  <p className="item-meta">{credential.label} - {credential.maskedSecret}</p>
                </div>
                <span className="badge gray">{credential.mode === "SAVED_ENCRYPTED" ? "KMS" : "Session"}</span>
              </div>
              <div className="chip-row">
                <button
                  className="button subtle"
                  onClick={() => {
                    setSelectedProviderId(credential.provider);
                    setLabel(credential.label);
                    setSecret("");
                    setFormOpen(true);
                  }}
                  type="button"
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  Replace
                </button>
                <button className="button subtle" onClick={() => deleteCredential(credential.provider)} type="button">
                  <Trash2 size={14} aria-hidden="true" />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
