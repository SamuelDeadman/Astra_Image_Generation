variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Cloud Tasks queue location."
  type        = string
}

variable "queue_name" {
  description = "Cloud Tasks queue name."
  type        = string
}

variable "max_dispatches_per_second" {
  description = "Maximum task dispatches per second."
  type        = number
}

variable "max_concurrent_dispatches" {
  description = "Maximum concurrent dispatched tasks."
  type        = number
}

variable "max_attempts" {
  description = "Maximum retry attempts per task."
  type        = number
}

variable "labels" {
  description = "Reserved for interface consistency; Cloud Tasks queues do not support labels."
  type        = map(string)
  default     = {}
}
