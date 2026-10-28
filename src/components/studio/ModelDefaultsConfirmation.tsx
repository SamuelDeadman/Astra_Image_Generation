"use client";
import { useEffect, useRef } from "react";
import type { DefaultsPreview } from "@/lib/models/constraints";

export function ModelDefaultsConfirmation({ preview, modelName, onCancel, onConfirm }: { preview: DefaultsPreview; modelName: string; onCancel(): void; onConfirm(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="model-confirmation-overlay">
    <div className="model-confirmation" role="dialog" aria-modal="true" aria-labelledby="model-defaults-title" onKeyDown={(event) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Tab" && event.shiftKey && document.activeElement === cancelRef.current) { event.preventDefault(); confirmRef.current?.focus(); }
      if (event.key === "Tab" && !event.shiftKey && document.activeElement === confirmRef.current) { event.preventDefault(); cancelRef.current?.focus(); }
    }}>
      <h3 id="model-defaults-title">Apply {modelName} defaults?</h3>
      <p>Review these changes to existing inputs before applying them.</p>
      <ul>{preview.changes.map((change) => <li key={`${change.nodeId}.${change.field}`}><strong>{change.nodeId}.{change.field}</strong>: {String(change.before ?? "unset")} → {String(change.after ?? "remove unsupported value")}</li>)}</ul>
      {preview.skipped.map((reason) => <p key={reason}>{reason}</p>)}
      <p>Prompts, asset IDs and connections are retained. Unsupported connections or negative prompts must be removed explicitly.</p>
      <div className="panel-actions"><button className="button subtle" ref={cancelRef} onClick={onCancel} type="button">Cancel</button><button className="button primary" ref={confirmRef} onClick={onConfirm} type="button">Confirm changes</button></div>
    </div>
  </div>;
}
