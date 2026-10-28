import "server-only";

import crypto from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { createGeneratedOutputStorageTarget } from "@/server/assets/assets";
import {
  type ExecutionPlanDocument,
  type ExecutionPlanStep,
  type GenerationJobDocument,
  type WorkflowRevisionDocument
} from "@/server/db/types";
import { optionalEnv } from "@/server/env";
import { getModelById } from "@/lib/models/catalog";
import { nodeModelConstraintIssues } from "@/lib/models/constraints";
import { ollamaImageModelId, ollamaImageModelReference } from "@/lib/models/ollama-image";
import { generateOllamaImage } from "./ollama-image-client";
import { huggingFaceImageModel } from "@/lib/models/huggingface-image";
import { generateHuggingFaceImage } from "./huggingface-image-client";
import { assertHuggingFaceConfigured, getHuggingFaceConfiguration, HuggingFaceImageError } from "./huggingface-image-config";
import { assertOllamaImageConfigured, getOllamaImageConfiguration, OllamaImageError } from "./ollama-image-config";
import { loadUserProviderSecret } from "@/server/providers/credentials";
import { inspectImageBytes, decodeProviderImage } from "@/server/generations/image-bytes";

import {
  generatedOutputArtifactSchema,
  type GeneratedOutputArtifact,
  type WorkerProgressUpdate
} from "@/server/generations/worker-contract";

export type StepTextValue = {
  type: "text";
  text: string;
};

export type StepJsonValue = {
  type: "json";
  value: unknown;
};

export type StepImageValue = {
  type: "image";
  assetId?: string;
  artifact?: GeneratedOutputArtifact;
  storage: {
    bucket: string;
    objectPath: string;
  };
  contentType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  sha256?: string;
};

export type StepDimensionsValue = {
  type: "dimensions";
  width: number;
  height: number;
  batch: number;
};

export type StepSeedValue = {
  type: "seed";
  seed: number;
  locked: boolean;
};

export type StepInputValue = StepTextValue | StepJsonValue | StepImageValue | StepDimensionsValue | StepSeedValue;
export type StepOutputValue = StepTextValue | StepJsonValue | StepImageValue;

export type StepExecutionContext = {
  job: GenerationJobDocument;
  workflowRevision: WorkflowRevisionDocument;
  executionPlan: ExecutionPlanDocument;
  step: ExecutionPlanStep;
  inputs: Record<string, StepInputValue>;
  attemptId: string;
};

export type StepExecutionAdapterResult = {
  outputs: Record<string, StepOutputValue>;
  actualCredits: number;
  usage?: Record<string, unknown>;
};

export type StepExecutionAdapter = {
  id: string;
  execute(
    context: StepExecutionContext,
    hooks: {
      progress(update: WorkerProgressUpdate): Promise<void>;
      isCancelled(): Promise<boolean>;
    }
  ): Promise<StepExecutionAdapterResult>;
};

export type StepExecutionAdapterRegistration = {
  id: string;
  adapter: StepExecutionAdapter;
  supportedNodeTypes: readonly string[];
  supportedRoutes: readonly string[];
  credentialMode: "platform-identity" | "server-api-key" | "user-byok" | "none";
  requiredConfiguration: readonly string[];
  checkConfiguration?: () => void;
};

export class GenerationInferenceFailure extends Error {
  readonly code: string;
  readonly safeMessage: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = "GenerationInferenceFailure";
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryable = retryable;
  }
}

const textOutputSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(20000)
});

type JsonCompatibleValue =
  | string
  | number
  | boolean
  | null
  | JsonCompatibleValue[]
  | { [key: string]: JsonCompatibleValue };

const jsonValueSchema: z.ZodType<JsonCompatibleValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)])
);

const jsonOutputSchema = z.object({
  type: z.literal("json"),
  value: jsonValueSchema
});

const imageOutputSchema = z.object({
  type: z.literal("image"),
  assetId: z.string().min(1).max(140).optional(),
  artifact: generatedOutputArtifactSchema.optional(),
  storage: z
    .object({
      bucket: z.string().min(1).max(222),
      objectPath: z.string().min(1).max(1024)
    })
    .strict(),
  contentType: z.string().min(1).max(120),
  width: z.number().int().min(1).max(8192).optional(),
  height: z.number().int().min(1).max(8192).optional(),
  sizeBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

const stepOutputValueSchema = z.discriminatedUnion("type", [textOutputSchema, jsonOutputSchema, imageOutputSchema]);

const googleAuth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"]
});

function safeJson(value: unknown) {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "bigint") {
      return entry.toString();
    }

    return entry;
  });
}

function contentTypeForFormat(format: unknown): GeneratedOutputArtifact["contentType"] {
  if (format === "jpeg") {
    return "image/jpeg";
  }

  if (format === "webp") {
    return "image/webp";
  }

  return "image/png";
}

function imageDimensionsForStep(context: StepExecutionContext) {
  const width = typeof context.step.parameters.width === "number" ? context.step.parameters.width : undefined;
  const height = typeof context.step.parameters.height === "number" ? context.step.parameters.height : undefined;
  const image = Object.values(context.inputs).find((input): input is StepImageValue => input.type === "image");

  return {
    width: width ?? image?.width ?? image?.artifact?.width ?? 768,
    height: height ?? image?.height ?? image?.artifact?.height ?? 768
  };
}

