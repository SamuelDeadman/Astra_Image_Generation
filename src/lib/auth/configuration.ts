export function googleClientIdIssue(clientId?: string) {
  if (!clientId?.trim()) return "Set GOOGLE_CLIENT_ID at runtime; Terraform environments use the next_public_google_client_id input for this value.";
  if (!/^\S+\.apps\.googleusercontent\.com$/.test(clientId.trim())) return "Configure a valid Google OAuth Web application client ID.";
  return null;
}

export function googleConfigurationIssue(serverClientId?: string, browserClientId?: string) {
  const issue = googleClientIdIssue(serverClientId);
  if (issue) return issue;
  if (browserClientId?.trim() && serverClientId?.trim() !== browserClientId.trim()) {
    return "The Google sign-in client ID does not match the server configuration. Refresh the page and check the deployment setting.";
  }
  return null;
}
