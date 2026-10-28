output "error_metric_name" {
  description = "Cloud Logging metric name for Cloud Run errors."
  value       = google_logging_metric.cloud_run_errors.name
}

output "alert_policy_name" {
  description = "Cloud Monitoring alert policy name, if created."
  value       = try(google_monitoring_alert_policy.cloud_run_error_burst[0].name, null)
}

output "notification_channel_names" {
  description = "Notification channel names."
  value       = [for channel in google_monitoring_notification_channel.email : channel.name]
}

output "log_sink_writer_identity" {
  description = "Writer identity for optional log sink. Grant this identity write access to the destination."
  value       = try(google_logging_project_sink.platform[0].writer_identity, null)
}
