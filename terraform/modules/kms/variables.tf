variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "KMS location."
  type        = string
}

variable "keyring_name" {
  description = "KMS key ring name."
  type        = string
}

variable "crypto_key_name" {
  description = "KMS crypto key name."
  type        = string
}

variable "labels" {
  description = "Labels applied to the crypto key."
  type        = map(string)
  default     = {}
}
