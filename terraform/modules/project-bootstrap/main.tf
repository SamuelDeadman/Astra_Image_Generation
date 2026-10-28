data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_service" "required" {
  for_each = var.enable_project_services ? toset(var.required_services) : toset([])

  project                    = var.project_id
  service                    = each.key
  disable_dependent_services = false
  disable_on_destroy         = var.disable_services_on_destroy
}

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_repository_id
  description   = "Container images for the AstraFlow image generation platform."
  format        = var.artifact_registry_format
  labels        = var.labels

  depends_on = [google_project_service.required]
}
