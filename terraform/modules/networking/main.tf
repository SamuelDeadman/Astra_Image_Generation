resource "google_compute_network" "platform" {
  count = var.create_vpc_connector ? 1 : 0

  project                 = var.project_id
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  description             = "Private platform network for serverless egress."
}

resource "google_compute_subnetwork" "serverless" {
  count = var.create_vpc_connector ? 1 : 0

  project                  = var.project_id
  region                   = var.region
  name                     = "${var.name_prefix}-serverless"
  ip_cidr_range            = "10.20.0.0/24"
  network                  = google_compute_network.platform[0].id
  private_ip_google_access = true
  description              = "Subnet reserved for serverless platform egress."
}

resource "google_vpc_access_connector" "serverless" {
  count = var.create_vpc_connector ? 1 : 0

  project       = var.project_id
  region        = var.region
  name          = "${var.name_prefix}-connector"
  network       = google_compute_network.platform[0].name
  ip_cidr_range = var.connector_cidr_range
  min_instances = 2
  max_instances = 10
  machine_type  = "e2-micro"

  depends_on = [google_compute_subnetwork.serverless]
}
resource "google_compute_router" "serverless" {
  count   = var.create_vpc_connector && var.enable_cloud_nat ? 1 : 0
  project = var.project_id
  region  = var.region
  name    = "${var.name_prefix}-router"
  network = google_compute_network.platform[0].id
}

resource "google_compute_router_nat" "serverless" {
  count                              = var.create_vpc_connector && var.enable_cloud_nat ? 1 : 0
  project                            = var.project_id
  region                             = var.region
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.serverless[0].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

