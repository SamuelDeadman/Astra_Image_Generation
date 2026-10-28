variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Bucket location. Use a region for latency-sensitive signed URL workflows."
  type        = string
}

variable "labels" {
  description = "Labels applied to buckets."
  type        = map(string)
  default     = {}
}

variable "bucket_names" {
  description = "Globally unique bucket names for input, output, and temp assets."
  type = object({
    input  = string
    output = string
    temp   = string
  })
}

variable "force_destroy" {
  description = "Allow Terraform to delete non-empty buckets."
  type        = bool
  default     = false
}

variable "input_asset_retention_days" {
  description = "Delete uploaded input/reference assets after this many days."
  type        = number
}

variable "output_asset_nearline_days" {
  description = "Transition generated outputs to NEARLINE after this many days."
  type        = number
}

variable "temp_asset_retention_days" {
  description = "Delete temporary assets after this many days."
  type        = number
}

variable "output_retention_days" {
  description = "Optional retention policy for generated output bucket. Set 0 to disable."
  type        = number
}
