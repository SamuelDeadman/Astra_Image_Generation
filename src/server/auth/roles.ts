import "server-only";

import type { UserRole } from "@/server/db/types";
import { forbidden } from "@/server/errors";

export type AppRole = "standard" | "professional" | "administrator" | "model-manager" | "suspended";

export function mapRole(role: UserRole): AppRole {
  switch (role) {
    case "PROFESSIONAL":
      return "professional";
    case "ADMINISTRATOR":
      return "administrator";
    case "MODEL_MANAGER":
      return "model-manager";
    case "SUSPENDED":
      return "suspended";
    default:
      return "standard";
  }
}

export function assertNotSuspended(role: AppRole) {
  if (role === "suspended") {
    throw forbidden("This account is suspended.");
  }
}

export function assertRole(role: AppRole, allowed: AppRole[]) {
  if (!allowed.includes(role)) {
    throw forbidden("This account does not have permission for that operation.");
  }
}
