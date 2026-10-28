output "service_name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.web.name
}

output "service_id" {
  description = "Cloud Run service resource ID."
  value       = google_cloud_run_v2_service.web.id
}

output "service_url" {
  description = "Cloud Run service URL."
  value       = google_cloud_run_v2_service.web.uri
}

output "custom_domain_status" {
  description = "Custom domain mapping status, if configured."
  value       = try(google_cloud_run_domain_mapping.custom_domain[0].status, null)
}
