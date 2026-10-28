import "server-only";

import crypto from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { configurationRequired } from "@/server/errors";
import { missingEnv, requiredEnv } from "@/server/env";

let kmsClient: KeyManagementServiceClient | undefined;

function getKmsClient() {
  kmsClient ??= new KeyManagementServiceClient();
  return kmsClient;
}

export function assertKmsConfigured() {
  const missing = missingEnv(["KMS_KEY_RESOURCE"]);

  if (missing.length > 0) {
    throw configurationRequired("Cloud KMS is not configured for credential encryption.", { missing });
  }
}

export async function encryptUserSecret(secret: string) {
  assertKmsConfigured();

  const keyName = requiredEnv("KMS_KEY_RESOURCE");
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const [wrapped] = await getKmsClient().encrypt({
    name: keyName,
    plaintext: dataKey
  });

  if (!wrapped.ciphertext) {
    throw configurationRequired("Cloud KMS did not return an encrypted data key.");
  }

  return {
    encryptedSecret: Buffer.from(
      JSON.stringify({
        version: 1,
        algorithm: "AES-256-GCM",
        iv: iv.toString("base64url"),
        tag: tag.toString("base64url"),
        ciphertext: ciphertext.toString("base64url")
      })
    ),
    wrappedDataKey: Buffer.from(wrapped.ciphertext as Uint8Array),
    kmsKeyVersion: keyName
  };
}

export async function decryptUserSecret(input: {
  encryptedSecret: Buffer;
  wrappedDataKey: Buffer;
}) {
  assertKmsConfigured();

  const keyName = requiredEnv("KMS_KEY_RESOURCE");
  const [unwrapped] = await getKmsClient().decrypt({
    name: keyName,
    ciphertext: input.wrappedDataKey
  });

  if (!unwrapped.plaintext) {
    throw configurationRequired("Cloud KMS did not return a decrypted data key.");
  }

  const envelope = JSON.parse(input.encryptedSecret.toString("utf8")) as {
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(unwrapped.plaintext as Uint8Array),
    Buffer.from(envelope.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
