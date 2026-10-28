variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Primary region."
  type        = string
}

variable "labels" {
  description = "Labels applied to supported resources."
  type        = map(string)
  default     = {}
}

variable "enable_project_services" {
  description = "Whether to enable required Google Cloud APIs."
  type        = bool
}

variable "disable_services_on_destroy" {
  description = "Whether Terraform should disable managed services on destroy."
  type        = bool
}

variable "required_services" {
  description = "Google Cloud APIs required by the platform."
  type        = list(string)
}

variable "artifact_registry_repository_id" {
  description = "Artifact Registry repository ID."
  type        = string
}

variable "artifact_registry_format" {
  description = "Artifact Registry repository format."
  type        = string
}
