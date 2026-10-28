import "server-only";

import { nanoid } from "nanoid";
import type { VerifiedGoogleUser } from "@/lib/auth/google";
import { mongoCollection } from "@/server/db/mongodb";
import { collectionNames, type UserDocument } from "@/server/db/types";

export async function upsertGoogleUser(googleUser: VerifiedGoogleUser) {
  const users = await mongoCollection<UserDocument>(collectionNames.users);
  const now = new Date();
  const filter = {
    provider: "google" as const,
    providerUserId: googleUser.providerUserId
  };
  const setFields: Record<string, unknown> = { updatedAt: now };
  const unsetFields: Record<string, ""> = {};

  if (googleUser.email) {
    setFields.email = googleUser.email;
  } else {
    unsetFields.email = "";
  }

  if (googleUser.displayName) {
    setFields.displayName = googleUser.displayName;
  } else {
    unsetFields.displayName = "";
  }

  if (googleUser.picture) {
    setFields.picture = googleUser.picture;
  } else {
    unsetFields.picture = "";
  }

  await users.updateOne(
    filter,
    {
      $set: setFields,
      ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
      $setOnInsert: {
        _id: nanoid(),
        provider: "google",
        providerUserId: googleUser.providerUserId,
        role: "STANDARD",
        isSuspended: false,
        createdAt: now
      }
    },
    { upsert: true }
  );

  const user = await users.findOne(filter);

  if (!user) {
    throw new Error("Google user upsert did not return a user.");
  }

  return {
    ...user,
    id: user._id
  };
}
