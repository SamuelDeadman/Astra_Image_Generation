import "server-only";

import { nanoid } from "nanoid";
import { notFound, configurationRequired } from "@/server/errors";
import { encryptUserSecret, decryptUserSecret } from "@/server/security/kms";
import { isUserCredentialProvider } from "@/lib/models/catalog";
import { maskSecret } from "@/lib/security/redaction";
import { mongoCollection } from "@/server/db/mongodb";
import { collectionNames, type ApiCredentialDocument, type ProviderDocument } from "@/server/db/types";

export async function listProvidersForUser(ownerId: string) {
  const providersCollection = await mongoCollection<ProviderDocument>(collectionNames.providers);
  const credentialsCollection = await mongoCollection<ApiCredentialDocument>(collectionNames.apiCredentials);
  const providers = await providersCollection.find({ isEnabled: true }).sort({ name: 1 }).toArray();
  const credentials = await credentialsCollection
    .find({
      userId: ownerId,
      deletedAt: { $exists: false }
    })
    .sort({ createdAt: -1 })
    .toArray();

  return {
    providers: providers.filter((provider) => isUserCredentialProvider(provider._id, provider.route)).map((provider) => ({
      id: provider._id,
      name: provider.name,
      route: provider.route,
      credentialSchema: provider.credentialSchema
    })),
    credentials: credentials.filter((credential) => providers.some((provider) => provider._id === credential.provider && isUserCredentialProvider(provider._id, provider.route))).map((credential) => ({
      id: credential._id,
      provider: credential.provider,
      label: credential.label,
      mode: credential.mode,
      maskedSecret: credential.maskedSecret,
      createdAt: credential.createdAt.toISOString(),
      lastUsedAt: credential.lastUsedAt?.toISOString()
    }))
  };
}

export async function storeProviderCredential(input: {
  ownerId: string;
  providerId: string;
  label: string;
  secret: string;
}) {
  const providers = await mongoCollection<ProviderDocument>(collectionNames.providers);
  const credentials = await mongoCollection<ApiCredentialDocument>(collectionNames.apiCredentials);
  const provider = await providers.findOne({
    _id: input.providerId,
    isEnabled: true
  });

  if (!provider || !isUserCredentialProvider(provider._id, provider.route)) {
    throw notFound("Provider is not enabled for BYOK credentials.");
  }

  const encrypted = await encryptUserSecret(input.secret);
  await credentials.updateMany(
    {
      userId: input.ownerId,
      provider: provider._id,
      deletedAt: { $exists: false }
    },
    {
      $set: {
        deletedAt: new Date()
      }
    }
  );

  const credential: ApiCredentialDocument = {
    _id: nanoid(),
    userId: input.ownerId,
    provider: provider._id,
    label: input.label,
    mode: "SAVED_ENCRYPTED",
    encryptedSecret: encrypted.encryptedSecret,
    wrappedDataKey: encrypted.wrappedDataKey,
    kmsKeyVersion: encrypted.kmsKeyVersion,
    maskedSecret: maskSecret(input.secret),
    createdAt: new Date()
  };

  await credentials.insertOne(credential);

  return {
    id: credential._id,
    provider: credential.provider,
    label: credential.label,
    mode: credential.mode,
    maskedSecret: credential.maskedSecret,
    createdAt: credential.createdAt.toISOString()
  };
}

export async function deleteProviderCredential(input: {
  ownerId: string;
  providerId: string;
}) {
  await requireUserCredentialProvider(input.providerId);
  const credentials = await mongoCollection<ApiCredentialDocument>(collectionNames.apiCredentials);
  const result = await credentials.updateMany(
    {
      userId: input.ownerId,
      provider: input.providerId,
      deletedAt: { $exists: false }
    },
    {
      $set: {
        deletedAt: new Date()
      }
    }
  );

  if (result.modifiedCount === 0) {
    throw notFound("Credential not found.");
  }
}

export async function requireUserCredentialProvider(providerId: string) {
  const providers = await mongoCollection<ProviderDocument>(collectionNames.providers);
  const provider = await providers.findOne({ _id: providerId, isEnabled: true });
  if (!provider || !isUserCredentialProvider(provider._id, provider.route)) throw notFound("This provider does not accept user credentials. GCP and Vertex use the application service identity.");
  return provider;
}

export async function hasProviderCredential(ownerId: string, providerId: string) {
  await requireUserCredentialProvider(providerId);
  const credentials = await mongoCollection<ApiCredentialDocument>(collectionNames.apiCredentials);
  return Boolean(await credentials.findOne({ userId: ownerId, provider: providerId, mode: "SAVED_ENCRYPTED", deletedAt: { $exists: false }, encryptedSecret: { $exists: true }, wrappedDataKey: { $exists: true } }));
}

export async function loadUserProviderSecret(ownerId: string, providerId: string) {
  await requireUserCredentialProvider(providerId);
  const credentials = await mongoCollection<ApiCredentialDocument>(collectionNames.apiCredentials);
  const credential = await credentials.findOne({ userId: ownerId, provider: providerId, mode: "SAVED_ENCRYPTED", deletedAt: { $exists: false } });
  if (!credential?.encryptedSecret || !credential.wrappedDataKey) throw configurationRequired("Save your Google AI Studio API key in BYOK Providers before generation.");
  const secret = await decryptUserSecret({ encryptedSecret: credential.encryptedSecret, wrappedDataKey: credential.wrappedDataKey });
  await credentials.updateOne({ _id: credential._id, userId: ownerId, provider: providerId }, { $set: { lastUsedAt: new Date() } });
  return secret;
}