function summarizeInputs(inputs: Record<string, StepInputValue>) {
  return Object.fromEntries(
    Object.entries(inputs).map(([handle, input]) => {
      if (input.type === "text") {
        return [handle, { type: "text", sha256: crypto.createHash("sha256").update(input.text).digest("hex") }];
      }

      if (input.type === "image") {
        return [
          handle,
          {
            type: "image",
            assetId: input.assetId,
            contentType: input.contentType,
            width: input.width ?? input.artifact?.width,
            height: input.height ?? input.artifact?.height
          }
        ];
      }

      return [handle, input];
    })
  );
}

function createPlaceholderImageArtifact(context: StepExecutionContext) {
  const { width, height } = imageDimensionsForStep(context);
  const contentType = contentTypeForFormat(context.step.parameters.outputFormat);
  const storage = createGeneratedOutputStorageTarget({
    ownerId: context.job.ownerId,
    jobId: context.job._id,
    attemptId: context.attemptId,
    stepId: context.step.id,
    contentType,
    developmentOnly: true
  });
  const manifest = safeJson({
    developmentOnly: true,
    adapter: "development-fake",
    jobId: context.job._id,
    attemptId: context.attemptId,
    workflowRevisionId: context.workflowRevision._id,
    executionPlanHash: context.executionPlan.planHash,
    stepId: context.step.id,
    nodeType: context.step.nodeType,
    modelId: context.step.modelId,
    width,
    height,
    contentType,
    inputs: summarizeInputs(context.inputs)
  });

  return {
    contentType,
    width,
    height,
    sizeBytes: Buffer.byteLength(manifest),
    sha256: crypto.createHash("sha256").update(manifest).digest("hex"),
    storage,
    developmentOnly: true
  } satisfies GeneratedOutputArtifact;
}

function textFromInputs(inputs: Record<string, StepInputValue>) {
  return Object.values(inputs)
    .filter((input): input is StepTextValue => input.type === "text")
    .map((input) => input.text)
    .join("\n\n")
    .trim();
}

async function assertNotCancelled(hooks: { isCancelled(): Promise<boolean> }) {
  if (await hooks.isCancelled()) {
    throw new GenerationInferenceFailure("GENERATION_CANCELLED", "Generation was cancelled.", false);
  }
}

const developmentFakeStepAdapter: StepExecutionAdapter = {
  id: "development-fake",
  async execute(context, hooks) {
    assertDevelopmentFakeAvailable();
    await hooks.progress({
      type: "progress",
      status: context.step.nodeType === "output" ? "UPLOADING" : "GENERATING",
      progress: 50,
      message: "Development fake adapter is producing deterministic placeholder step output."
    });
    await assertNotCancelled(hooks);

    if (context.step.nodeType === "llm-prompt") {
      const instruction = String(context.step.parameters.instruction ?? "");
      const inputText = textFromInputs(context.inputs);
      const outputMode = context.step.parameters.outputMode;
      const text = `Development LLM output for ${context.step.nodeId}: ${instruction}${inputText ? ` | ${inputText}` : ""}`;
      const outputs: Record<string, StepOutputValue> = {
        text: { type: "text", text }
      };

      if (outputMode === "json") {
        outputs.json = {
          type: "json",
          value: {
            developmentOnly: true,
            nodeId: context.step.nodeId,
            text
          }
        };
      }

      return {
        outputs,
        actualCredits: context.step.estimates.credits,
        usage: { developmentOnly: true, promptSha256: crypto.createHash("sha256").update(inputText).digest("hex") }
      };
    }

    if (context.step.nodeType === "image-analysis") {
      const image = Object.values(context.inputs).find((input): input is StepImageValue => input.type === "image");
      const text = `Development ${String(context.step.parameters.outputMode ?? "caption")} for ${image?.assetId ?? image?.storage.objectPath ?? "image"}.`;

      return {
        outputs: {
          text: { type: "text", text },
          json: {
            type: "json",
            value: {
              developmentOnly: true,
              nodeId: context.step.nodeId,
              summary: text
            }
          }
        },
        actualCredits: context.step.estimates.credits,
        usage: { developmentOnly: true }
      };
    }

    if (
      context.step.nodeType === "text-to-image" ||
      context.step.nodeType === "image-to-image" ||
      context.step.nodeType === "image-transform"
    ) {
      const artifact = createPlaceholderImageArtifact(context);

      return {
        outputs: {
          image: {
            type: "image",
            artifact,
            storage: artifact.storage,
            contentType: artifact.contentType,
            width: artifact.width,
            height: artifact.height,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256
          },
          metadata: {
            type: "json",
            value: {
              developmentOnly: true,
              stepId: context.step.id,
              modelId: context.step.modelId,
              route: context.step.route
            }
          }
        },
        actualCredits: context.step.estimates.credits,
        usage: { developmentOnly: true }
      };
    }

    if (context.step.nodeType === "safety-check") {
      const image = context.inputs.image;

      return {
        outputs: {
          ...(image?.type === "image" ? { approvedImage: image } : {}),
          safety: {
            type: "json",
            value: {
              approved: true,
              policy: context.step.parameters.contentPolicy,
              developmentOnly: true
            }
          }
        },
        actualCredits: 0,
        usage: { developmentOnly: true }
      };
    }

    if (context.step.nodeType === "output") {
      return {
        outputs: Object.fromEntries(
          Object.entries(context.inputs).filter(([, value]) => value.type === "image" || value.type === "text" || value.type === "json")
        ) as Record<string, StepOutputValue>,
        actualCredits: 0,
        usage: { developmentOnly: true }
      };
    }

    return {
      outputs: {},
      actualCredits: 0
    };
  }
};

