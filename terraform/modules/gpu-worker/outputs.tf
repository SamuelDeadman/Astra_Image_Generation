output "service_name" {
  description = "GPU worker Cloud Run service name."
  value       = google_cloud_run_v2_service.worker.name
}

output "service_id" {
  description = "GPU worker Cloud Run service resource ID."
  value       = google_cloud_run_v2_service.worker.id
}

output "service_url" {
  description = "GPU worker Cloud Run service URL."
  value       = google_cloud_run_v2_service.worker.uri
}

output "service_account_email" {
  description = "Worker runtime service account email."
  value       = var.service_account_email
}

output "deployment" {
  description = "Worker deployment shape."
  value = {
    image                            = var.container_image
    runtime                          = var.legacy_node_enabled ? "legacy-node" : "ollama"
    accelerator                      = var.enable_gpu ? "nvidia-l4" : null
    gpu_count                        = var.enable_gpu ? var.gpu_count : 0
    container_port                   = var.container_port
    health_path                      = var.health_path
    cpu                              = var.cpu
    memory                           = var.memory
    min_instance_count               = 0
    max_instance_count               = var.max_instances
    max_instance_request_concurrency = var.max_instance_request_concurrency
    timeout_seconds                  = var.timeout_seconds
  }
}
