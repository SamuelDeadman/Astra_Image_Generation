"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { Download, Image as ImageIcon, RefreshCw, Upload } from "lucide-react";
import { announceStudioDataChanged, sessionChangedEvent, studioDataChangedEvent } from "@/components/studio/events";

type AssetDTO = {
  id: string;
  kind: string;
  contentType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  visibility: string;
  uploadState?: string;
  createdAt: string;
};

type SignedDownload = {
  download?: {
    url: string;
    expiresAt: string;
  };
};

function assetTitle(asset: AssetDTO) {
  return asset.kind.replaceAll("_", " ").toLowerCase();
}

function assetMeta(asset: AssetDTO) {
  const dimensions = asset.width && asset.height ? `${asset.width} x ${asset.height}` : asset.contentType;
  const size = asset.sizeBytes ? `${Math.round(asset.sizeBytes / 1024)} KB` : asset.visibility;
  return `${dimensions} - ${size}`;
}

export function GalleryRail() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [assets, setAssets] = useState<AssetDTO[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [state, setState] = useState<"loading" | "ready" | "auth" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadAssets() {
      setState("loading");
      try {
        const response = await fetch("/api/assets", { cache: "no-store" });

        if (response.status === 401) {
          if (!cancelled) {
            setAssets([]);
            setState("auth");
          }
          return;
        }

        const payload = (await response.json()) as { assets?: AssetDTO[] };

        if (!cancelled) {
          setAssets(payload.assets ?? []);
          setState(response.ok ? "ready" : "error");
        }
      } catch {
        if (!cancelled) {
          setState("error");
        }
      }
    }

    loadAssets();
    window.addEventListener(sessionChangedEvent, loadAssets);
    window.addEventListener(studioDataChangedEvent, loadAssets);

    return () => {
      cancelled = true;
      window.removeEventListener(sessionChangedEvent, loadAssets);
      window.removeEventListener(studioDataChangedEvent, loadAssets);
    };
  }, []);

  async function signDownload(assetId: string) {
    const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/download-url`, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as (SignedDownload & { error?: { message?: string } }) | null;

    if (!response.ok || !payload?.download?.url) {
      throw new Error(payload?.error?.message ?? "Download URL could not be created.");
    }

    setPreviewUrls((current) => ({ ...current, [assetId]: payload.download!.url }));
    return payload.download.url;
  }

  async function previewAsset(assetId: string) {
    setMessage(null);
    try {
      await signDownload(assetId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Asset preview failed.");
    }
  }

  async function downloadAsset(assetId: string) {
    setMessage(null);
    try {
      const url = await signDownload(assetId);
      window.location.assign(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Asset download failed.");
    }
  }

  async function uploadAsset(file: File) {
    setUploading(true);
    setMessage(null);

    try {
      const signResponse = await fetch("/api/uploads/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size
        })
      });
      const signed = (await signResponse.json().catch(() => null)) as
        | {
            asset?: { id: string };
            upload?: { url: string };
            error?: { message?: string };
          }
        | null;

      if (!signResponse.ok || !signed?.asset?.id || !signed.upload?.url) {
        throw new Error(signed?.error?.message ?? "Upload URL could not be created.");
      }

      const uploadResponse = await fetch(signed.upload.url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      });

      if (!uploadResponse.ok) {
        throw new Error("Cloud Storage rejected the upload.");
      }

      const completeResponse = await fetch(`/api/uploads/${encodeURIComponent(signed.asset.id)}/complete`, {
        method: "POST"
      });
      const completed = (await completeResponse.json().catch(() => null)) as { error?: { message?: string } } | null;

      if (!completeResponse.ok) {
        throw new Error(completed?.error?.message ?? "Upload completion check failed.");
      }

      setMessage("Asset uploaded.");
      announceStudioDataChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Asset upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">Recent Outputs</h2>
        <div className="panel-actions">
          <span className="badge gray">Private</span>
          <button
            className="icon-button compact"
            disabled={state === "auth" || uploading}
            onClick={() => fileInputRef.current?.click()}
            title="Upload asset"
            type="button"
            aria-label="Upload asset"
          >
            <Upload size={14} aria-hidden="true" />
          </button>
          <button className="icon-button compact" onClick={() => announceStudioDataChanged()} title="Refresh gallery" type="button" aria-label="Refresh gallery">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <input
            accept="image/png,image/jpeg,image/webp"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                uploadAsset(file);
              }
            }}
            ref={fileInputRef}
            type="file"
          />
        </div>
      </div>
      <div className="panel-body">
        <div className="gallery-grid">
          {state === "loading" ? <p className="item-meta">Loading private assets...</p> : null}
          {state === "auth" ? (
            <div className="gallery-empty">
              <ImageIcon size={20} aria-hidden="true" />
              <p className="item-title">Sign in required</p>
              <p className="item-meta">Private outputs and uploads are account-scoped.</p>
            </div>
          ) : null}
          {state === "error" ? (
            <div className="gallery-empty">
              <ImageIcon size={20} aria-hidden="true" />
              <p className="item-title">Gallery unavailable</p>
              <p className="item-meta">Check MongoDB and Cloud Storage configuration.</p>
            </div>
          ) : null}
          {state === "ready" && assets.length === 0 ? (
            <div className="gallery-empty">
              <ImageIcon size={20} aria-hidden="true" />
              <p className="item-title">No private assets yet</p>
              <p className="item-meta">Generated outputs and completed uploads will appear here.</p>
            </div>
          ) : null}
          {assets.map((asset) => (
            <div className="gallery-item" key={asset.id}>
              <button className="gallery-image preview-button" onClick={() => previewAsset(asset.id)} type="button">
                {previewUrls[asset.id] ? (
                  <img alt="" src={previewUrls[asset.id]} />
                ) : (
                  <ImageIcon size={22} aria-hidden="true" />
                )}
              </button>
              <div className="gallery-caption">
                <p>{assetTitle(asset)}</p>
                <span>{assetMeta(asset)}</span>
                <div className="chip-row">
                  <button className="button subtle compact-button" onClick={() => previewAsset(asset.id)} type="button">
                    Preview
                  </button>
                  <button className="button subtle compact-button" onClick={() => downloadAsset(asset.id)} type="button">
                    <Download size={13} aria-hidden="true" />
                    Download
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {uploading ? <p className="form-message">Uploading asset...</p> : null}
        {message ? <p className="form-message">{message}</p> : null}
      </div>
    </div>
  );
}