async function bearerHeaders() {
  const token = await googleAuth.getAccessToken();

  if (!token) {
    throw new GenerationInferenceFailure("GOOGLE_AUTH_UNAVAILABLE", "Google application credentials are not configured.", true);
  }

  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

function vertexLocation() {
  return optionalEnv("VERTEX_AI_LOCATION") ?? "global";
}

function vertexProject() {
  return optionalEnv("GCP_PROJECT_ID");
}

function googleAiStudioModel(context: StepExecutionContext) {
  return reviewedImageModel(context).providerModelId;
}
function googleAiStudioEndpoint() { return "https://generativelanguage.googleapis.com/v1beta/interactions"; }
function reviewedImageModel(context: StepExecutionContext) {
  const model = getModelById(context.step.modelId ?? "");
  if (!model || model.developmentOnly || model.route !== context.step.adapterId || model.providerId !== context.step.providerId || model.providerModelId !== context.step.pinnedModelVersion || !model.capabilities.includes(context.step.nodeType)) throw new GenerationInferenceFailure("MODEL_UNAVAILABLE", "This model/version/operation is not in the reviewed provider allowlist.", false);
  const node = context.workflowRevision.workflow.nodes.find((entry) => entry.id === context.step.nodeId);
  if (!node) throw new GenerationInferenceFailure("WORKFLOW_STEP_INVALID", "The model node is missing from the authoritative workflow.", false);
  const issues = nodeModelConstraintIssues(context.workflowRevision.workflow, node, model);
  if (issues.length) throw new GenerationInferenceFailure("MODEL_CONSTRAINT_FAILED", issues[0].message.slice(0,300), false);
  return model;
}
function effectiveParameters(context: StepExecutionContext) {
  const dimensions = context.inputs.dimensions;
  return { ...context.step.parameters, ...(dimensions?.type === "dimensions" ? { width: dimensions.width, height: dimensions.height, batch: dimensions.batch } : {}) };
}
function imageResolution(context: StepExecutionContext) {
  const model = reviewedImageModel(context);
  const values = effectiveParameters(context);
  const size = model.resolutions.find((entry) => entry.width === values.width && entry.height === values.height);
  if (!size || values.batch !== 1) throw new GenerationInferenceFailure("MODEL_CONSTRAINT_FAILED", "Requested resolution/batch is unsupported by this model adapter.", false);
  return size;
}

function googleAiStudioTimeoutSeconds() {
  const configured = optionalEnv("GOOGLE_AI_STUDIO_TIMEOUT_SECONDS");

  if (!configured) {
    return 300;
  }

  const parsed = Number(configured);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1800) {
    throw new GenerationInferenceFailure("AI_STUDIO_TIMEOUT_INVALID", "Google AI Studio timeout configuration is invalid.", false);
  }

  return parsed;
}

async function postJsonWithTimeout(input: {
  url: string;
  headers: HeadersInit;
  body: unknown;
  timeoutSeconds: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);

  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new GenerationInferenceFailure(
        response.status === 401 || response.status === 403 ? "VERTEX_ACCESS_DENIED" : response.status === 429 ? "VERTEX_QUOTA_EXCEEDED" : "VERTEX_REQUEST_FAILED",
        response.status === 401 || response.status === 403 ? "Vertex rejected the application service identity. An operator must check worker IAM, API enablement and project billing; users do not supply cloud keys." : response.status === 429 ? "Vertex quota is exhausted. Retry later or ask an operator to check project quotas." : "The reviewed Vertex model request failed. Check model availability and application cloud setup.",
        response.status >= 500 || response.status === 429
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof GenerationInferenceFailure) {
      throw error;
    }

    throw new GenerationInferenceFailure("REMOTE_ADAPTER_UNAVAILABLE", "The configured model adapter is unavailable.", true);
  } finally {
    clearTimeout(timer);
  }
}

async function postGoogleAiStudioJson(input: { url: string; apiKey: string; body: unknown; timeoutSeconds: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);

  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "x-goog-api-key": input.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input.body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new GenerationInferenceFailure(
        response.status === 401 || response.status === 403 ? "AI_STUDIO_KEY_REJECTED" : response.status === 429 ? "AI_STUDIO_QUOTA_EXCEEDED" : "AI_STUDIO_REQUEST_FAILED",
        response.status === 401 || response.status === 403 ? "Google rejected your saved AI Studio key or its project access. Check the key's API access and billing, then replace it in BYOK Providers." : response.status === 429 ? "Your AI Studio quota is exhausted. Retry later or check the key project's quota." : "Google AI Studio image generation failed. Check model access and retry.",
        response.status >= 500 || response.status === 429
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof GenerationInferenceFailure) {
      throw error;
    }

    throw new GenerationInferenceFailure("AI_STUDIO_UNAVAILABLE", "Google AI Studio image generation is unavailable.", true);
  } finally {
    clearTimeout(timer);
  }
}

