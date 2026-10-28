import { MongoError, MongoParseError, MongoServerError } from "mongodb";
import { configurationRequired } from "@/server/errors";

export function mongoFailure(error: unknown) {
  if (!(error instanceof MongoError)) return null;
  if (error instanceof MongoParseError) return configurationRequired("MONGODB_URI is invalid. Configure a valid MongoDB connection string on the server.");
  if (error instanceof MongoServerError && [13, 18].includes(Number(error.code))) return configurationRequired("MongoDB access was denied. Check MONGODB_URI credentials and database user permissions.");
  if (error instanceof MongoServerError && error.code === 121) return configurationRequired("MongoDB rejected a record against its schema. Run the controlled /ready schema setup before seeding or signing in.");
  if (error instanceof MongoServerError && error.code === 20) return configurationRequired("Generation requires MongoDB Atlas or a replica set with transaction support.");
  return configurationRequired("MongoDB is unavailable. Check MONGODB_URI, Atlas network access and database permissions, then retry.");
}

export function safeErrorMetadata(error: unknown) {
  // Avoid driver messages, stacks, request bodies and URLs, which may contain secrets.
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    code: error instanceof MongoServerError && typeof error.code === "number" ? error.code : undefined,
    codeName: error instanceof MongoServerError ? error.codeName : undefined
  };
}

export function safeMongoServerMessage(error: unknown) {
  if (!(error instanceof MongoServerError)) return undefined;

  return error.message
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[REDACTED_MONGODB_URI]")
    .replace(/\b(password|passwd|pwd)\s*[:=]\s*(['"]?)[^,\s'"}]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}
