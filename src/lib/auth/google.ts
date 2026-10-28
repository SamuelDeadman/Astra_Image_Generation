import { OAuth2Client } from "google-auth-library";
import { googleClientIdIssue } from "./configuration";

export type VerifiedGoogleUser = {
  provider: "google";
  providerUserId: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  picture?: string;
};

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

let client: OAuth2Client | undefined;

function getClient() {
  const audience = process.env.GOOGLE_CLIENT_ID?.trim();
  const issue = googleClientIdIssue(audience);

  if (issue || !audience) {
    throw new AuthConfigurationError(issue ?? "GOOGLE_CLIENT_ID is not configured.");
  }

  client ??= new OAuth2Client(audience);
  return { client, audience };
}

export async function verifyGoogleIdentityCredential(credential: string): Promise<VerifiedGoogleUser> {
  const { client: oauthClient, audience } = getClient();
  const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience }).catch(() => {
    // Never propagate library errors: they may contain the raw ID token.
    throw new GoogleIdentityError();
  });

  const payload = ticket.getPayload();
  const subject = payload?.sub;

  if (!subject) {
    throw new GoogleIdentityError();
  }

  return {
    provider: "google",
    providerUserId: subject,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    displayName: payload.name,
    picture: payload.picture
  };
}

export class GoogleIdentityError extends Error {
  constructor() {
    super("Google could not verify this sign-in. Retry; if it persists, check the matching client IDs and the Google OAuth Web client's Authorized JavaScript origins.");
  }
}