function vertexContents(context: StepExecutionContext) {
  const textParts = [
    context.step.parameters.instruction,
    context.step.parameters.prompt,
    textFromInputs(context.inputs)
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((text) => ({ text }));
  const imageParts = Object.values(context.inputs)
    .filter((input): input is StepImageValue => input.type === "image")
    .map((image) => ({
      fileData: {
        mimeType: image.contentType,
        fileUri: `gs://${image.storage.bucket}/${image.storage.objectPath}`
      }
    }));

  return [
    {
      role: "user",
      parts: [...textParts, ...imageParts]
    }
  ];
}

const vertexLlmAdapter: StepExecutionAdapter = {
  id: "vertex-llm",
  async execute(context, hooks) {
    const project = vertexProject();

    if (!project) {
      throw new GenerationInferenceFailure("VERTEX_AI_NOT_CONFIGURED", "Vertex AI project configuration is missing.", false);
    }

    await hooks.progress({
      type: "progress",
      status: "GENERATING",
      progress: 40,
      message: "Vertex AI LLM request is running."
    });
    await assertNotCancelled(hooks);

    const location = vertexLocation();
    const model = context.step.pinnedModelVersion ?? context.step.modelId;
    const payload = await postJsonWithTimeout({
      url: `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`,
      headers: await bearerHeaders(),
      timeoutSeconds: context.step.timeoutSeconds,
      body: {
        contents: vertexContents(context),
        systemInstruction:
          typeof context.step.parameters.systemPrompt === "string"
            ? { parts: [{ text: context.step.parameters.systemPrompt }] }
            : undefined,
        generationConfig: {
          temperature: context.step.parameters.temperature,
          maxOutputTokens: context.step.parameters.maxOutputTokens
        }
      }
    });
    const text = String(payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("") ?? "");

    if (!text) {
      throw new GenerationInferenceFailure("VERTEX_LLM_EMPTY_OUTPUT", "Vertex AI returned an empty model response.", true);
    }

    if (context.step.nodeType === "llm-prompt" && context.step.parameters.outputMode === "json") {
      try {
        return {
          outputs: {
            text: { type: "text", text },
            json: { type: "json", value: JSON.parse(text) as unknown }
          },
          actualCredits: context.step.estimates.credits,
          usage: { provider: "vertex-ai", model }
        };
      } catch {
        throw new GenerationInferenceFailure("VERTEX_LLM_OUTPUT_INVALID", "Vertex AI returned invalid structured JSON.", false);
      }
    }

    return {
      outputs: {
        text: { type: "text", text },
        json: {
          type: "json",
          value: {
            text
          }
        }
      },
      actualCredits: context.step.estimates.credits,
      usage: { provider: "vertex-ai", model }
    };
  }
};

async function writeGeneratedImageArtifact(context: StepExecutionContext, bytes: Buffer, contentType: GeneratedOutputArtifact["contentType"]) {
  const { writePrivateObject } = await import("@/server/gcp/storage");
  let actual: Awaited<ReturnType<typeof inspectImageBytes>>;
  try { actual = await inspectImageBytes(bytes); } catch { throw new GenerationInferenceFailure("PROVIDER_IMAGE_INVALID", "The provider returned corrupt or unsupported image bytes.", false); }
  const size = imageResolution(context);
  if (actual.contentType !== contentType || actual.width !== size.width || actual.height !== size.height) throw new GenerationInferenceFailure("PROVIDER_IMAGE_CONSTRAINT_FAILED", "Returned image type or dimensions do not match the model request.", false);
  const { width, height } = actual;
  const storage = createGeneratedOutputStorageTarget({
    ownerId: context.job.ownerId,
    jobId: context.job._id,
    attemptId: context.attemptId,
    stepId: context.step.id,
    contentType
  });
  const written = await writePrivateObject({
    bucket: storage.bucket,
    objectPath: storage.objectPath,
    contentType,
    data: bytes
  });

  return {
    contentType,
    width,
    height,
    sizeBytes: written.sizeBytes,
    sha256: written.sha256,
    storage
  } satisfies GeneratedOutputArtifact;
}

function googleAiStudioPrompt(context: StepExecutionContext) {
  const prompt = [context.step.parameters.prompt, textFromInputs(context.inputs)]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n")
    .trim();
  const negativePrompt =
    typeof context.step.parameters.negativePrompt === "string" && context.step.parameters.negativePrompt.trim().length > 0
      ? `Avoid: ${context.step.parameters.negativePrompt.trim()}`
      : "";

  return [prompt, negativePrompt].filter(Boolean).join("\n\n").trim();
}

async function googleAiStudioImageInputParts(context: StepExecutionContext) {
  const { readPrivateObject } = await import("@/server/gcp/storage");
  const model = reviewedImageModel(context);
  const images = Object.values(context.inputs).filter((input): input is StepImageValue => input.type === "image");
  if (images.length !== 1) throw new GenerationInferenceFailure("IMAGE_INPUT_INVALID", "This adapter requires exactly one owned source image.", false);
  return Promise.all(images.map(async (image) => {
    const bytes = await readPrivateObject(image.storage);
    if (bytes.length > model.maxInputBytes) throw new GenerationInferenceFailure("IMAGE_INPUT_TOO_LARGE", "Source image exceeds the reviewed 7 MB adapter limit.", false);
    let actual: Awaited<ReturnType<typeof inspectImageBytes>>;
    try { actual = await inspectImageBytes(bytes); } catch { throw new GenerationInferenceFailure("IMAGE_INPUT_INVALID", "Source image bytes are invalid.", false); }
    return { type: "image" as const, mime_type: actual.contentType, data: bytes.toString("base64") };
  }));
}

function extractGoogleAiStudioImage(response: unknown) {
  const candidates = [
    response,
    typeof response === "object" && response ? (response as { interaction?: unknown }).interaction : undefined
  ].filter((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null);

  for (const candidate of candidates) {
    const outputImage = candidate.output_image ?? candidate.outputImage;

    if (typeof outputImage !== "object" || outputImage === null) {
      continue;
    }

    const image = outputImage as Record<string, unknown>;
    const data = image.data;
    const mimeType = image.mime_type ?? image.mimeType;

    if (typeof data === "string" && data.length > 0) {
      return {
        base64: data,
        contentType: typeof mimeType === "string" ? mimeType : undefined
      };
    }
  }

  return null;
}

const vertexImageAdapter: StepExecutionAdapter = {
  id: "vertex-image",
  async execute(context, hooks) {
    const model = reviewedImageModel(context);
    const project = vertexProject();
    if (!project || vertexLocation() !== "global" || !/^[a-z][a-z0-9-]{4,62}$/.test(project)) throw new GenerationInferenceFailure("VERTEX_AI_NOT_CONFIGURED", "Configure the application GCP project, global Vertex location and worker service identity.", false);
    const size = imageResolution(context);
    await hooks.progress({ type: "progress", status: "GENERATING", progress: 45, message: "Application-managed Vertex image inference is running." });
    await assertNotCancelled(hooks);
    const parts: unknown[] = [{ text: googleAiStudioPrompt(context) }];
    if (context.step.nodeType === "image-to-image") {
      for (const image of await googleAiStudioImageInputParts(context)) parts.push({ inlineData: { mimeType: image.mime_type, data: image.data } });
    }
    const payload = await postJsonWithTimeout({
      url: `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model.providerModelId}:generateContent`,
      headers: await bearerHeaders(), timeoutSeconds: context.step.timeoutSeconds,
      body: { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], candidateCount: 1, imageConfig: { aspectRatio: size.aspectRatio, imageSize: size.imageSize } } }
    });
    const image = payload?.candidates?.[0]?.content?.parts?.find((part: { inlineData?: { data?: string }; thought?: boolean }) => !part.thought && part.inlineData?.data)?.inlineData;
    if (!image?.data || image.mimeType !== "image/png") throw new GenerationInferenceFailure("VERTEX_IMAGE_OUTPUT_INVALID", "Vertex returned no supported final image; review provider safety/configuration and retry.", false);
    let bytes: Buffer;
    try { bytes = decodeProviderImage(image.data); } catch { throw new GenerationInferenceFailure("VERTEX_IMAGE_OUTPUT_INVALID", "Vertex returned invalid encoded image bytes.", false); }
    await assertNotCancelled(hooks);
    const artifact = await writeGeneratedImageArtifact(context, bytes, "image/png");
    return { outputs: { image: { type: "image", artifact, ...artifact } }, actualCredits: context.step.estimates.credits, usage: { provider: "vertex-ai", model: model.providerModelId } };
  }
};

