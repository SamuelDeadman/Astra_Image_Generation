resource "google_cloud_tasks_queue" "generation" {
  project  = var.project_id
  location = var.region
  name     = var.queue_name

  rate_limits {
    max_dispatches_per_second = var.max_dispatches_per_second
    max_concurrent_dispatches = var.max_concurrent_dispatches
  }

  retry_config {
    max_attempts       = var.max_attempts
    min_backoff        = "10s"
    max_backoff        = "600s"
    max_doublings      = 5
    max_retry_duration = "3600s"
  }

  stackdriver_logging_config {
    sampling_ratio = 1.0
  }
}
