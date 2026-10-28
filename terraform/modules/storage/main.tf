resource "google_storage_bucket" "input_assets" {
  project                     = var.project_id
  name                        = var.bucket_names.input
  location                    = var.region
  force_destroy               = var.force_destroy
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(var.labels, { bucket_role = "input-assets" })

  versioning {
    enabled = false
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      age = var.input_asset_retention_days
    }
  }
}

resource "google_storage_bucket" "output_assets" {
  project                     = var.project_id
  name                        = var.bucket_names.output
  location                    = var.region
  force_destroy               = var.force_destroy
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(var.labels, { bucket_role = "generated-output" })

  versioning {
    enabled = true
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }

    condition {
      age = var.output_asset_nearline_days
    }
  }

  dynamic "retention_policy" {
    for_each = var.output_retention_days > 0 ? [1] : []

    content {
      retention_period = var.output_retention_days * 86400
      is_locked        = false
    }
  }
}

resource "google_storage_bucket" "temp_assets" {
  project                     = var.project_id
  name                        = var.bucket_names.temp
  location                    = var.region
  force_destroy               = var.force_destroy
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = merge(var.labels, { bucket_role = "temp-assets" })

  versioning {
    enabled = false
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      age = var.temp_asset_retention_days
    }
  }
}