const googleAiStudioImageAdapter: StepExecutionAdapter = {
  id: "google-ai-studio-image",
  async execute(context, hooks) {
    reviewedImageModel(context);
    if (context.step.nodeType !== "text-to-image" && context.step.nodeType !== "image-to-image") {
      throw new GenerationInferenceFailure("AI_STUDIO_NODE_UNSUPPORTED", "Google AI Studio image generation cannot run this workflow step.", false);
    }

    const apiKey = await loadUserProviderSecret(context.job.ownerId, "google-ai-studio");

    if (!apiKey) {
      throw new GenerationInferenceFailure("AI_STUDIO_API_KEY_REQUIRED", "Google AI Studio API key configuration is missing.", false);
    }

    const model = googleAiStudioModel(context);

    if (!model) {
      throw new GenerationInferenceFailure("AI_STUDIO_MODEL_REQUIRED", "Google AI Studio model configuration is missing.", false);
    }

    const prompt = googleAiStudioPrompt(context);

    if (!prompt) {
      throw new GenerationInferenceFailure("AI_STUDIO_PROMPT_REQUIRED", "Google AI Studio image generation requires a prompt.", false);
    }

    await hooks.progress({
      type: "progress",
      status: "GENERATING",
      progress: 45,
      message: "Google AI Studio image generation request is running."
    });
    await assertNotCancelled(hooks);

    const contentType = contentTypeForFormat(context.step.parameters.outputFormat);
    const size = imageResolution(context);
    const imageParts = context.step.nodeType === "image-to-image" ? await googleAiStudioImageInputParts(context) : [];
    const payload = await postGoogleAiStudioJson({
      url: googleAiStudioEndpoint(),
      apiKey,
      timeoutSeconds: Math.min(context.step.timeoutSeconds, googleAiStudioTimeoutSeconds()),
      body: {
        model,
        input: [{ type: "text", text: prompt }, ...imageParts],
        response_format: {
          type: "image",
          mime_type: contentType,
          aspect_ratio: size.aspectRatio,
          image_size: size.imageSize
        }
      }
    });
    const image = extractGoogleAiStudioImage(payload);

    if (!image) {
      throw new GenerationInferenceFailure("AI_STUDIO_IMAGE_OUTPUT_INVALID", "Google AI Studio returned no image bytes.", true);
    }

    const returnedContentType = image.contentType ?? contentType;

    if (returnedContentType !== "image/png" && returnedContentType !== "image/jpeg" && returnedContentType !== "image/webp") {
      throw new GenerationInferenceFailure("AI_STUDIO_IMAGE_OUTPUT_INVALID", "Google AI Studio returned an unsupported image type.", false);
    }

    let bytes: Buffer;
    try { bytes = decodeProviderImage(image.base64); } catch { throw new GenerationInferenceFailure("AI_STUDIO_IMAGE_OUTPUT_INVALID", "Google AI Studio returned invalid encoded image bytes.", false); }

    if (bytes.byteLength === 0) {
      throw new GenerationInferenceFailure("AI_STUDIO_IMAGE_OUTPUT_INVALID", "Google AI Studio returned empty image bytes.", true);
    }

    await hooks.progress({
      type: "progress",
      status: "UPLOADING",
      progress: 85,
      message: "Google AI Studio image output is uploading."
    });
    await assertNotCancelled(hooks);
    const artifact = await writeGeneratedImageArtifact(context, bytes, returnedContentType);

    return {
      outputs: {
        image: {
          type: "image",
          artifact,
          storage: artifact.storage,
          contentType: artifact.contentType,
          width: artifact.width,
          height: artifact.height,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256
        }
      },
      actualCredits: context.step.estimates.credits,
      usage: { provider: "google-ai-studio", model }
    };
  }
};



