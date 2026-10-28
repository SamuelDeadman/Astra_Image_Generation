resource "google_cloud_run_v2_service" "worker" {
  provider = google-beta

  project          = var.project_id
  location         = var.region
  name             = var.service_name
  ingress          = var.ingress
  labels           = var.labels
  custom_audiences = [var.audience]

  deletion_protection = false
  invoker_iam_disabled = false
  launch_stage        = var.enable_gpu ? "BETA" : "GA"

  lifecycle {
    precondition {
      condition     = var.model_cache_bucket == null || var.model_cache_verified
      error_message = "Mount only a completed, verified model-cache snapshot."
    }
    precondition {
      condition     = var.legacy_node_enabled || var.audience != var.task_audience
      error_message = "Ollama and Cloud Tasks must use different OIDC audiences."
    }
    precondition {
      condition     = !var.enable_gpu || (tonumber(var.cpu) >= 4 && try(tonumber(trimsuffix(var.memory, "Gi")) >= 16, false))
      error_message = "NVIDIA L4 requires at least 4 CPU and 16Gi memory (specify memory in Gi)."
    }
  }

  template {
    service_account                  = var.service_account_email
    timeout                          = "${var.timeout_seconds}s"
    max_instance_request_concurrency = var.max_instance_request_concurrency
    gpu_zonal_redundancy_disabled    = var.enable_gpu ? var.gpu_zonal_redundancy_disabled : null

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    dynamic "node_selector" {
      for_each = var.enable_gpu ? [1] : []
      content {
        accelerator = "nvidia-l4"
      }
    }

    containers {
      image = var.container_image
      dynamic "volume_mounts" {
        for_each = var.model_cache_bucket != null ? [1] : []
        content {
          name       = "ollama-models"
          mount_path = "/models"
        }
      }

      ports {
        name           = "http1"
        container_port = var.container_port
      }

      resources {
        limits = merge({
          cpu    = var.cpu
          memory = var.memory
        }, var.enable_gpu ? { "nvidia.com/gpu" = tostring(var.gpu_count) } : {})
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 2
        period_seconds        = 5
        failure_threshold     = 48

        http_get {
          path = var.health_path
          port = var.container_port
        }
      }

      liveness_probe {
        timeout_seconds   = 10
        period_seconds    = 30
        failure_threshold = 3

        http_get {
          path = var.health_path
          port = var.container_port
        }
      }

      dynamic "env" {
        for_each = var.environment_variables

        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_environment_variables

        content {
          name = env.key

          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = env.value.version
            }
          }
        }
      }
    }

    dynamic "volumes" {
      for_each = var.model_cache_bucket != null ? [1] : []
      content {
        name = "ollama-models"
        gcs {
          bucket        = var.model_cache_bucket
          read_only     = true
          mount_options = ["only-dir=${var.model_cache_prefix}", "implicit-dirs", "file-cache:max-size-mb=0", "stat-cache-max-size-mb=32", "type-cache-max-size-mb=8"]
        }
      }
    }

    dynamic "vpc_access" {
      for_each = var.vpc_connector_id != null ? [var.vpc_connector_id] : []

      content {
        connector = vpc_access.value
        egress    = var.vpc_egress
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

resource "google_cloud_run_v2_service_iam_member" "task_invoker" {
  # Retained only during migration while this service still serves the Node task route.
  count = var.legacy_node_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.task_invoker_service_account_email}"
}

moved {
  from = google_cloud_run_v2_service_iam_member.task_invoker
  to   = google_cloud_run_v2_service_iam_member.task_invoker[0]
}
