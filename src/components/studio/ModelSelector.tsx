"use client";

import { useEffect, useState } from "react";
import { Cpu, Gauge, RefreshCw, ShieldAlert } from "lucide-react";
import { studioDataChangedEvent, sessionChangedEvent } from "@/components/studio/events";
import { getModelById } from "@/lib/models/catalog";
import { isVisibleImageModel } from "@/lib/models/huggingface-image";
import type { ProviderRoute } from "@/lib/workflow/schema";
import { apiErrorMessage, fetchWithTimeout } from "@/lib/http/client";

type ModelDTO = {
  id: string;
  name: string;
  route: ProviderRoute;
  family: string;
  provider: string;
  licenceStatus: string;
  capabilities?: unknown;
  maxPixels: number;
  maxSteps: number;
  baseCreditCost: number;
  availability?: "available" | "requires-credentials" | "development-only" | "not-configured" | "unavailable";
  isEnabled: boolean;
  generationUnavailableReason?: string;
};

type ModelSelectorProps = {
  selectedModelId: string;
  executionEnvironment: string;
  models?: ModelDTO[];
  onSelectModel(model: ModelDTO): void;
  onModelsLoaded?(models: ModelDTO[]): void;
  onCatalogueStateChange?(message: string | null): void;
};

function capabilityLabels(capabilities: unknown) {
  return Array.isArray(capabilities)
    ? capabilities.filter((capability): capability is string => typeof capability === "string").slice(0, 3)
    : [];
}

