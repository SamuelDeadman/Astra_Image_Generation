variable "project_id" {
  description = "GCP project ID where platform resources are provisioned."
  type        = string
}

variable "region" {
  description = "Primary GCP region for regional resources such as Cloud Run, Cloud Tasks, KMS, and Artifact Registry."
  type        = string
  default     = "europe-west1"
}

variable "environment" {
  description = "Deployment environment name, for example dev, staging, or prod."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "environment must start with a lowercase letter and contain only lowercase letters, digits, or hyphens."
  }
}

variable "app_name" {
  description = "Short application name used in resource naming."
  type        = string
  default     = "astraflow"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}$", var.app_name))
    error_message = "app_name must start with a lowercase letter and contain only lowercase letters, digits, or hyphens."
  }
}

variable "labels" {
  description = "Additional labels applied to supported resources."
  type        = map(string)
  default     = {}
}

variable "enable_project_services" {
  description = "Whether Terraform should enable required Google Cloud APIs."
  type        = bool
  default     = true
}

variable "disable_services_on_destroy" {
  description = "Whether enabled Google Cloud APIs should be disabled when Terraform destroys the stack. Usually false for shared projects."
  type        = bool
  default     = false
}

variable "artifact_registry_repository_id" {
  description = "Artifact Registry repository ID used for application and worker container images."
  type        = string
  default     = null
}

variable "artifact_registry_format" {
  description = "Artifact Registry repository format."
  type        = string
  default     = "DOCKER"
}

variable "container_image" {
  description = "Full container image reference for the Cloud Run web application."
  type        = string
}

variable "next_public_google_client_id" {
  description = "Google OAuth Web application client ID, exposed through the runtime auth-config API and used for server-side ID token audience verification."
  type        = string
  default     = ""
}

variable "google_oauth_client_secret" {
  description = "Optional Google OAuth client secret. Keep unset unless the runtime flow requires it. Supplying this stores the value in Terraform state."
  type        = string
  default     = null
  sensitive   = true
}

variable "mongodb_atlas_uri" {
  description = "MongoDB Atlas connection string for the app. Atlas is managed outside GCP; pass this securely with TF_VAR_mongodb_atlas_uri or a CI secret. Supplying this stores the value in Terraform state."
  type        = string
  default     = null
  sensitive   = true
}

variable "mongodb_db_name" {
  description = "MongoDB database name used by the application."
  type        = string
  default     = "astraflow"
}

variable "mongodb_app_name" {
  description = "MongoDB driver appName value used for Atlas observability."
  type        = string
  default     = "astraflow-image-studio"
}

variable "mongodb_app_user" {
  description = "Non-secret MongoDB Atlas application database user name. The user/password/database/network access are managed externally in Atlas."
  type        = string
  default     = ""
}

variable "atlas_project_id" {
  description = "External MongoDB Atlas project ID for documentation/outputs only. Terraform in this repo does not provision Atlas resources."
  type        = string
  default     = ""
}

variable "session_secret_value" {
  description = "Optional explicit session secret value. Leave null to let Terraform generate one. Supplying this stores the value in Terraform state."
  type        = string
  default     = null
  sensitive   = true
}

variable "generate_session_secret" {
  description = "Generate a random SESSION_SECRET Secret Manager version when session_secret_value is null."
  type        = bool
  default     = true
}

variable "create_secret_versions" {
  description = "Whether Terraform should create Secret Manager versions for supplied/generated secrets. Disable when secrets are populated out of band."
  type        = bool
  default     = true
}

variable "additional_runtime_secret_names" {
  description = "Additional Secret Manager secret IDs to create for future runtime secrets. Values are intentionally not managed here."
  type        = list(string)
  default     = []
}

variable "bucket_name_overrides" {
  description = "Optional explicit globally unique bucket names. When omitted, names are derived from app, environment, and project ID."
  type = object({
    input  = optional(string)
    output = optional(string)
    temp   = optional(string)
  })
  default = {}
}

variable "storage_force_destroy" {
  description = "Allow Terraform to delete non-empty buckets. Keep false in production."
  type        = bool
  default     = false
}

variable "input_asset_retention_days" {
  description = "Lifecycle age in days for uploaded input/reference assets."
  type        = number
  default     = 30
}

variable "output_asset_nearline_days" {
  description = "Age in days before generated output objects transition to NEARLINE."
  type        = number
  default     = 90
}

variable "temp_asset_retention_days" {
  description = "Lifecycle age in days for temporary/generated intermediate assets."
  type        = number
  default     = 7
}

variable "output_retention_days" {
  description = "Optional retention policy duration for generated output bucket objects. Set to 0 to disable."
  type        = number
  default     = 0
}

variable "create_vpc_connector" {
  description = "Create a Serverless VPC Access connector for private egress. Atlas connectivity is still configured externally."
  type        = bool
  default     = false
}

