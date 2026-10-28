"use client";

import { Cloud, KeyRound, Laptop, ServerCog } from "lucide-react";
import {
  executionEnvironmentDefinitions,
  getExecutionEnvironmentSetupReasons,
  type ExecutionEnvironmentModelContext
} from "@/lib/workflow/execution-environments";
import type { WorkflowExecutionEnvironment } from "@/lib/workflow/schema";

type ExecutionEnvironmentSelectorProps = {
  value: WorkflowExecutionEnvironment;
  models: ExecutionEnvironmentModelContext[];
  allowDevelopmentLocal: boolean;
  onChange(environment: WorkflowExecutionEnvironment): void;
};

function iconForEnvironment(environment: WorkflowExecutionEnvironment) {
  if (environment === "google-ai-studio") {
    return Cloud;
  }

  if (environment === "external-byok") {
    return KeyRound;
  }

  if (environment === "development-local") {
    return Laptop;
  }

  return ServerCog;
}

export function ExecutionEnvironmentSelector({
  value,
  models,
  allowDevelopmentLocal,
  onChange
}: ExecutionEnvironmentSelectorProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">Execution</h2>
        <span className="badge gray">{value}</span>
      </div>
      <div className="panel-body">
        <div className="model-list">
          {executionEnvironmentDefinitions.filter((environment) => (environment.id === "gcp-hosted" || environment.id === "huggingface-l4")).map((environment) => {
            const Icon = iconForEnvironment(environment.id);
            const reasons = getExecutionEnvironmentSetupReasons({
              environment: environment.id,
              models,
              allowDevelopmentLocal
            });
            const unavailable = reasons.length > 0;

            return (
              <button
                className={value === environment.id ? "model-item selectable selected" : "model-item selectable"}
                key={environment.id}
                onClick={() => onChange(environment.id)}
                type="button"
              >
                <div className="item-top">
                  <div>
                    <p className="item-title">
                      <Icon size={14} aria-hidden="true" /> {environment.label}
                    </p>
                    <p className="item-meta">{environment.description}</p>
                  </div>
                  <span className={unavailable ? "badge warn" : "badge"}>
                    {unavailable ? "Setup" : value === environment.id ? "Selected" : "Ready"}
                  </span>
                </div>
                {reasons[0] ? <p className="item-meta">{reasons[0]}</p> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
