output "project_id" {
  description = "GCP project ID."
  value       = var.project_id
}

output "region" {
  description = "Primary deployment region."
  value       = var.region
}

output "artifact_registry_repository" {
  description = "Artifact Registry repository resource ID."
  value       = module.project_bootstrap.artifact_registry_repository_id
}

output "cloud_run_service_name" {
  description = "Cloud Run web service name."
  value       = module.cloud_run.service_name
}

output "cloud_run_service_url" {
  description = "Cloud Run web service URL."
  value       = module.cloud_run.service_url
}

output "gpu_worker_service_name" {
  description = "Private Cloud Run GPU worker service name."
  value       = module.gpu_worker.service_name
}

output "gpu_worker_service_url" {
  description = "Private Cloud Run GPU worker service URL."
  value       = module.gpu_worker.service_url
}

output "gpu_worker_endpoint" {
  description = "Deprecated alias for generation_worker_endpoint. Always targets Node, never Ollama."
  value       = module.generation_worker.worker_endpoint
}

output "gpu_worker_audience" {
  description = "Deprecated legacy task-audience alias. Use generation_worker_audience for tasks or ollama_audience for Ollama."
  value       = local.gpu_worker_audience
}

output "generation_worker_service_name" {
  description = "Private Node generation worker service name."
  value       = module.generation_worker.service_name
}

output "generation_worker_service_url" {
  description = "Private Node generation worker service URL."
  value       = module.generation_worker.service_url
}

output "generation_worker_endpoint" {
  description = "Cloud Tasks POST endpoint, retaining the existing task contract."
  value       = module.generation_worker.worker_endpoint
}

output "generation_worker_audience" {
  description = "Effective OIDC audience registered on Node and verified by the task handler."
  value       = local.generation_worker_audience
}

output "ollama_service_url" {
  description = "Private Ollama URL for the gated fixed-model image adapter."
  value       = module.gpu_worker.service_url
}

output "ollama_audience" {
  description = "Separate registered Cloud Run audience for private Node-to-Ollama ID-token calls."
  value       = local.ollama_audience
}

output "ollama_model_selection" {
  description = "Requested exact model and platform-review status. This output does not indicate installation, loading or inference readiness."
  value       = local.ollama_model_selection
}

output "gpu_worker_deployment" {
  description = "GPU worker deployment shape. Does not prove model inference is implemented."
  value       = module.gpu_worker.deployment
}

output "bucket_names" {
  description = "Private Cloud Storage bucket names."
  value = {
    input  = module.storage.input_bucket_name
    output = module.storage.output_bucket_name
    temp   = module.storage.temp_bucket_name
  }
}

output "secret_ids" {
  description = "Secret Manager short IDs. Raw secret values are never output."
  value       = module.secrets.secret_ids
}

output "kms_keyring_id" {
  description = "KMS key ring resource ID."
  value       = module.kms.keyring_id
}

output "kms_crypto_key_id" {
  description = "KMS crypto key resource ID used for envelope encryption."
  value       = module.kms.crypto_key_id
}

output "cloud_tasks_queue_name" {
  description = "Cloud Tasks generation queue name."
  value       = module.tasks.queue_name
}

output "cloud_tasks_queue_id" {
  description = "Cloud Tasks generation queue resource ID."
  value       = module.tasks.queue_id
}

output "service_accounts" {
  description = "Runtime service account emails."
  value = {
    app_runtime    = module.iam.app_runtime_service_account_email
    task_invoker   = module.iam.task_invoker_service_account_email
    worker_runtime = module.iam.worker_runtime_service_account_email
    ollama_runtime = google_service_account.ollama_runtime.email
  }
}

output "mongodb_atlas_external_dependency" {
  description = "MongoDB Atlas metadata only. Atlas is not provisioned by this GCP Terraform stack."
  value = {
    atlas_project_id = var.atlas_project_id
    database_name    = var.mongodb_db_name
    app_user         = var.mongodb_app_user
  }
}

output "ollama_image_adapter" {
  description = "Image-adapter admission settings, not evidence of a working runtime."
  value = {
    enabled                = var.ollama_image_generation_enabled
    container_digest       = local.ollama_container_digest
    model_digest           = var.ollama_model_digest
    deployment_fingerprint = try(local.ollama_admission_environment.OLLAMA_DEPLOYMENT_FINGERPRINT, null)
  }
}

output "monitoring_error_metric_name" {
  description = "Cloud Logging metric used for Cloud Run error alerting."
  value       = module.monitoring.error_metric_name
}
