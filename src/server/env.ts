import "server-only";

import { configurationRequired } from "@/server/errors";

export function optionalEnv(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

export function requiredEnv(name: string) {
  const value = optionalEnv(name);

  if (!value) {
    throw configurationRequired(`${name} is not configured.`, { variable: name });
  }

  return value;
}

export function hasRequiredEnv(names: string[]) {
  return names.every((name) => Boolean(optionalEnv(name)));
}

export function missingEnv(names: string[]) {
  return names.filter((name) => !optionalEnv(name));
}
