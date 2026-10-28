terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.40.0, < 7.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.40.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0, < 4.0.0"
    }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "kms_region" {
  type    = string
  default = null
}
variable "environment" { type = string }
variable "app_name" { type = string }
variable "container_image" { type = string }
variable "artifact_registry_repository_id" { type = string }
variable "next_public_google_client_id" { type = string }
variable "mongodb_db_name" { type = string }
variable "mongodb_app_name" { type = string }
variable "mongodb_app_user" { type = string }
variable "atlas_project_id" { type = string }
variable "generation_worker_url" { type = string }
variable "worker_audience" { type = string }
variable "generation_worker_service_name" {
  type    = string
  default = null
}
variable "generation_worker_container_image" {
  type    = string
  default = null
}
variable "generation_worker_max_instances" {
  type    = number
  default = 1
}
variable "gpu_worker_runtime" {
  type    = string
  default = "ollama"
}
variable "gpu_worker_legacy_node_port" {
  type    = number
  default = 8080
}
variable "ollama_audience" {
  type    = string
  default = ""
}
variable "ollama_image_generation_enabled" {
  type    = bool
  default = false
}
variable "ollama_service_url" {
  type    = string
  default = ""
}
variable "ollama_model_digest" {
  type    = string
  default = "sha256:d968d763271aa912ac5499320d349bf4cb75267d7fbf499203bb8e8f19dde6ef"
}
variable "ollama_model_cache_enabled" {
  type    = bool
  default = true
}
variable "ollama_model_cache_ready" {
  type    = bool
  default = false
}
variable "ollama_model_cache_bucket_name" {
  type    = string
  default = null
}
variable "ollama_cache_seed_container_image" {
  type    = string
  default = null
}
variable "gpu_worker_service_name" {
  type    = string
  default = null
}
variable "gpu_worker_container_image" { type = string }
variable "gpu_worker_audience" {
  type    = string
  default = ""
}
variable "gpu_worker_max_instances" {
  type    = number
  default = 1
}
variable "gpu_worker_timeout_seconds" {
  type    = number
  default = 1800
}
variable "gpu_worker_cpu" {
  type    = string
  default = "4"
}
variable "gpu_worker_memory" {
  type    = string
  default = "16Gi"
}
variable "gpu_worker_container_port" {
  type    = number
  default = 11434
}
variable "gpu_worker_vpc_egress" {
  type    = string
  default = "PRIVATE_RANGES_ONLY"
}
variable "gpu_worker_model_bucket_name" {
  type    = string
  default = ""
}
variable "gcp_gpu_execution_url" {
  type    = string
  default = ""
}
variable "gcp_gpu_execution_audience" {
  type    = string
  default = ""
}
variable "custom_domain" {
  type    = string
  default = null
}
variable "mongodb_atlas_uri" {
  type      = string
  default   = null
  sensitive = true
}
variable "google_oauth_client_secret" {
  type      = string
  default   = null
  sensitive = true
}
variable "session_secret_value" {
  type      = string
  default   = null
  sensitive = true
}
variable "labels" {
  type    = map(string)
  default = {}
}
variable "bucket_name_overrides" {
  type = object({
    input  = optional(string)
    output = optional(string)
    temp   = optional(string)
  })
  default = {}
}
variable "service_account_ids" {
  type = object({
    app_runtime    = optional(string)
    task_invoker   = optional(string)
    worker_runtime = optional(string)
  })
  default = {}
}
variable "storage_force_destroy" {
  type    = bool
  default = true
}
variable "input_asset_retention_days" {
  type    = number
  default = 7
}
variable "output_asset_nearline_days" {
  type    = number
  default = 30
}
variable "temp_asset_retention_days" {
  type    = number
  default = 3
}
variable "output_retention_days" {
  type    = number
  default = 0
}
variable "create_vpc_connector" {
  type    = bool
  default = false
}
variable "cloud_run_min_instances" {
  type    = number
  default = 0
}
variable "cloud_run_max_instances" {
  type    = number
  default = 5
}
variable "cloud_tasks_max_dispatches_per_second" {
  type    = number
  default = 1
}
variable "cloud_tasks_max_concurrent_dispatches" {
  type    = number
  default = 3
}
variable "monitoring_notification_emails" {
  type    = list(string)
  default = []
}

module "platform" {
  source = "../.."

  huggingface_enabled                    = var.huggingface_enabled
  huggingface_image_generation_enabled   = var.huggingface_image_generation_enabled
  huggingface_model_cache_ready          = var.huggingface_model_cache_ready
  huggingface_container_image            = var.huggingface_container_image
  huggingface_cache_seed_container_image = var.huggingface_cache_seed_container_image
  huggingface_model_cache_bucket_name    = var.huggingface_model_cache_bucket_name
  huggingface_max_instances              = var.huggingface_max_instances

