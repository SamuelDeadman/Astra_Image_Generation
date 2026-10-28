locals {
  ollama_cache_bucket_name = coalesce(var.ollama_model_cache_bucket_name, "${local.name_prefix}-${local.normalized_project_id}-ollama-models")
  ollama_cache_prefix      = "ollama/${replace(var.ollama_model_digest, ":", "-")}"
  ollama_cache_seed_enabled = var.ollama_model_cache_enabled && var.ollama_cache_seed_container_image != null
  ollama_cache_verified = var.ollama_model_cache_enabled && var.ollama_model_cache_ready && try(
    jsondecode(data.google_storage_bucket_object_content.ollama_cache_ready[0].content).version == 1 &&
    jsondecode(data.google_storage_bucket_object_content.ollama_cache_ready[0].content).manifest_digest == var.ollama_model_digest &&
    jsondecode(data.google_storage_bucket_object_content.ollama_cache_ready[0].content).model == "x/flux2-klein:4b-fp8",
    false
  )
}

resource "google_storage_bucket" "ollama_models" {
  count                       = var.ollama_model_cache_enabled ? 1 : 0
  project                     = var.project_id
  name                        = local.ollama_cache_bucket_name
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.common_labels

  versioning {
    enabled = true
  }

  depends_on = [module.project_bootstrap]
}

resource "google_service_account" "ollama_cache_seed" {
  count        = local.ollama_cache_seed_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "${local.name_prefix}-cache-seed"
  display_name = "Prepare the immutable Ollama model cache"
  depends_on   = [module.project_bootstrap]
}

resource "google_storage_bucket_iam_member" "ollama_model_reader" {
  count  = var.ollama_model_cache_enabled ? 1 : 0
  bucket = google_storage_bucket.ollama_models[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.ollama_runtime.email}"
}

resource "google_storage_bucket_iam_member" "cache_seed_reader" {
  count  = local.ollama_cache_seed_enabled ? 1 : 0
  bucket = google_storage_bucket.ollama_models[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.ollama_cache_seed[0].email}"
}

resource "google_storage_bucket_iam_member" "cache_seed_creator" {
  count  = local.ollama_cache_seed_enabled ? 1 : 0
  bucket = google_storage_bucket.ollama_models[0].name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.ollama_cache_seed[0].email}"
}

# Created during initial infrastructure deployment; explicitly executed by the preparation
# script/pipeline before activating image inference. Never downloads weights during a plan.
resource "google_cloud_run_v2_job" "ollama_cache_seed" {
  count               = local.ollama_cache_seed_enabled ? 1 : 0
  project             = var.project_id
  name                = "${local.name_prefix}-ollama-cache-seed"
  location            = var.region
  deletion_protection = false
  labels              = local.common_labels

  template {
    parallelism = 1
    task_count  = 1
    template {
      service_account = google_service_account.ollama_cache_seed[0].email
      timeout         = "7200s"
      max_retries     = 1
      containers {
        image = var.ollama_cache_seed_container_image
        resources {
          limits = { cpu = "2", memory = "8Gi" }
        }
        env {
          name  = "CACHE_BUCKET"
          value = google_storage_bucket.ollama_models[0].name
        }
        env {
          name  = "CACHE_PREFIX"
          value = local.ollama_cache_prefix
        }
        env {
          name  = "MODEL_DIGEST"
          value = var.ollama_model_digest
        }
      }
    }
  }

  depends_on = [google_storage_bucket_iam_member.cache_seed_reader, google_storage_bucket_iam_member.cache_seed_creator]
}

# A readiness flag alone cannot activate an empty bucket: the verified marker must exist.
data "google_storage_bucket_object_content" "ollama_cache_ready" {
  count  = var.ollama_model_cache_enabled && var.ollama_model_cache_ready ? 1 : 0
  bucket = google_storage_bucket.ollama_models[0].name
  name   = "${local.ollama_cache_prefix}/READY.json"
}

output "ollama_model_cache" {
  description = "Private durable model storage and the CPU-only preparation job."
  value = {
    bucket   = var.ollama_model_cache_enabled ? google_storage_bucket.ollama_models[0].name : null
    prefix   = local.ollama_cache_prefix
    ready    = local.ollama_cache_verified
    seed_job = local.ollama_cache_seed_enabled ? google_cloud_run_v2_job.ollama_cache_seed[0].name : null
  }
}
