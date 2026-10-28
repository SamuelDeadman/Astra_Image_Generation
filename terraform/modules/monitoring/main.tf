resource "google_logging_metric" "cloud_run_errors" {
  project = var.project_id
  name    = "${var.cloud_run_service_name}-errors"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.cloud_run_service_name}\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Cloud Run errors for ${var.cloud_run_service_name}"

    labels {
      key         = "revision"
      value_type  = "STRING"
      description = "Cloud Run revision that emitted the error."
    }
  }

  label_extractors = {
    revision = "EXTRACT(resource.labels.revision_name)"
  }
}

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.notification_emails)

  project      = var.project_id
  display_name = "AstraFlow ${var.environment} alerts ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }
  user_labels = var.labels
}

resource "google_monitoring_alert_policy" "cloud_run_error_burst" {
  count = length(var.notification_emails) > 0 ? 1 : 0

  project      = var.project_id
  display_name = "AstraFlow ${var.environment} Cloud Run error burst"
  combiner     = "OR"
  enabled      = true
  user_labels  = var.labels

  conditions {
    display_name = "More than five logged errors in five minutes"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cloud_run_errors.name}\" AND resource.type=\"cloud_run_revision\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [for channel in google_monitoring_notification_channel.email : channel.name]

  documentation {
    mime_type = "text/markdown"
    content   = "AstraFlow Cloud Run has emitted more than five error-level logs in five minutes. Check Cloud Run revision logs, MongoDB Atlas connectivity, Secret Manager access, Cloud Tasks dispatch failures, and GCS/KMS permissions."
  }
}

resource "google_logging_project_sink" "platform" {
  count = var.log_sink_destination != null ? 1 : 0

  project                = var.project_id
  name                   = "${var.cloud_run_service_name}-platform-logs"
  destination            = var.log_sink_destination
  filter                 = "resource.type=(\"cloud_run_revision\" OR \"cloud_tasks_queue\" OR \"gcs_bucket\")"
  unique_writer_identity = true
}
