variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Cloud Run region (same project as Cloud Tasks for internal ingress)."
  type        = string
}

variable "service_name" {
  description = "Private Node generation worker service name."
  type        = string
}

variable "labels" {
  description = "Resource labels."
  type        = map(string)
  default     = {}
}

variable "container_image" {
  description = "Existing AstraFlow Node application image implementing the task route."
  type        = string
}

variable "service_account_email" {
  description = "Existing worker runtime identity with provider/storage/KMS permissions."
  type        = string
}

variable "task_invoker_service_account_email" {
  description = "Dedicated Cloud Tasks OIDC identity."
  type        = string
}

variable "audience" {
  description = "Cloud Tasks OIDC audience registered with Cloud Run and checked by Node."
  type        = string
}

variable "environment_variables" {
  description = "Node worker runtime configuration."
  type        = map(string)
}

variable "secret_environment_variables" {
  description = "Worker-only secret references (MongoDB)."
  type = map(object({
    secret_id = string
    version   = string
  }))
}

variable "max_instances" {
  description = "Maximum Node worker instances."
  type        = number
  default     = 2

  validation {
    condition     = var.max_instances >= 1 && var.max_instances == floor(var.max_instances)
    error_message = "max_instances must be a positive integer."
  }
}

variable "vpc_connector_id" {
  description = "Optional Serverless VPC Access connector for existing Atlas connectivity."
  type        = string
  default     = null
}
variable "direct_vpc_network" {
  description = "Optional Direct VPC egress network; use its Private Google Access subnet for internal Cloud Run."
  type        = string
  default     = null
}

variable "direct_vpc_subnetwork" {
  description = "Subnet with Private Google Access for the Direct VPC caller."
  type        = string
  default     = null
}

variable "vpc_egress" {
  description = "ALL_TRAFFIC is required for the Node caller to reach internal Ollama through the VPC."
  type        = string
  default     = "PRIVATE_RANGES_ONLY"
  validation {
    condition     = contains(["PRIVATE_RANGES_ONLY", "ALL_TRAFFIC"], var.vpc_egress)
    error_message = "Unsupported VPC egress mode."
  }
}

