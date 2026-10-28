"use client";

import {
  Ban,
  Boxes,
  BrainCircuit,
  Captions,
  CreditCard,
  FileImage,
  GalleryHorizontalEnd,
  Image as ImageIcon,
  LayoutDashboard,
  Library,
  MessageSquareText,
  Paintbrush,
  Ruler,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { GoogleSignInButton, type SessionState } from "@/components/auth/GoogleSignInButton";
import { AdminModelPanel } from "@/components/studio/AdminModelPanel";
import { GalleryRail } from "@/components/studio/GalleryRail";
import { GenerationQueue } from "@/components/studio/GenerationQueue";
import { ExecutionEnvironmentSelector } from "@/components/studio/ExecutionEnvironmentSelector";
import { ModelSelector } from "@/components/studio/ModelSelector";
import { WorkflowCanvas } from "@/components/studio/WorkflowCanvas";
import { workflowNodeCatalogue, type WorkflowIconKey } from "@/lib/workflow/registry";
import { baseTextToImageWorkflow, workflowTemplates } from "@/lib/workflow/templates";
import { ollamaImageModelId } from "@/lib/models/ollama-image";
import { huggingFaceImageModels } from "@/lib/models/huggingface-image";
import {
  isModelCompatibleWithExecutionEnvironment,
  workflowNodeRequiresModel,
  getWorkflowEnvironmentCompatibility
} from "@/lib/workflow/execution-environments";
import type {
  ApprovedNodeType,
  ProviderRoute,
  WorkflowDocument,
  WorkflowExecutionEnvironment,
  WorkflowNode
} from "@/lib/workflow/schema";

const navItems = [
  { label: "Studio", icon: LayoutDashboard, sectionId: "studio-workspace" },
  { label: "Workflows", icon: Workflow, sectionId: "workflow-templates" },
  { label: "Models", icon: Boxes, sectionId: "model-governance" },
  { label: "Gallery", icon: GalleryHorizontalEnd, sectionId: "production-activity" },
  { label: "Billing", icon: CreditCard },
  { label: "Security", icon: ShieldCheck },
  { label: "Settings", icon: Settings }
];

const catalogueIconMap: Record<WorkflowIconKey, LucideIcon> = {
  ban: Ban,
  brain: BrainCircuit,
  captions: Captions,
  "file-image": FileImage,
  image: ImageIcon,
  message: MessageSquareText,
  paintbrush: Paintbrush,
  ruler: Ruler,
  shield: ShieldCheck,
  sliders: SlidersHorizontal
};

const toolRows: readonly {
  label: string;
  meta: string;
  icon: LucideIcon;
  type: ApprovedNodeType;
}[] = workflowNodeCatalogue.filter((definition) => ["prompt-input", "dimensions", "text-to-image", "safety-check", "output"].includes(definition.type)).map((definition) => ({
  label: definition.catalogueLabel,
  meta: definition.catalogueDescription,
  icon: catalogueIconMap[definition.iconKey],
  type: definition.type
}));

type ModelDTO = {
  id: string;
  name: string;
  route: ProviderRoute;
  provider: string;
  family: string;
  licenceStatus: string;
  capabilities?: unknown;
  maxPixels: number;
  maxSteps: number;
  baseCreditCost: number;
  availability?: "available" | "requires-credentials" | "development-only" | "not-configured" | "unavailable";
  isEnabled: boolean;
  generationUnavailableReason?: string;
};

function cloneWorkflow(workflow: WorkflowDocument): WorkflowDocument {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDocument;
}

function updateWorkflowNodeModel(node: WorkflowNode, model: Pick<ModelDTO, "id" | "route">): WorkflowNode {
  const routePatch = model.route ? { route: model.route } : {};

  switch (node.type) {
    case "llm-prompt":
      return { ...node, data: { ...node.data, modelId: model.id, ...routePatch } };
    case "text-to-image":
      return { ...node, data: { ...node.data, modelId: model.id, ...routePatch } };
    case "image-to-image":
      return { ...node, data: { ...node.data, modelId: model.id, ...routePatch } };
    case "image-analysis":
      return { ...node, data: { ...node.data, modelId: model.id, ...routePatch } };
    case "image-transform":
      return node.data.modelId ? { ...node, data: { ...node.data, modelId: model.id, ...routePatch } } : node;
    default:
      return node;
  }
}

function selectWorkflowModel(workflow: WorkflowDocument, model: Pick<ModelDTO, "id" | "route">): WorkflowDocument {
  return {
    ...workflow,
    selectedModel: model.id,
    nodes: workflow.nodes.map((node) => updateWorkflowNodeModel(node, model))
  };
}

export function StudioWorkspace() {
  const [activeNav, setActiveNav] = useState("Studio");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("Development site connected to authenticated API routes.");
  const [workflow, setWorkflow] = useState<WorkflowDocument>(() => cloneWorkflow(baseTextToImageWorkflow));
  const [workflowName, setWorkflowName] = useState("Cinematic Product Campaign");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelDTO[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [catalogueIssue, setCatalogueIssue] = useState<string | null>("Loading model catalogue.");
  const [catalogueSelection, setCatalogueSelection] = useState<{ type: ApprovedNodeType; nonce: number } | null>(null);
  const allowDevelopmentLocal = process.env.NODE_ENV !== "production";
  const filteredToolRows = useMemo(
    () =>
      toolRows.filter((tool) =>
        `${tool.label} ${tool.meta}`.toLowerCase().includes(search.trim().toLowerCase())
      ),
    [search]
  );
  const filteredTemplates = useMemo(
    () =>
      workflowTemplates.filter((template) => (process.env.NODE_ENV !== "production" || template.workflow.executionEnvironment !== "development-local")).filter((template) =>
        `${template.name} ${template.category} ${template.modelId}`.toLowerCase().includes(search.trim().toLowerCase())
      ),
    [search]
  );
  const selectedModel = models.find((model) => model.id === workflow.selectedModel);
  const compatibleModels = useMemo(
    () => models.filter((model) => isModelCompatibleWithExecutionEnvironment(model, workflow.executionEnvironment)),
    [models, workflow.executionEnvironment]
  );
  const compatibility = getWorkflowEnvironmentCompatibility(workflow, models);
  const usedModels = models.filter((model) => workflow.nodes.some((node) => workflowNodeRequiresModel(node) && node.data.modelId === model.id));
  const generationBlockReason = catalogueIssue ?? (models.length === 0 ? "Load an enabled model catalogue before generation." : sessionState !== "authenticated" ? sessionState === "checking" ? "Checking your session..." : "Sign in and confirm your session before generation." : !compatibility.ok ? compatibility.issues[0] : usedModels.find((model) => model.generationUnavailableReason)?.generationUnavailableReason ?? (usedModels.some((model) => !model.isEnabled) ? "Selected model is disabled pending verified deployment setup." : null));

  const handleModelsLoaded = useCallback((loadedModels: ModelDTO[]) => {
    setModels(loadedModels);
  }, []);

  function changeExecutionEnvironment(executionEnvironment: WorkflowExecutionEnvironment) {
    if (executionEnvironment === "huggingface-l4") {
      const id = models.find((model) => model.route === "huggingface-image" && model.isEnabled)?.id ?? huggingFaceImageModels[0].id;
      setWorkflow((current) => selectWorkflowModel({ ...current, executionEnvironment }, { id, route: "huggingface-image" }));
      setNotice("Hugging Face L4 selected. Choose a model, then validate the workflow.");
      return;
    }
    if (executionEnvironment !== "gcp-hosted") return;
    setWorkflow((current) => selectWorkflowModel({ ...current, executionEnvironment }, { id: ollamaImageModelId, route: "gcp-hosted-gpu" }));
    setNotice("GCP hosted worker selected: L4 / Ollama / FLUX.2 Klein 4B FP8. Review model defaults before validation.");
  }

  function activateNav(item: (typeof navItems)[number]) {
    setActiveNav(item.label);

    if (!item.sectionId) {
      setNotice(`${item.label} controls are not implemented in this development slice yet.`);
      return;
    }

    document.getElementById(item.sectionId)?.scrollIntoView({ block: "start", behavior: "smooth" });
    setNotice(`${item.label} section selected.`);
  }

  function applyTemplate(templateId: string) {
    const template = workflowTemplates.find((candidate) => candidate.id === templateId);

    if (!template) {
      setNotice("Template could not be found.");
      return;
    }

    setWorkflow(cloneWorkflow(template.workflow));
    setWorkflowName(template.name);
    setWorkflowId(null);
    setNotice(`${template.name} template loaded as an unsaved workflow.`);
  }

  function selectCatalogueNode(type: ApprovedNodeType) {
    setCatalogueSelection((current) => ({ type, nonce: (current?.nonce ?? 0) + 1 }));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={20} aria-hidden="true" />
          </div>
          <div>
            <p className="brand-title">AstraFlow</p>
            <p className="brand-subtitle">Image Studio</p>
          </div>
        </div>

        <nav className="nav-section">
          <div className="nav-label">Workspace</div>
          {navItems.map((item) => (
            <button
              className={activeNav === item.label ? "nav-item active" : "nav-item"}
              key={item.label}
              onClick={() => activateNav(item)}
              type="button"
            >
              <item.icon size={17} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="quota-box">
            <div className="quota-top">
              <span>Credits</span>
              <span>Dev</span>
            </div>
            <div className="quota-value">Pending</div>
            <div className="meter" aria-hidden="true">
              <span style={{ width: "0%" }} />
            </div>
            <p className="item-meta">Credit ledger wiring is pending.</p>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1 className="page-title">{workflowName}</h1>
              <p className="page-kicker">
              {workflowId ? `Saved workflow ${workflowId}` : "Unsaved workflow"} - {workflow.executionEnvironment} - {selectedModel?.name ?? workflow.selectedModel}
            </p>
          </div>
          <div className="topbar-actions">
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="Search"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search nodes, templates, models"
                value={search}
              />
            </label>
            <button
              className="icon-button"
              onClick={() => {
                document.getElementById("workflow-templates")?.scrollIntoView({ block: "start", behavior: "smooth" });
                setNotice("Template library selected.");
              }}
              title="Template library"
              type="button"
              aria-label="Template library"
            >
              <Library size={17} aria-hidden="true" />
            </button>
            <div className="sign-in-slot">
              <GoogleSignInButton onSessionStateChange={setSessionState} />
            </div>
          </div>
        </header>

        <div className="workspace-notice" role="status">{notice}</div>

        <section className="workspace" id="studio-workspace" aria-label="Studio workspace">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Node Catalogue</h2>
              <span className="badge gray">{filteredToolRows.length}</span>
            </div>
            <div className="panel-body">
              <div className="tool-list">
                {filteredToolRows.map((tool) => (
                  <button className="tool-row selectable" key={tool.label} onClick={() => selectCatalogueNode(tool.type)} type="button">
                    <div className="tool-icon">
                      <tool.icon size={16} aria-hidden="true" />
                    </div>
                    <div>
                      <p className="tool-name">{tool.label}</p>
                      <p className="tool-meta">{tool.meta}</p>
                    </div>
                  </button>
                ))}
                {filteredToolRows.length === 0 ? <p className="item-meta">No nodes match the current search.</p> : null}
              </div>
            </div>
          </div>

          <WorkflowCanvas
            catalogueSelection={catalogueSelection}
            models={models}
            generationBlockReason={generationBlockReason}
            onNotice={setNotice}
            onWorkflowChange={setWorkflow}
            onWorkflowLoaded={({ workflow: loadedWorkflow, name, workflowId: loadedWorkflowId }) => {
              setWorkflow(loadedWorkflow);
              setWorkflowName(name);
              setWorkflowId(loadedWorkflowId);
            }}
            onWorkflowNameChange={setWorkflowName}
            workflow={workflow}
            workflowId={workflowId}
            workflowName={workflowName}
          />

          <div className="right-rail">
            <ExecutionEnvironmentSelector
              allowDevelopmentLocal={allowDevelopmentLocal}
              models={models}
              onChange={changeExecutionEnvironment}
              value={workflow.executionEnvironment}
            />
            <ModelSelector
              executionEnvironment={workflow.executionEnvironment}
              onModelsLoaded={handleModelsLoaded}
              onCatalogueStateChange={setCatalogueIssue}
              onSelectModel={(model) => {
                setWorkflow((current) => selectWorkflowModel(current, model));
                setNotice(`${model.name} selected for the workflow.`);
              }}
              models={compatibleModels}
              selectedModelId={workflow.selectedModel}
            />
          </div>
        </section>

        <section className="bottom-grid" id="production-activity" aria-label="Production activity">
          <GenerationQueue />
          <GalleryRail />
        </section>

        <section className="bottom-grid" aria-label="Administration">
          <div className="panel" id="workflow-templates">
            <div className="panel-header">
              <h2 className="panel-title">Workflow Templates</h2>
              <span className="badge">{filteredTemplates.length} curated</span>
            </div>
            <div className="panel-body">
              <div className="admin-list">
                {filteredTemplates.map((template) => (
                  <button className="admin-item selectable" key={template.id} onClick={() => applyTemplate(template.id)} type="button">
                    <div className="item-top">
                      <div>
                        <p className="item-title">{template.name}</p>
                        <p className="item-meta">{template.category} - {template.creditEstimate} credits</p>
                      </div>
                      <span className="badge gray">{template.modelId}</span>
                    </div>
                  </button>
                ))}
                {filteredTemplates.length === 0 ? <p className="item-meta">No workflow templates match the current search.</p> : null}
              </div>
            </div>
          </div>
          <div id="model-governance">
            <AdminModelPanel />
          </div>
        </section>
      </main>
    </div>
  );
}
