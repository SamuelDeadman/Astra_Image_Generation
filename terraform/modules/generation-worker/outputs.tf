output "service_name" {
  description = "Node worker service name."
  value       = google_cloud_run_v2_service.worker.name
}

output "service_url" {
  description = "Private Node worker URL."
  value       = google_cloud_run_v2_service.worker.uri
}

output "worker_endpoint" {
  description = "Strict Cloud Tasks generation lifecycle endpoint."
  value       = "${google_cloud_run_v2_service.worker.uri}/api/internal/generation-worker"
  # Producers must wait for invocation permission as well as the ready service.
  depends_on = [google_cloud_run_v2_service_iam_member.task_invoker]
}
