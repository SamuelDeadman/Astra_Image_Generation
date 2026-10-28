import "server-only";

import { CloudTasksClient, protos } from "@google-cloud/tasks";
import { configurationRequired } from "@/server/errors";
import { missingEnv, requiredEnv } from "@/server/env";
import { createWorkerTaskPayload } from "@/server/generations/worker-contract";

let tasksClient: CloudTasksClient | undefined;

function getTasksClient() {
  tasksClient ??= new CloudTasksClient();
  return tasksClient;
}

export function assertCloudTasksConfigured() {
  const missing = missingEnv([
    "GCP_PROJECT_ID",
    "GCP_TASKS_LOCATION",
    "GCP_TASKS_QUEUE",
    "GENERATION_WORKER_URL",
    "WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL",
    "WORKER_AUDIENCE"
  ]);

  if (missing.length > 0) {
    throw configurationRequired("Cloud Tasks generation dispatch is not configured.", { missing });
  }
}

export async function enqueueGenerationTask(input: {
  jobId: string;
  workflowVersionId: string;
  attemptId: string;
}) {
  assertCloudTasksConfigured();

  const projectId = requiredEnv("GCP_PROJECT_ID");
  const location = requiredEnv("GCP_TASKS_LOCATION");
  const queue = requiredEnv("GCP_TASKS_QUEUE");
  const workerUrl = requiredEnv("GENERATION_WORKER_URL");
  const serviceAccountEmail = requiredEnv("WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL");
  const audience = requiredEnv("WORKER_AUDIENCE");
  const parent = getTasksClient().queuePath(projectId, location, queue);
  const payload = createWorkerTaskPayload({
    jobId: input.jobId,
    workflowRevisionId: input.workflowVersionId,
    attemptId: input.attemptId
  });
  const body = Buffer.from(JSON.stringify(payload)).toString("base64");
  const task: protos.google.cloud.tasks.v2.ITask = {
    httpRequest: {
      httpMethod: "POST",
      url: workerUrl,
      headers: {
        "Content-Type": "application/json"
      },
      body,
      oidcToken: {
        serviceAccountEmail,
        audience
      }
    },
    dispatchDeadline: {
      seconds: 1800
    }
  };

  const [createdTask] = await getTasksClient().createTask({ parent, task });
  if (!createdTask.name) {
    throw configurationRequired("Cloud Tasks did not return a task name.");
  }

  return createdTask.name;
}
