variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
}

variable "service_name" {
  description = "Private Cloud Run GPU worker service name."
  type        = string
}

variable "labels" {
  description = "Labels applied to worker resources."
  type        = map(string)
  default     = {}
}

variable "container_image" {
  description = "Ollama image reference; development uses ollama/ollama:latest, production uses its tested immutable digest."
  type        = string
}

variable "service_account_email" {
  description = "Isolated Ollama runtime identity (legacy Node worker identity only during migration)."
  type        = string
}

variable "task_invoker_service_account_email" {
  description = "Cloud Tasks OIDC invoker service account email."
  type        = string
}

variable "environment_variables" {
  description = "Plaintext runtime environment variables. Do not put secrets here."
  type        = map(string)
  default     = {}
}

variable "secret_environment_variables" {
  description = "Secret-backed environment variables keyed by env var name."
  type = map(object({
    secret_id = string
    version   = string
  }))
  default = {}
}

variable "ingress" {
  description = "Private worker ingress policy."
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = var.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY"
    error_message = "The Ollama service must retain internal-only ingress."
  }
}

variable "container_port" {
  description = "Worker container HTTP port."
  type        = number
  default     = 11434
}

variable "cpu" {
  description = "Worker CPU limit. NVIDIA L4 requires at least 4 CPU."
  type        = string
  default     = "4"
}

variable "memory" {
  description = "Worker memory limit. NVIDIA L4 requires at least 16Gi."
  type        = string
  default     = "16Gi"
}

variable "gpu_count" {
  description = "Number of NVIDIA L4 GPUs per worker instance."
  type        = number
  default     = 1

  validation {
    condition     = var.gpu_count == 1
    error_message = "The initial worker supports exactly one NVIDIA L4 GPU per Cloud Run instance."
  }
}

variable "max_instances" {
  description = "Maximum GPU worker instances. Keep this at or below regional GPU quota."
  type        = number
  default     = 2

  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 10
    error_message = "max_instances must be between 1 and 10 for the initial GPU worker."
  }
}

variable "timeout_seconds" {
  description = "Worker request timeout in seconds."
  type        = number
  default     = 1800

  validation {
    condition     = var.timeout_seconds >= 300 && var.timeout_seconds <= 3600
    error_message = "timeout_seconds must be between 300 and 3600."
  }
}

variable "max_instance_request_concurrency" {
  description = "Maximum active requests per GPU worker instance."
  type        = number
  default     = 1

  validation {
    condition     = var.max_instance_request_concurrency == 1
    error_message = "The initial GPU worker must run one active request per instance."
  }
}

variable "gpu_zonal_redundancy_disabled" {
  description = "Disable GPU zonal redundancy. This requires the applicable non-redundant GPU quota."
  type        = bool
  default     = true
}

variable "vpc_connector_id" {
  description = "Optional Serverless VPC Access connector ID."
  type        = string
  default     = null
}

variable "vpc_egress" {
  description = "VPC egress mode when vpc_connector_id is set."
  type        = string
  default     = "PRIVATE_RANGES_ONLY"
}

variable "health_path" {
  description = "HTTP liveness path exposed by the worker image."
  type        = string
  default     = "/api/version"
}

variable "enable_gpu" {
  description = "Explicit operator opt-in to allocate one NVIDIA L4 to Ollama. Does not enable AstraFlow image inference."
  type        = bool
  default     = false
}

variable "audience" {
  description = "Registered Cloud Run custom audience; distinct from the task audience in Ollama mode."
  type        = string
}

variable "legacy_node_enabled" {
  description = "Temporary migration mode: retain Cloud Tasks invocation until old deliveries have drained."
  type        = bool
  default     = false
}

variable "task_audience" {
  description = "Cloud Tasks audience, used only to prevent accidental reuse for Ollama."
  type        = string
}
variable "model_cache_bucket" {
  description = "Private verified GCS snapshot; mounted read-only."
  type        = string
  default     = null
}

variable "model_cache_prefix" {
  description = "Content-addressed snapshot directory in the model bucket."
  type        = string
  default     = ""
}

variable "model_cache_verified" {
  description = "The fixed model/digest/version marker has been read and verified by the root module."
  type        = bool
  default     = false
}

