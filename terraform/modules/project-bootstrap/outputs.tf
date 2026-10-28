output "project_number" {
  description = "Numeric GCP project number."
  value       = data.google_project.current.number
}

output "enabled_services" {
  description = "Services managed by this module."
  value       = keys(google_project_service.required)
}

output "artifact_registry_repository_id" {
  description = "Artifact Registry repository resource ID."
  value       = google_artifact_registry_repository.images.id
}

output "artifact_registry_repository_short_id" {
  description = "Artifact Registry repository short ID."
  value       = google_artifact_registry_repository.images.repository_id
}

output "artifact_registry_repository_name" {
  description = "Artifact Registry repository short name."
  value       = google_artifact_registry_repository.images.name
}

output "artifact_registry_location" {
  description = "Artifact Registry repository region."
  value       = google_artifact_registry_repository.images.location
}