const gcpHostedGpuAdapter: StepExecutionAdapter = {
  id: "gcp-hosted-gpu",
  async execute(context, hooks) {
    try {
      const config = getOllamaImageConfiguration();
      const model = reviewedImageModel(context);
      if (model.id !== ollamaImageModelId || context.step.nodeType !== "text-to-image") {
        throw new GenerationInferenceFailure("MODEL_UNAVAILABLE", "Only the fixed FLUX.2 Klein 4B FP8 text-to-image model is supported by this GPU adapter.");
      }
      imageResolution(context);
      for (const [handle, value] of Object.entries(context.inputs)) {
        if ((handle === "prompt" && value.type === "text") || (handle === "dimensions" && value.type === "dimensions")) continue;
        // Empty negative nodes may survive workflow validation; never forward them.
        if (handle === "negative" && value.type === "text" && !value.text.trim()) continue;
        throw new GenerationInferenceFailure("OLLAMA_INPUT_INVALID", "The Ollama adapter accepts only text prompts and supported dimensions.");
      }
      if (model.unsupportedParameters.some((key) => context.step.parameters[key] !== undefined) ||
          context.step.parameters.negativePrompt || context.step.parameters.outputFormat !== "png") {
        throw new GenerationInferenceFailure("MODEL_CONSTRAINT_FAILED", "The execution plan includes unsupported Ollama image parameters.");
      }
      const prompt = [context.step.parameters.prompt, context.inputs.prompt?.type === "text" ? context.inputs.prompt.text : undefined]
        .filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join("\n\n").trim();
      await assertNotCancelled(hooks);
      await hooks.progress({ type: "progress", status: "GENERATING", progress: 45, message: "Private Ollama image inference is running." });
      const bytes = await generateOllamaImage({ prompt, timeoutSeconds: context.step.timeoutSeconds }, hooks);
      await assertNotCancelled(hooks);
      await hooks.progress({ type: "progress", status: "UPLOADING", progress: 85, message: "Saving the generated image to private storage." });
      await assertNotCancelled(hooks);
      const artifact = await writeGeneratedImageArtifact(context, bytes, "image/png");
      return {
        outputs: { image: { type: "image", artifact, ...artifact } },
        actualCredits: context.step.estimates.credits,
        usage: { provider: "ollama", model: ollamaImageModelReference, containerDigest: config.containerDigest, modelDigest: config.modelDigest }
      };
    } catch (error) {
      if (error instanceof OllamaImageError) throw new GenerationInferenceFailure(error.code, error.message, error.retryable);
      throw error;
    }
  }
};