variable "vpc_connector_cidr_range" {
  description = "CIDR range for the Serverless VPC Access connector."
  type        = string
  default     = "10.8.0.0/28"
}

variable "service_account_ids" {
  description = "Optional service account IDs. Defaults are derived from app/environment."
  type = object({
    app_runtime    = optional(string)
    task_invoker   = optional(string)
    worker_runtime = optional(string)
  })
  default = {}
}

variable "cloud_run_service_name" {
  description = "Optional Cloud Run web service name. Defaults to app-environment-web."
  type        = string
  default     = null
}

variable "cloud_run_ingress" {
  description = "Cloud Run ingress policy."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"
}

variable "allow_unauthenticated" {
  description = "Grant allUsers roles/run.invoker on the web app. Public product frontends usually set this true."
  type        = bool
  default     = true
}

variable "cloud_run_cpu" {
  description = "Cloud Run container CPU limit."
  type        = string
  default     = "1"
}

variable "cloud_run_memory" {
  description = "Cloud Run container memory limit."
  type        = string
  default     = "1Gi"
}

variable "cloud_run_min_instances" {
  description = "Minimum Cloud Run instances."
  type        = number
  default     = 0
}

variable "cloud_run_max_instances" {
  description = "Maximum Cloud Run instances."
  type        = number
  default     = 10
}

variable "cloud_run_timeout_seconds" {
  description = "Cloud Run request timeout in seconds."
  type        = number
  default     = 300
}

variable "custom_domain" {
  description = "Optional verified custom domain for the Cloud Run service. DNS verification and records remain external/manual."
  type        = string
  default     = null
}

variable "cloud_tasks_queue_name" {
  description = "Optional Cloud Tasks queue name. Defaults to app-environment-generation."
  type        = string
  default     = null
}

variable "cloud_tasks_max_dispatches_per_second" {
  description = "Maximum generation task dispatch rate."
  type        = number
  default     = 2
}

variable "cloud_tasks_max_concurrent_dispatches" {
  description = "Maximum concurrently dispatched generation tasks."
  type        = number
  default     = 10
}

variable "cloud_tasks_max_attempts" {
  description = "Maximum Cloud Tasks delivery attempts."
  type        = number
  default     = 5
}

variable "generation_worker_url" {
  description = "HTTPS Node worker endpoint for Cloud Tasks. Empty uses the managed generation-worker. Never point this at Ollama."
  type        = string
  default     = ""
}

variable "worker_audience" {
  description = "Cloud Tasks OIDC audience. Defaults to the existing legacy audience to preserve authentication and model verification evidence."
  type        = string
  default     = ""
}

variable "gpu_worker_service_name" {
  description = "Optional private Cloud Run GPU worker service name. Defaults to app-environment-gpu-worker."
  type        = string
  default     = null
}

variable "gpu_worker_container_image" {
  description = "Private Ollama image. Use ollama/ollama:latest in dev and its tested immutable digest in prod."
  type        = string

  validation {
    condition = (
      var.environment != "prod" ||
      startswith(var.gpu_worker_container_image, "replace-me") ||
      can(regex("@sha256:[a-f0-9]{64}$", var.gpu_worker_container_image))
    )
    error_message = "Production gpu_worker_container_image must be an immutable @sha256 digest unless it is an explicit replace-me placeholder."
  }
}

variable "gpu_worker_audience" {
  description = "Deprecated legacy Cloud Tasks audience alias, retained for compatibility. Use worker_audience for tasks and ollama_audience for Ollama."
  type        = string
  default     = ""
}

variable "gpu_worker_max_instances" {
  description = "Maximum private GPU worker instances."
  type        = number
  default     = 2
}

variable "gpu_worker_timeout_seconds" {
  description = "Private GPU worker request timeout in seconds."
  type        = number
  default     = 1800
}

variable "gpu_worker_cpu" {
  description = "Private GPU worker CPU limit. NVIDIA L4 requires at least 4 CPU."
  type        = string
  default     = "4"
}

variable "gpu_worker_memory" {
  description = "Private GPU worker memory limit. NVIDIA L4 requires at least 16Gi."
  type        = string
  default     = "16Gi"
}

variable "gpu_worker_container_port" {
  description = "Private GPU worker container HTTP port."
  type        = number
  default     = 11434
}

variable "gpu_worker_vpc_egress" {
  description = "GPU worker VPC egress mode when a connector is configured."
  type        = string
  default     = "PRIVATE_RANGES_ONLY"
}

variable "gpu_worker_model_bucket_name" {
  description = "Legacy optional model bucket access for the Node runtime only. Does not persist or mount Ollama models; Ollama gets no bucket access."
  type        = string
  default     = ""
}

