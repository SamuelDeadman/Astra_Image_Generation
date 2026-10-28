variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
}

variable "labels" {
  description = "Labels applied to Cloud Run resources."
  type        = map(string)
  default     = {}
}

variable "container_image" {
  description = "Container image reference."
  type        = string
}

variable "service_account_email" {
  description = "Runtime service account email."
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
  description = "Cloud Run ingress policy."
  type        = string
}

variable "allow_unauthenticated" {
  description = "Whether allUsers may invoke the service."
  type        = bool
}

variable "cpu" {
  description = "CPU limit."
  type        = string
}

variable "memory" {
  description = "Memory limit."
  type        = string
}

variable "min_instances" {
  description = "Minimum instances."
  type        = number
}

variable "max_instances" {
  description = "Maximum instances."
  type        = number
}

variable "timeout_seconds" {
  description = "Request timeout in seconds."
  type        = number
}

variable "vpc_connector_id" {
  description = "Optional Serverless VPC Access connector ID."
  type        = string
  default     = null
}

variable "custom_domain" {
  description = "Optional custom domain for Cloud Run. Requires external domain verification and DNS."
  type        = string
  default     = null
}
