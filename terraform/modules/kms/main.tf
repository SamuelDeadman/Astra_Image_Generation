resource "google_kms_key_ring" "platform" {
  project  = var.project_id
  name     = var.keyring_name
  location = var.region
}

resource "google_kms_crypto_key" "credential_envelope" {
  name                       = var.crypto_key_name
  key_ring                   = google_kms_key_ring.platform.id
  purpose                    = "ENCRYPT_DECRYPT"
  rotation_period            = "7776000s"
  destroy_scheduled_duration = "2592000s"
  labels                     = var.labels

  lifecycle {
    prevent_destroy = true
  }
}
