variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Primary region."
  type        = string
}

variable "name_prefix" {
  description = "Resource naming prefix."
  type        = string
}

variable "labels" {
  description = "Labels applied to supported resources."
  type        = map(string)
  default     = {}
}

variable "create_vpc_connector" {
  description = "Whether to create a Serverless VPC Access connector."
  type        = bool
  default     = false
}

variable "connector_cidr_range" {
  description = "CIDR range for Serverless VPC Access connector."
  type        = string
}
variable "enable_cloud_nat" {
  description = "Provide internet egress when the image worker uses ALL_TRAFFIC (including Atlas)."
  type        = bool
  default     = false
}

