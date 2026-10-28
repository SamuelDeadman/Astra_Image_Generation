variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Primary region."
  type        = string
}

variable "app_runtime_service_account_id" {
  description = "Service account ID for Cloud Run web app runtime."
  type        = string
}

variable "task_invoker_service_account_id" {
  description = "Service account ID used by Cloud Tasks OIDC tokens."
  type        = string
}

variable "worker_runtime_service_account_id" {
  description = "Service account ID for the private Node generation worker runtime."
  type        = string
}

variable "labels" {
  description = "Labels for service accounts."
  type        = map(string)
  default     = {}
}

variable "secret_resource_ids" {
  description = "Secret Manager short IDs keyed by logical name for the web app runtime."
  type        = map(string)
}

variable "worker_secret_resource_ids" {
  description = "Secret Manager short IDs keyed by logical name for the worker runtime."
  type        = map(string)
  default     = {}
}

variable "input_bucket_name" {
  description = "Input asset bucket name."
  type        = string
}

variable "output_bucket_name" {
  description = "Generated output bucket name."
  type        = string
}

variable "temp_bucket_name" {
  description = "Temporary asset bucket name."
  type        = string
}

variable "artifact_registry_repository_id" {
  description = "Artifact Registry repository short ID."
  type        = string
}

variable "artifact_registry_location" {
  description = "Artifact Registry repository region."
  type        = string
}

variable "cloud_tasks_queue_id" {
  description = "Cloud Tasks queue resource ID."
  type        = string
}

variable "kms_crypto_key_id" {
  description = "KMS crypto key resource ID."
  type        = string
}
