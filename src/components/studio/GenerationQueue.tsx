"use client";

import { useEffect, useState } from "react";
import { Ban, RefreshCw } from "lucide-react";
import { announceStudioDataChanged, sessionChangedEvent, studioDataChangedEvent } from "@/components/studio/events";
import { apiErrorMessage, fetchWithTimeout } from "@/lib/http/client";

type GenerationJob = {
  id: string;
  status: string;
  progress: number;
  modelId?: string;
  estimatedCredits: number;
  createdAt: string;
  errorCode?: string;
  errorMessage?: string;
  executionEnvironment?: string;
};

export function GenerationQueue() {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "auth" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    let inFlight = false;

    async function loadJobs(background = false) {
      const requestId = ++sequence;
      inFlight = true;
      if (!background) setState("loading");
      try {
        const response = await fetchWithTimeout("/api/generations", { cache: "no-store" });

        if (response.status === 401) {
          if (!cancelled && requestId === sequence) {
            setJobs([]);
            setState("auth");
          }
          return;
        }

        const payload = (await response.json()) as { jobs?: GenerationJob[] };

        if (!cancelled && requestId === sequence) {
          setJobs(payload.jobs ?? []);
          setState(response.ok ? "ready" : "error");
          setMessage(response.ok ? null : apiErrorMessage(payload, "Generation history could not load."));
        }
      } catch {
        if (!cancelled && requestId === sequence) {
          setState("error");
          setJobs([]);
          setMessage("Generation history request failed. Check your connection and refresh.");
        }
      } finally { if (requestId === sequence) inFlight = false; }
    }

    function refresh() { void loadJobs(); }
    refresh();
    const poll = window.setInterval(() => { if (!inFlight) void loadJobs(true); }, 5000);
    window.addEventListener(sessionChangedEvent, refresh);
    window.addEventListener(studioDataChangedEvent, refresh);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.removeEventListener(sessionChangedEvent, refresh);
      window.removeEventListener(studioDataChangedEvent, refresh);
    };
  }, []);

  async function cancelJob(jobId: string) {
    setMessage(null);
    try {
      const response = await fetchWithTimeout(`/api/generations/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST"
      });
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;

      if (!response.ok) {
        setMessage(payload?.error?.message ?? "Generation could not be cancelled.");
        return;
      }

      setMessage("Generation cancelled.");
      announceStudioDataChanged();
    } catch { setMessage("Cancellation could not be confirmed. Refresh the queue and retry."); }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">Generation Queue</h2>
        <div className="panel-actions">
          <span className="badge">{jobs.filter((job) => !["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)).length} active</span>
          <button className="icon-button compact" onClick={() => announceStudioDataChanged()} title="Refresh queue" type="button" aria-label="Refresh queue">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="queue-list">
          {state === "loading" ? <p className="item-meta">Loading generation history...</p> : null}
          {state === "auth" ? (
            <div className="queue-item">
              <p className="item-title">Sign in required</p>
              <p className="item-meta">Generation history is private to the authenticated account.</p>
            </div>
          ) : null}
          {state === "error" ? (
            <div className="queue-item">
              <p className="item-title">Generation service unavailable</p>
              <p className="item-meta">Check database connectivity and session configuration.</p>
            </div>
          ) : null}
          {state === "ready" && jobs.length === 0 ? (
            <div className="queue-item">
              <p className="item-title">No generation jobs yet</p>
              <p className="item-meta">Validated workflows will appear here after Cloud Tasks accepts them.</p>
            </div>
          ) : null}
          {jobs.map((job) => (
            <div className="queue-item" key={job.id}>
              <div className="item-top">
                <div>
                  <p className="item-title">{job.modelId ?? "Model pending"}</p>
                  <p className="item-meta">{job.id} - {job.status} - {job.estimatedCredits} credits</p>
                  {job.errorMessage ? <p className="form-message" role="alert">{job.errorCode}: {job.errorMessage}</p> : null}
                  {job.executionEnvironment === "development-local" ? <p className="item-meta">Development placeholder lifecycle only; no real image generated.</p> : job.status === "COMPLETED" ? <p className="item-meta">Generation completed. Open the private gallery to inspect its output.</p> : null}
                </div>
                <span className="badge gray">{job.progress}%</span>
              </div>
              <div className="progress" aria-label={`${job.modelId ?? job.id} ${job.progress}%`}>
                <span style={{ width: `${job.progress}%` }} />
              </div>
              {["QUEUED", "VALIDATING", "STARTING", "LOADING_MODEL", "GENERATING", "POST_PROCESSING", "UPLOADING"].includes(job.status) ? (
                <div className="chip-row">
                  <button className="button subtle compact-button" onClick={() => cancelJob(job.id)} type="button">
                    <Ban size={13} aria-hidden="true" />
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {message ? <p className="form-message">{message}</p> : null}
      </div>
    </div>
  );
}