export function ModelSelector({ selectedModelId, executionEnvironment, models, onSelectModel, onModelsLoaded, onCatalogueStateChange }: ModelSelectorProps) {
  const [loadedModels, setLoadedModels] = useState<ModelDTO[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "setup" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const visibleModels = (models ?? loadedModels).filter((model) => isVisibleImageModel(model.id));

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;

    async function loadModels() {
      const requestId = ++sequence;
      setState("loading");
      onCatalogueStateChange?.("Loading model catalogue. Wait for it to finish.");
      try {
        const response = await fetchWithTimeout("/api/models", { cache: "no-store" });
        const payload = (await response.json()) as { models?: ModelDTO[]; setupRequired?: boolean };

        if (cancelled || requestId !== sequence) {
          return;
        }

        const loadedModels = response.ok ? (payload.models ?? []).filter((model) => isVisibleImageModel(model.id)) : [];
        setLoadedModels(loadedModels);
        onModelsLoaded?.(loadedModels);
        const issue = !response.ok ? apiErrorMessage(payload, "Model catalogue unavailable. Check MongoDB and retry.") : loadedModels.length === 0 ? "No enabled models. Run controlled /ready setup and npm run seed:dev; both provider and model records must be enabled." : null;
        setMessage(issue);
        onCatalogueStateChange?.(issue);
        setState(!response.ok ? "error" : loadedModels.length === 0 ? "setup" : "ready");
      } catch {
        if (!cancelled && requestId === sequence) {
          setState("error");
          setLoadedModels([]);
          onModelsLoaded?.([]);
          const issue = "Model catalogue request failed. Check your connection and refresh models.";
          setMessage(issue);
          onCatalogueStateChange?.(issue);
        }
      }
    }

    loadModels();
    window.addEventListener(studioDataChangedEvent, loadModels);
    window.addEventListener(sessionChangedEvent, loadModels);

    return () => {
      cancelled = true;
      window.removeEventListener(studioDataChangedEvent, loadModels);
      window.removeEventListener(sessionChangedEvent, loadModels);
    };
  }, [onModelsLoaded, onCatalogueStateChange]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">Model Catalogue</h2>
        <div className="panel-actions">
          <span className={state === "ready" ? "badge" : "badge warn"}>{state === "ready" ? "Loaded" : state === "loading" ? "Loading" : "Setup"}</span>
          <button className="icon-button compact" onClick={() => window.dispatchEvent(new Event(studioDataChangedEvent))} title="Refresh models" type="button" aria-label="Refresh models">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="model-list">
          {state === "loading" ? <p className="item-meta">Loading model catalogue...</p> : null}
          {state === "setup" ? (
            <div className="model-item">
              <p className="item-title">Model catalogue requires seeding</p>
              <p className="item-meta">{message}</p>
            </div>
          ) : null}
          {state === "error" ? (
            <div className="model-item">
              <p className="item-title">Model service unavailable</p>
              <p className="item-meta" role="alert">{message}</p>
            </div>
          ) : null}
          {state === "ready" && visibleModels.length === 0 ? (
            <div className="model-item">
              <p className="item-title">No compatible model</p>
              <p className="item-meta">Current environment: {executionEnvironment}</p>
            </div>
          ) : null}
          {visibleModels.map((model) => (
            <button
              className={selectedModelId === model.id ? "model-item selectable selected" : "model-item selectable"}
              key={model.id}
              onClick={() => onSelectModel(model)}
              type="button"
            >
              <div className="item-top">
                <div>
                  <p className="item-title">{model.name}</p>
                  <p className="item-meta">{model.family} - {model.provider}</p>
                </div>
                <span className={model.availability === "available" ? "badge" : "badge warn"}>
                  {model.availability === "available" ? "Ready" : model.availability === "requires-credentials" ? "Your key required" : model.availability === "development-only" ? "Development only" : model.availability === "not-configured" ? "App setup" : "Unavailable"}
                </span>
              </div>
              <div className="chip-row">
                <span className="chip">
                  <Cpu size={12} aria-hidden="true" /> {Math.round(model.maxPixels / 100000) / 10}MP
                </span>
                <span className="chip">
                  <Gauge size={12} aria-hidden="true" /> {model.maxSteps ? `${model.maxSteps} steps maximum` : "Provider-managed sampling"}
                </span>
                {model.licenceStatus === "review-required" ? (
                  <span className="chip">
                    <ShieldAlert size={12} aria-hidden="true" /> licence record
                  </span>
                ) : null}
                {capabilityLabels(model.capabilities).map((capability) => (
                  <span className="chip" key={capability}>{capability}</span>
                ))}
                <span className="chip">{model.baseCreditCost} credits base</span>
              </div>
              {model.generationUnavailableReason ? <p className="item-meta">{model.generationUnavailableReason}</p> : null}
              {model.route === "development-fake" ? <p className="item-meta">Development placeholder only; no real image bytes are generated.</p> : null}
              <span className="item-meta">{getModelById(model.id)?.providerModelId} Â· catalogue ID: {model.id}</span>
              <span className="item-meta">{getModelById(model.id)?.capabilities.join(", ")} Â· {getModelById(model.id)?.modalities.input.join(" + ")} â†’ {getModelById(model.id)?.modalities.output.join(" + ")}</span>
              <span className="item-meta">{getModelById(model.id)?.resolutions.map((size) => `${size.width} Ã— ${size.height} (${size.imageSize})`).join(", ") || "Development test bounds: 256â€“1536 pixels in increments of 8"}</span>
              <span className="item-meta">{getModelById(model.id)?.limitsNote}</span>
              {getModelById(model.id)?.unsupportedParameters.length ? <span className="item-meta">Unsupported controls: {getModelById(model.id)?.unsupportedParameters.join(", ")}.</span> : null}
              <span className="item-meta">Up to {getModelById(model.id)?.maxInputImages} reference image, {Math.round((getModelById(model.id)?.maxInputBytes ?? 0) / 1024 / 1024)} MiB. Output formats: {getModelById(model.id)?.outputFormats.join(", ")}.</span>
              <span className="item-meta">{getModelById(model.id)?.licence} Â· {getModelById(model.id)?.licenceStatus}</span>
              <span className="item-meta">{getModelById(model.id)?.costLabel}</span>
              <span className="item-meta">Documentation checked {getModelById(model.id)?.verifiedOn}; live readiness is reported separately.</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