const huggingFaceImageAdapter: StepExecutionAdapter = {
  id: "huggingface-image",
  async execute(context, hooks) {
    try {
      const config = getHuggingFaceConfiguration();
      const definition = reviewedImageModel(context);
      const model = huggingFaceImageModel(definition.id);
      if (!model || context.step.nodeType !== "text-to-image" || definition.providerModelId !== `${model.repository}@${model.revision}`) throw new GenerationInferenceFailure("MODEL_UNAVAILABLE", "The Hugging Face model is not in the reviewed image catalogue.");
      imageResolution(context);
      for (const [handle, value] of Object.entries(context.inputs)) {
        if ((handle === "prompt" && value.type === "text") || (handle === "dimensions" && value.type === "dimensions")) continue;
        if (handle === "negative" && value.type === "text" && !value.text.trim()) continue;
        throw new GenerationInferenceFailure("HF_INPUT_INVALID", "Hugging Face image inference accepts text prompts and supported dimensions.");
      }
      if (definition.unsupportedParameters.some((key) => context.step.parameters[key] !== undefined) || context.step.parameters.negativePrompt || context.step.parameters.outputFormat !== "png") throw new GenerationInferenceFailure("MODEL_CONSTRAINT_FAILED", "Unsupported Hugging Face image parameters.");
      const prompt = [context.step.parameters.prompt, context.inputs.prompt?.type === "text" ? context.inputs.prompt.text : undefined].filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join("\n\n").trim();
      await assertNotCancelled(hooks);
      await hooks.progress({ type: "progress", status: "GENERATING", progress: 45, message: `${model.name} inference is running on the private Hugging Face L4.` });
      const bytes = await generateHuggingFaceImage({ modelId: model.id, prompt, timeoutSeconds: context.step.timeoutSeconds }, hooks);
      await assertNotCancelled(hooks);
      await hooks.progress({ type: "progress", status: "UPLOADING", progress: 85, message: "Saving the generated image to private storage." });
      await assertNotCancelled(hooks);
      const artifact = await writeGeneratedImageArtifact(context, bytes, "image/png");
      return { outputs: { image: { type: "image", artifact, ...artifact } }, actualCredits: context.step.estimates.credits, usage: { provider: "huggingface", model: model.repository, revision: model.revision, containerDigest: config.containerDigest, catalogueSha256: config.catalogueSha256 } };
    } catch (error) {
      if (error instanceof HuggingFaceImageError) throw new GenerationInferenceFailure(error.code, error.message, error.retryable);
      throw error;
    }
  }
};

const externalByokAdapter: StepExecutionAdapter = {
  id: "external-byok",
  async execute() { throw new GenerationInferenceFailure("EXTERNAL_BYOK_UNSUPPORTED", "No specifically implemented external BYOK integration is available.", false); }
};

const safetyAdapter: StepExecutionAdapter = {
  id: "safety-moderation",
  async execute(context) {
    const image = context.inputs.image;

    return {
      outputs: {
        ...(image?.type === "image" ? { approvedImage: image } : {}),
        safety: {
          type: "json",
          value: {
            approved: true,
            policy: context.step.parameters.contentPolicy
          }
        }
      },
      actualCredits: 0,
      usage: { policy: context.step.parameters.contentPolicy }
    };
  }
};

const outputRouterAdapter: StepExecutionAdapter = {
  id: "output-router",
  async execute(context) {
    return {
      outputs: Object.fromEntries(
        Object.entries(context.inputs).filter(([, value]) => value.type === "image" || value.type === "text" || value.type === "json")
      ) as Record<string, StepOutputValue>,
      actualCredits: 0,
      usage: { privateByDefault: true }
    };
  }
};

const imageTransformAdapter: StepExecutionAdapter = {
  id: "image-transform",
  async execute(context) {
    const image = context.inputs.image;

    if (!image || image.type !== "image") {
      throw new GenerationInferenceFailure("IMAGE_INPUT_REQUIRED", "Image transform requires an image input.", false);
    }

    return {
      outputs: {
        image
      },
      actualCredits: 0,
      usage: { operation: context.step.parameters.operation }
    };
  }
};

function assertEnvConfigured(names: readonly string[], code: string, message: string) {
  const missing = names.filter((name) => !optionalEnv(name));

  if (missing.length > 0) {
    throw new GenerationInferenceFailure(code, message, false);
  }
}

function assertDevelopmentFakeAvailable() {
  if (process.env.NODE_ENV === "production") {
    throw new GenerationInferenceFailure("DEVELOPMENT_FAKE_DISABLED", "Development fake inference is disabled.", false);
  }
}

