"use client";

import { useEffect, useState } from "react";
import { CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { studioDataChangedEvent } from "@/components/studio/events";
import { isVisibleImageModel } from "@/lib/models/huggingface-image";

type ModelDTO = {
  id: string;
  name: string;
  provider: string;
  licenceStatus: string;
  isEnabled: boolean;
  capabilities: unknown;
};

function capabilityCount(capabilities: unknown) {
  return Array.isArray(capabilities) ? capabilities.length : 0;
}

export function AdminModelPanel() {
  const [models, setModels] = useState<ModelDTO[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "setup" | "auth" | "error">("loading");

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      setState("loading");
      try {
        const response = await fetch("/api/models?includeDisabled=true", { cache: "no-store" });

        if (response.status === 401 || response.status === 403) {
          if (!cancelled) {
            setModels([]);
            setState("auth");
          }
          return;
        }

        const payload = (await response.json()) as { models?: ModelDTO[]; setupRequired?: boolean };

        if (!cancelled) {
          setModels((payload.models ?? []).filter((model) => isVisibleImageModel(model.id)));
          setState(payload.setupRequired ? "setup" : response.ok ? "ready" : "error");
        }
      } catch {
        if (!cancelled) {
          setState("error");
        }
      }
    }

    loadModels();
    window.addEventListener(studioDataChangedEvent, loadModels);

    return () => {
      cancelled = true;
      window.removeEventListener(studioDataChangedEvent, loadModels);
    };
  }, []);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">Model Governance</h2>
        <div className="panel-actions">
          <span className={state === "ready" ? "badge" : "badge warn"}>{state === "ready" ? "Catalog" : "Setup"}</span>
          <button className="icon-button compact" onClick={() => window.dispatchEvent(new Event(studioDataChangedEvent))} title="Refresh governance" type="button" aria-label="Refresh governance">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="admin-list">
          {state === "loading" ? <p className="item-meta">Loading governance records...</p> : null}
          {state === "setup" ? (
            <div className="admin-item">
              <p className="item-title">No model records seeded</p>
              <p className="item-meta">Seed providers and models in MongoDB before enabling generation.</p>
            </div>
          ) : null}
          {state === "auth" ? (
            <div className="admin-item">
              <p className="item-title">Admin access required</p>
              <p className="item-meta">Disabled model records and governance controls require administrator or model-manager access.</p>
            </div>
          ) : null}
          {state === "error" ? (
            <div className="admin-item">
              <p className="item-title">Governance unavailable</p>
              <p className="item-meta">Check MongoDB connectivity and model collection configuration.</p>
            </div>
          ) : null}
          {models.map((model) => {
            const clear = model.isEnabled && model.licenceStatus === "approved";
            const Icon = clear ? ShieldCheck : CircleAlert;

            return (
              <div className="admin-item" key={model.id}>
                <div className="item-top">
                  <div>
                    <p className="item-title">{model.name}</p>
                    <p className="item-meta">
                      {model.provider} - {capabilityCount(model.capabilities)} capabilities
                    </p>
                  </div>
                  <span className={clear ? "badge" : "badge warn"}>
                    <Icon size={12} aria-hidden="true" />
                    {clear ? "Clear" : model.isEnabled ? "Review" : "Disabled"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
