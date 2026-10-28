variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for Secret Manager secret IDs."
  type        = string
}

variable "labels" {
  description = "Labels applied to secrets."
  type        = map(string)
  default     = {}
}

variable "create_secret_versions" {
  description = "Whether Terraform should create secret versions from supplied/generated values."
  type        = bool
}

variable "session_secret_value" {
  description = "Optional explicit SESSION_SECRET value. Supplying this stores the value in Terraform state."
  type        = string
  default     = null
  sensitive   = true
}

variable "generate_session_secret" {
  description = "Generate SESSION_SECRET when session_secret_value is null."
  type        = bool
}

variable "mongodb_atlas_uri" {
  description = "MongoDB Atlas URI. Atlas is external; supplying this stores the value in Terraform state."
  type        = string
  default     = null
  sensitive   = true
}

variable "google_oauth_client_secret" {
  description = "Optional Google OAuth client secret. Supplying this stores the value in Terraform state."
  type        = string
  default     = null
  sensitive   = true
}

variable "additional_runtime_secret_ids" {
  description = "Additional Secret Manager secret IDs to create without versions."
  type        = list(string)
  default     = []
}
