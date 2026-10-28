output "network_id" {
  description = "VPC network ID, if created."
  value       = try(google_compute_network.platform[0].id, null)
}

output "subnetwork_id" {
  description = "Serverless subnetwork ID, if created."
  value       = try(google_compute_subnetwork.serverless[0].id, null)
}

output "vpc_connector_id" {
  description = "Serverless VPC Access connector ID, if created."
  value       = try(google_vpc_access_connector.serverless[0].id, null)
}