variable "gcp_gpu_execution_url" {
  description = "Optional GPU step-execution endpoint used by the gcp-hosted-gpu adapter. Leave empty until a real runtime implements the step contract."
  type        = string
  default     = ""
}

variable "gcp_gpu_execution_audience" {
  description = "Optional OIDC audience for gcp_gpu_execution_url. Defaults to gcp_gpu_execution_url when that endpoint is set."
  type        = string
  default     = ""
}

variable "kms_region" {
  description = "Region for the existing credential-encryption KMS key."
  type        = string
  default     = null
}

variable "kms_keyring_name" {
  description = "Optional KMS key ring name."
  type        = string
  default     = null
}

variable "kms_crypto_key_name" {
  description = "Optional KMS crypto key name for BYOK credential envelope encryption."
  type        = string
  default     = null
}

variable "monitoring_notification_emails" {
  description = "Email addresses for Cloud Monitoring notification channels."
  type        = list(string)
  default     = []
}

variable "log_sink_destination" {
  description = "Optional fully-qualified log sink destination, for example storage.googleapis.com/my-audit-log-bucket."
  type        = string
  default     = null
}

variable "gpu_worker_enable_gpu" {
  description = "Explicit operator opt-in to allocate one NVIDIA L4 to Ollama. Safe default is false; no image route is activated."
  type        = bool
  default     = false
}

variable "generation_worker_service_name" {
  description = "Separate private Node Cloud Tasks worker service name. Defaults to app-environment-generation-worker."
  type        = string
  default     = null
}

variable "generation_worker_container_image" {
  description = "Existing Node application image for the task worker; null reuses container_image. Production requires a digest."
  type        = string
  default     = null

  validation {
    condition = (
      var.environment != "prod" ||
      startswith(coalesce(var.generation_worker_container_image, var.container_image), "replace-me") ||
      can(regex("@sha256:[a-f0-9]{64}$", coalesce(var.generation_worker_container_image, var.container_image)))
    )
    error_message = "Production generation worker image must be an immutable @sha256 digest unless it is an explicit replace-me placeholder."
  }
}

variable "generation_worker_max_instances" {
  description = "Maximum concurrent Node worker instances; each handles one request."
  type        = number
  default     = 2
}

variable "gpu_worker_runtime" {
  description = "Use ollama normally; legacy-node only for phase one of the documented queue-drain migration."
  type        = string
  default     = "ollama"

  validation {
    condition     = contains(["ollama", "legacy-node"], var.gpu_worker_runtime)
    error_message = "gpu_worker_runtime must be ollama or legacy-node."
  }
}

variable "ollama_audience" {
  description = "Separate Cloud Run custom OIDC audience for Ollama. Not a Cloud Tasks audience or an inference adapter setting."
  type        = string
  default     = ""
}

variable "gpu_worker_legacy_node_port" {
  description = "Existing Node service port during migration only; preserve a non-default deployed port explicitly."
  type        = number
  default     = 8080
}
variable "ollama_image_generation_enabled" {
  description = "Opt in to the fixed-model adapter only after reviewing a compatible image runtime. Live verification is still required."
  type        = bool
  default     = false
}

variable "ollama_service_url" {
  description = "Private Ollama run.app origin from the initial infrastructure apply; explicit input avoids a Node/web/Ollama dependency cycle."
  type        = string
  default     = ""
}

variable "ollama_model_digest" {
  description = "Reviewed x/flux2-klein:4b-fp8 manifest digest; shared by the cache preparer and inference caller."
  type        = string
  default     = "sha256:d968d763271aa912ac5499320d349bf4cb75267d7fbf499203bb8e8f19dde6ef"
  validation {
    condition     = var.ollama_model_digest == "sha256:d968d763271aa912ac5499320d349bf4cb75267d7fbf499203bb8e8f19dde6ef"
    error_message = "Only the reviewed FLUX.2 Klein 4B FP8 snapshot is supported; update all code-owned pins together for a revision change."
  }
}

variable "ollama_model_cache_enabled" {
  description = "Create private regional GCS storage for immutable Ollama model snapshots."
  type        = bool
  default     = true
}

variable "ollama_model_cache_ready" {
  description = "Set after the cache preparation job succeeds; Terraform verifies its marker before mounting."
  type        = bool
  default     = false
}

variable "ollama_model_cache_bucket_name" {
  description = "Optional name of the new Terraform-managed private model cache bucket."
  type        = string
  default     = null
}

variable "ollama_cache_seed_container_image" {
  description = "Image built with workers/gpu/Dockerfile.cache; null leaves the optional seed job uncreated."
  type        = string
  default     = null
  validation {
    condition     = var.ollama_cache_seed_container_image == null || var.environment != "prod" || can(regex("@sha256:[a-f0-9]{64}$", var.ollama_cache_seed_container_image))
    error_message = "The production cache-preparation image must use an immutable digest."
  }
}