  project_id                            = var.project_id
  region                                = var.region
  kms_region                            = var.kms_region
  environment                           = var.environment
  app_name                              = var.app_name
  labels                                = var.labels
  artifact_registry_repository_id       = var.artifact_registry_repository_id
  container_image                       = var.container_image
  next_public_google_client_id          = var.next_public_google_client_id
  google_oauth_client_secret            = var.google_oauth_client_secret
  mongodb_atlas_uri                     = var.mongodb_atlas_uri
  mongodb_db_name                       = var.mongodb_db_name
  mongodb_app_name                      = var.mongodb_app_name
  mongodb_app_user                      = var.mongodb_app_user
  atlas_project_id                      = var.atlas_project_id
  session_secret_value                  = var.session_secret_value
  bucket_name_overrides                 = var.bucket_name_overrides
  storage_force_destroy                 = var.storage_force_destroy
  input_asset_retention_days            = var.input_asset_retention_days
  output_asset_nearline_days            = var.output_asset_nearline_days
  temp_asset_retention_days             = var.temp_asset_retention_days
  output_retention_days                 = var.output_retention_days
  create_vpc_connector                  = var.create_vpc_connector
  service_account_ids                   = var.service_account_ids
  cloud_run_min_instances               = var.cloud_run_min_instances
  cloud_run_max_instances               = var.cloud_run_max_instances
  cloud_tasks_max_dispatches_per_second = var.cloud_tasks_max_dispatches_per_second
  cloud_tasks_max_concurrent_dispatches = var.cloud_tasks_max_concurrent_dispatches
  generation_worker_url                 = var.generation_worker_url
  worker_audience                       = var.worker_audience
  generation_worker_service_name        = var.generation_worker_service_name
  generation_worker_container_image     = var.generation_worker_container_image
  generation_worker_max_instances       = var.generation_worker_max_instances
  gpu_worker_runtime                    = var.gpu_worker_runtime
  gpu_worker_legacy_node_port            = var.gpu_worker_legacy_node_port
  ollama_audience                       = var.ollama_audience
  ollama_image_generation_enabled       = var.ollama_image_generation_enabled
  ollama_service_url                    = var.ollama_service_url
  ollama_model_digest                   = var.ollama_model_digest
  ollama_model_cache_enabled            = var.ollama_model_cache_enabled
  ollama_model_cache_ready              = var.ollama_model_cache_ready
  ollama_model_cache_bucket_name        = var.ollama_model_cache_bucket_name
  ollama_cache_seed_container_image     = var.ollama_cache_seed_container_image
  gpu_worker_service_name               = var.gpu_worker_service_name
  gpu_worker_container_image            = var.gpu_worker_container_image
  gpu_worker_enable_gpu                 = var.gpu_worker_enable_gpu
  gpu_worker_audience                   = var.gpu_worker_audience
  gpu_worker_max_instances              = var.gpu_worker_max_instances
  gpu_worker_timeout_seconds            = var.gpu_worker_timeout_seconds
  gpu_worker_cpu                        = var.gpu_worker_cpu
  gpu_worker_memory                     = var.gpu_worker_memory
  gpu_worker_container_port             = var.gpu_worker_container_port
  gpu_worker_vpc_egress                 = var.gpu_worker_vpc_egress
  gpu_worker_model_bucket_name          = var.gpu_worker_model_bucket_name
  gcp_gpu_execution_url                 = var.gcp_gpu_execution_url
  gcp_gpu_execution_audience            = var.gcp_gpu_execution_audience
  custom_domain                         = var.custom_domain
  monitoring_notification_emails        = var.monitoring_notification_emails
}

output "cloud_run_service_url" {
  value = module.platform.cloud_run_service_url
}

output "bucket_names" {
  value = module.platform.bucket_names
}

output "secret_ids" {
  value = module.platform.secret_ids
}

output "service_accounts" {
  value = module.platform.service_accounts
}

output "gpu_worker" {
  value = {
    service_name = module.platform.gpu_worker_service_name
    service_url  = module.platform.gpu_worker_service_url
    audience     = module.platform.ollama_audience
    deployment   = module.platform.gpu_worker_deployment
  }
}

output "generation_worker" {
  value = {
    service_name = module.platform.generation_worker_service_name
    service_url  = module.platform.generation_worker_service_url
    endpoint     = module.platform.generation_worker_endpoint
    audience     = module.platform.generation_worker_audience
  }
}

output "ollama" {
  value = {
    service_url     = module.platform.ollama_service_url
    audience        = module.platform.ollama_audience
    model_selection = module.platform.ollama_model_selection
    model_cache     = module.platform.ollama_model_cache
    image_adapter   = module.platform.ollama_image_adapter
  }
}

variable "gpu_worker_enable_gpu" {
  type    = bool
  default = false
}
