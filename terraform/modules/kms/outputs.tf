output "keyring_id" {
  description = "KMS key ring ID."
  value       = google_kms_key_ring.platform.id
}

output "keyring_name" {
  description = "KMS key ring name."
  value       = google_kms_key_ring.platform.name
}

output "crypto_key_id" {
  description = "KMS crypto key resource ID."
  value       = google_kms_crypto_key.credential_envelope.id
}

output "crypto_key_name" {
  description = "KMS crypto key name."
  value       = google_kms_crypto_key.credential_envelope.name
}
