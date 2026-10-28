resource "google_cloud_run_v2_service" "worker" {
  project          = var.project_id
  location         = var.region
  name             = var.service_name
  ingress          = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  labels           = var.labels
  custom_audiences = [var.audience]

  deletion_protection = false
  invoker_iam_disabled = false

  lifecycle {
    precondition {
      condition     = (var.direct_vpc_network == null) == (var.direct_vpc_subnetwork == null) && (var.direct_vpc_network == null || var.vpc_connector_id == null)
      error_message = "Provide a Direct VPC network/subnet pair or a connector, never both."
    }
  }

  template {
    service_account                  = var.service_account_email
    timeout                          = "1800s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      # The same standalone Next.js application image; the route and lifecycle are unchanged.
      image = var.container_image

      ports {
        name           = "http1"
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "4"
          memory = "16Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        timeout_seconds   = 2
        period_seconds    = 5
        failure_threshold = 48
        http_get {
          path = "/healthz"
          port = 3000
        }
      }

      liveness_probe {
        timeout_seconds   = 10
        period_seconds    = 30
        failure_threshold = 3
        http_get {
          path = "/healthz"
          port = 3000
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

    dynamic "vpc_access" {
      for_each = var.vpc_connector_id != null || var.direct_vpc_network != null ? [1] : []
      content {
        connector = var.vpc_connector_id
        egress    = var.vpc_egress
        dynamic "network_interfaces" {
          for_each = var.direct_vpc_network != null ? [1] : []
          content {
            network    = var.direct_vpc_network
            subnetwork = var.direct_vpc_subnetwork
          }
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

resource "google_cloud_run_v2_service_iam_member" "task_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.task_invoker_service_account_email}"
}
