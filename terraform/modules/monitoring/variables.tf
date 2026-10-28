variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "environment" {
  description = "Environment name."
  type        = string
}

variable "labels" {
  description = "Labels/user labels for monitoring resources."
  type        = map(string)
  default     = {}
}

variable "cloud_run_service_name" {
  description = "Cloud Run service name to monitor."
  type        = string
}

variable "notification_emails" {
  description = "Email addresses for alert notifications."
  type        = list(string)
  default     = []
}

variable "log_sink_destination" {
  description = "Optional log sink destination such as storage.googleapis.com/bucket-name."
  type        = string
  default     = null
}