const stepExecutionAdapterRegistry = {
  "development-fake": {
    id: "development-fake",
    adapter: developmentFakeStepAdapter,
    supportedNodeTypes: ["llm-prompt", "text-to-image", "image-to-image", "image-analysis", "image-transform", "safety-check", "output"],
    supportedRoutes: ["development-fake"],
    credentialMode: "none",
    requiredConfiguration: [],
    checkConfiguration: assertDevelopmentFakeAvailable
  },
  "vertex-llm": {
    id: "vertex-llm",
    adapter: vertexLlmAdapter,
    supportedNodeTypes: ["llm-prompt", "image-analysis"],
    supportedRoutes: ["vertex-llm"],
    credentialMode: "platform-identity",
    requiredConfiguration: ["VERTEX_AI_PROJECT_ID or GCP_PROJECT_ID"]
  },
  "vertex-image": {
    id: "vertex-image",
    adapter: vertexImageAdapter,
    supportedNodeTypes: ["text-to-image", "image-to-image"],
    supportedRoutes: ["vertex-image"],
    credentialMode: "platform-identity",
    requiredConfiguration: ["VERTEX_AI_PROJECT_ID or GCP_PROJECT_ID"]
  },
  "google-ai-studio-image": {
    id: "google-ai-studio-image",
    adapter: googleAiStudioImageAdapter,
    supportedNodeTypes: ["text-to-image", "image-to-image"],
    supportedRoutes: ["google-ai-studio-image"],
    credentialMode: "user-byok",
    requiredConfiguration: ["KMS_KEY_RESOURCE"],
    checkConfiguration: () =>
      assertEnvConfigured(
        ["KMS_KEY_RESOURCE"],
        "AI_STUDIO_KMS_REQUIRED",
        "Configure Cloud KMS for account-scoped Google AI Studio credentials."
      )
  },
  "gcp-hosted-gpu": {
    id: "gcp-hosted-gpu",
    adapter: gcpHostedGpuAdapter,
    supportedNodeTypes: ["text-to-image"],
    supportedRoutes: ["gcp-hosted-gpu"],
    credentialMode: "platform-identity",
    requiredConfiguration: ["OLLAMA_IMAGE_GENERATION_ENABLED", "OLLAMA_CONTAINER_DIGEST", "OLLAMA_MODEL_DIGEST", "OLLAMA_DEPLOYMENT_FINGERPRINT", "OLLAMA_SERVICE_URL (worker only)", "OLLAMA_AUDIENCE (worker only)"],
    checkConfiguration: () => {
      try { assertOllamaImageConfigured(); }
      catch (error) {
        if (error instanceof OllamaImageError) throw new GenerationInferenceFailure(error.code, error.message, error.retryable);
        throw error;
      }
    }
  },
  "huggingface-image": {
    id: "huggingface-image",
    adapter: huggingFaceImageAdapter,
    supportedNodeTypes: ["text-to-image"],
    supportedRoutes: ["huggingface-image"],
    credentialMode: "platform-identity",
    requiredConfiguration: ["HF_IMAGE_GENERATION_ENABLED", "HF_MODEL_CACHE_READY", "HF_CONTAINER_DIGEST", "HF_MODEL_CATALOGUE_SHA256", "HF_DEPLOYMENT_FINGERPRINT", "HF_SERVICE_URL (worker only)", "HF_AUDIENCE (worker only)"],
    checkConfiguration: () => {
      try { assertHuggingFaceConfigured(); }
      catch (error) {
        if (error instanceof HuggingFaceImageError) throw new GenerationInferenceFailure(error.code, error.message, error.retryable);
        throw error;
      }
    }
  },
  "external-byok": {
    id: "external-byok",
    adapter: externalByokAdapter,
    supportedNodeTypes: ["llm-prompt", "text-to-image", "image-to-image", "image-analysis", "image-transform"],
    supportedRoutes: ["external-byok"],
    credentialMode: "user-byok",
    requiredConfiguration: ["EXTERNAL_BYOK_ROUTER_URL"],
    checkConfiguration: () => { throw new GenerationInferenceFailure("EXTERNAL_BYOK_UNSUPPORTED", "No specifically implemented external BYOK integration is available.", false); }
  },
  "safety-moderation": {
    id: "safety-moderation",
    adapter: safetyAdapter,
    supportedNodeTypes: ["safety-check"],
    supportedRoutes: [],
    credentialMode: "none",
    requiredConfiguration: []
  },
  "output-router": {
    id: "output-router",
    adapter: outputRouterAdapter,
    supportedNodeTypes: ["output"],
    supportedRoutes: [],
    credentialMode: "none",
    requiredConfiguration: []
  },
  "image-transform": {
    id: "image-transform",
    adapter: imageTransformAdapter,
    supportedNodeTypes: ["image-transform"],
    supportedRoutes: [],
    credentialMode: "none",
    requiredConfiguration: []
  }
} as const satisfies Record<string, StepExecutionAdapterRegistration>;

export type StepExecutionAdapterId = keyof typeof stepExecutionAdapterRegistry;

export function listStepExecutionAdapters() {
  return Object.values(stepExecutionAdapterRegistry).map((registration) => ({
    id: registration.id,
    supportedNodeTypes: registration.supportedNodeTypes,
    supportedRoutes: registration.supportedRoutes,
    credentialMode: registration.credentialMode,
    requiredConfiguration: registration.requiredConfiguration
  }));
}

export function getStepExecutionAdapterRegistration(adapterId: string): StepExecutionAdapterRegistration {
  const registration = stepExecutionAdapterRegistry[adapterId as StepExecutionAdapterId];

  if (!registration) {
    throw new GenerationInferenceFailure("INFERENCE_ADAPTER_UNAVAILABLE", "A production inference adapter is not configured.", false);
  }

  return registration;
}

export function assertStepExecutionAdapterConfigured(adapterId: string) {
  const registration = getStepExecutionAdapterRegistration(adapterId);
  registration.checkConfiguration?.();
  return registration;
}

export function getStepExecutionAdapter(adapterId: string): StepExecutionAdapter {
  const registration = assertStepExecutionAdapterConfigured(adapterId);
  return registration.adapter;
}

export function normalizeStepOutputs(outputs: Record<string, StepOutputValue>) {
  return Object.fromEntries(
    Object.entries(outputs).map(([handle, value]) => [handle, stepOutputValueSchema.parse(value)])
  ) as Record<string, StepOutputValue>;
}

export function normalizeInferenceFailure(error: unknown) {
  if (error instanceof GenerationInferenceFailure) {
    return {
      errorCode: error.code,
      errorMessage: error.safeMessage,
      retryable: error.retryable
    };
  }

  return {
    errorCode: "INFERENCE_ADAPTER_FAILED",
    errorMessage: "The generation worker could not complete the request.",
    retryable: false
  };
}
