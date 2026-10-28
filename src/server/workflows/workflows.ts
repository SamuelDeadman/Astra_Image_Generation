import "server-only";

import { nanoid } from "nanoid";
import { conflict, notFound, validationFailed } from "@/server/errors";
import { getWorkflowModelIds, normalizeWorkflowDocument, validateWorkflow, workflowSchemaVersion } from "@/lib/workflow/schema";
import { assertWorkflowAssetsOwned } from "@/server/assets/assets";
import { requireEnabledModels } from "@/server/models/models";
import { mongoCollection, withMongoTransaction } from "@/server/db/mongodb";
import {
  collectionNames,
  type WorkflowDocumentRecord,
  type WorkflowEventDocument,
  type WorkflowRevisionDocument,
  type WorkflowStatus
} from "@/server/db/types";

export type WorkflowSummaryDTO = {
  id: string;
  folderId?: string;
  name: string;
  status: WorkflowStatus;
  currentVersionId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowDetailDTO = WorkflowSummaryDTO & {
  currentVersion?: {
    id: string;
    versionNumber: number;
    graph: unknown;
    selectedModel: string;
    executionEnvironment: string;
    createdAt: string;
  };
};

function toSummary(workflow: WorkflowDocumentRecord): WorkflowSummaryDTO {
  return {
    id: workflow._id,
    folderId: workflow.folderId,
    name: workflow.name,
    status: workflow.status,
    currentVersionId: workflow.currentRevisionId,
    revision: workflow.revision,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString()
  };
}

export async function listWorkflows(ownerId: string) {
  const workflows = await mongoCollection<WorkflowDocumentRecord>(collectionNames.workflows);
  const records = await workflows
    .find({
      ownerId,
      archivedAt: { $exists: false }
    })
    .sort({ updatedAt: -1 })
    .toArray();

  return records.map(toSummary);
}

export async function getWorkflow(ownerId: string, workflowId: string): Promise<WorkflowDetailDTO> {
  const workflows = await mongoCollection<WorkflowDocumentRecord>(collectionNames.workflows);
  const revisions = await mongoCollection<WorkflowRevisionDocument>(collectionNames.workflowRevisions);
  const workflow = await workflows.findOne({
    _id: workflowId,
    ownerId,
    archivedAt: { $exists: false }
  });

  if (!workflow) {
    throw notFound("Workflow not found.");
  }

  const currentVersion = workflow.currentRevisionId
    ? await revisions.findOne({ _id: workflow.currentRevisionId, workflowId: workflow._id, ownerId })
    : await revisions.findOne({ workflowId: workflow._id, ownerId }, { sort: { revision: -1 } });

  const normalizedVersion = currentVersion ? normalizeWorkflowDocument(currentVersion.workflow) : null;
  const currentGraph = normalizedVersion?.ok ? normalizedVersion.workflow : currentVersion?.workflow;

  return {
    ...toSummary(workflow),
    currentVersion: currentVersion
      ? {
          id: currentVersion._id,
          versionNumber: currentVersion.revision,
          graph: currentGraph,
          selectedModel: currentGraph?.selectedModel ?? currentVersion.selectedModel,
          executionEnvironment: currentGraph?.executionEnvironment ?? "gcp-hosted",
          createdAt: currentVersion.createdAt.toISOString()
        }
      : undefined
  };
}

export async function createWorkflowVersion(input: {
  ownerId: string;
  workflowId?: string;
  name: string;
  folderId?: string;
  workflow: unknown;
}) {
  const structuralValidation = validateWorkflow(input.workflow);

  if (!structuralValidation.ok) {
    throw validationFailed("Workflow validation failed.", { issues: structuralValidation.issues });
  }

  const models = await requireEnabledModels(getWorkflowModelIds(structuralValidation.workflow));
  const validation = validateWorkflow(input.workflow, {
    models: models.map((model) => ({
      id: model.id,
      name: model.displayName,
      route: model.route,
      maxPixels: model.maxPixels,
      maxSteps: model.maxSteps,
      baseCreditCost: model.baseCreditCost,
      isEnabled: model.isEnabled,
      capabilities: model.capabilities
    }))
  });

  if (!validation.ok) {
    throw validationFailed("Workflow validation failed.", { issues: validation.issues });
  }

  await assertWorkflowAssetsOwned(input.ownerId, validation.workflow);

  return withMongoTransaction(async (session) => {
    const workflows = await mongoCollection<WorkflowDocumentRecord>(collectionNames.workflows);
    const revisions = await mongoCollection<WorkflowRevisionDocument>(collectionNames.workflowRevisions);
    const workflowEvents = await mongoCollection<WorkflowEventDocument>(collectionNames.workflowEvents);
    const now = new Date();

    const existingWorkflow = input.workflowId
      ? await workflows.findOne(
          {
            _id: input.workflowId,
            ownerId: input.ownerId,
            archivedAt: { $exists: false }
          },
          { session }
        )
      : null;

    if (input.workflowId && !existingWorkflow) {
      throw notFound("Workflow not found.");
    }

    const workflowId = existingWorkflow?._id ?? nanoid();
    const revisionNumber = (existingWorkflow?.revision ?? 0) + 1;
    const revisionId = nanoid();
    const revision: WorkflowRevisionDocument = {
      _id: revisionId,
      workflowId,
      ownerId: input.ownerId,
      revision: revisionNumber,
      workflow: validation.workflow,
      selectedModel: validation.workflow.selectedModel,
      workflowSchemaVersion,
      validation: {
        ok: true,
        warnings: validation.warnings
      },
      createdAt: now
    };

    let workflow: WorkflowDocumentRecord;

    if (existingWorkflow) {
      const setFields: Record<string, unknown> = {
        name: input.name,
        status: "ACTIVE",
        currentRevisionId: revisionId,
        updatedAt: now
      };
      const unsetFields: Record<string, ""> = {};

      if (input.folderId) {
        setFields.folderId = input.folderId;
      } else {
        unsetFields.folderId = "";
      }

      const updateResult = await workflows.updateOne(
        {
          _id: existingWorkflow._id,
          ownerId: input.ownerId,
          archivedAt: { $exists: false },
          revision: existingWorkflow.revision
        },
        {
          $set: setFields,
          ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
          $inc: { revision: 1 }
        },
        { session }
      );

      if (updateResult.modifiedCount === 0) {
        throw conflict("Workflow changed while this revision was being saved.");
      }

      workflow = {
        ...existingWorkflow,
        name: input.name,
        ...(input.folderId ? { folderId: input.folderId } : { folderId: undefined }),
        status: "ACTIVE",
        currentRevisionId: revisionId,
        revision: revisionNumber,
        updatedAt: now
      };
    } else {
      workflow = {
        _id: workflowId,
        ownerId: input.ownerId,
        ...(input.folderId ? { folderId: input.folderId } : {}),
        name: input.name,
        status: "ACTIVE",
        currentRevisionId: revisionId,
        revision: revisionNumber,
        createdAt: now,
        updatedAt: now
      };

      await workflows.insertOne(workflow, { session });
    }

    await revisions.insertOne(revision, { session });
    await workflowEvents.insertOne(
      {
        _id: nanoid(),
        workflowId,
        ownerId: input.ownerId,
        actorUserId: input.ownerId,
        eventType: existingWorkflow ? "workflow.revision.created" : "workflow.created",
        revision: revisionNumber,
        metadata: {
          selectedModel: validation.workflow.selectedModel,
          executionEnvironment: validation.workflow.executionEnvironment,
          modelIds: models.map((model) => model.id),
          warnings: validation.warnings
        },
        createdAt: now
      },
      { session }
    );

    return {
      workflow: toSummary(workflow),
      version: {
        id: revision._id,
        versionNumber: revision.revision,
        selectedModel: revision.selectedModel,
        executionEnvironment: revision.workflow.executionEnvironment,
        createdAt: revision.createdAt.toISOString()
      },
      warnings: validation.warnings
    };
  });
}

export async function archiveWorkflow(ownerId: string, workflowId: string) {
  const workflows = await mongoCollection<WorkflowDocumentRecord>(collectionNames.workflows);
  const workflowEvents = await mongoCollection<WorkflowEventDocument>(collectionNames.workflowEvents);
  const now = new Date();
  const result = await workflows.updateOne(
    {
      _id: workflowId,
      ownerId,
      archivedAt: { $exists: false }
    },
    {
      $set: {
        status: "ARCHIVED",
        archivedAt: now,
        updatedAt: now
      }
    }
  );

  if (result.modifiedCount === 0) {
    throw notFound("Workflow not found.");
  }

  await workflowEvents.insertOne({
    _id: nanoid(),
    workflowId,
    ownerId,
    actorUserId: ownerId,
    eventType: "workflow.archived",
    createdAt: now
  });
}
