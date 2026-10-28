output "app_runtime_service_account_email" {
  description = "Cloud Run web app runtime service account email."
  value       = google_service_account.app_runtime.email
}

output "task_invoker_service_account_email" {
  description = "Cloud Tasks OIDC invoker service account email."
  value       = google_service_account.task_invoker.email
}

output "worker_runtime_service_account_email" {
  description = "Worker runtime service account email."
  value       = google_service_account.worker_runtime.email
}

output "app_runtime_service_account_id" {
  description = "Cloud Run web app runtime service account resource ID."
  value       = google_service_account.app_runtime.id
}

output "task_invoker_service_account_id" {
  description = "Cloud Tasks OIDC invoker service account resource ID."
  value       = google_service_account.task_invoker.id
}

output "worker_runtime_service_account_id" {
  description = "Worker runtime service account resource ID."
  value       = google_service_account.worker_runtime.id
}
