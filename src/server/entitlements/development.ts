import "server-only";

import { AppError } from "@/server/errors";

export type EntitlementEnvironment = NodeJS.ProcessEnv;

const nonProductionEnvironments = new Set(["development", "dev", "local", "test"]);

export function deploymentEnvironment(env: EntitlementEnvironment = process.env) {
  return (env.ASTRAFLOW_DEPLOYMENT_ENVIRONMENT ?? env.DEPLOYMENT_ENVIRONMENT ?? env.ENVIRONMENT ?? env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
}

export function isNonProductionEnvironment(env: EntitlementEnvironment = process.env) {
  return nonProductionEnvironments.has(deploymentEnvironment(env));
}

export function isDevelopmentUnlimitedBalanceEnabled(env: EntitlementEnvironment = process.env) {
  return env.DEVELOPMENT_UNLIMITED_BALANCE === "true";
}

export function assertDevelopmentUnlimitedBalanceGuard(env: EntitlementEnvironment = process.env) {
  if (!isDevelopmentUnlimitedBalanceEnabled(env)) {
    return;
  }

  const nodeEnv = (env.NODE_ENV ?? "development").toLowerCase();

  if (nodeEnv === "production" || !isNonProductionEnvironment(env)) {
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "DEVELOPMENT_UNLIMITED_BALANCE can only be enabled in local, dev, or test environments.",
      503,
      {
        nodeEnv,
        deploymentEnvironment: deploymentEnvironment(env)
      }
    );
  }
}

export function getGenerationEntitlement(env: EntitlementEnvironment = process.env) {
  assertDevelopmentUnlimitedBalanceGuard(env);

  if (isDevelopmentUnlimitedBalanceEnabled(env)) {
    return {
      unlimitedDevelopment: true,
      reservedCredits: 0,
      actualCredits: 0,
      monetaryChargeCents: 0
    };
  }

  return {
    unlimitedDevelopment: false,
    monetaryChargeCents: undefined
  };
}
