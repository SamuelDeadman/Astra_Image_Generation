import "server-only";

import {
  MongoClient,
  ServerApiVersion,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type MongoClientOptions
} from "mongodb";
import { optionalEnv, requiredEnv } from "@/server/env";
import type { CollectionName } from "@/server/db/types";

export const expectedMongoDatabaseName = "astraflow_dev";

const globalForMongo = globalThis as unknown as {
  astraflowMongoClientPromise?: Promise<MongoClient>;
};

export function getMongoConfig() {
  return {
    uri: requiredEnv("MONGODB_URI"),
    dbName: requiredEnv("MONGODB_DB_NAME"),
    appName: optionalEnv("MONGODB_APP_NAME") ?? "astraflow-image-studio",
    maxPoolSize: Number(optionalEnv("MONGODB_MAX_POOL_SIZE") ?? 20),
    minPoolSize: Number(optionalEnv("MONGODB_MIN_POOL_SIZE") ?? 0),
    serverSelectionTimeoutMs: Number(optionalEnv("MONGODB_SERVER_SELECTION_TIMEOUT_MS") ?? 5000),
    useServerApiV1: optionalEnv("MONGODB_SERVER_API_VERSION") === "1"
  };
}

function createMongoClient() {
  const config = getMongoConfig();
  const options: MongoClientOptions = {
    appName: config.appName,
    maxPoolSize: config.maxPoolSize,
    minPoolSize: config.minPoolSize,
    retryReads: true,
    retryWrites: true,
    serverSelectionTimeoutMS: config.serverSelectionTimeoutMs
  };

  if (config.useServerApiV1) {
    options.serverApi = {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: true
    };
  }

  return new MongoClient(config.uri, options);
}

export async function getMongoClient() {
  if (!globalForMongo.astraflowMongoClientPromise) {
    const client = createMongoClient();
    globalForMongo.astraflowMongoClientPromise = client.connect().catch(async (error: unknown) => {
      globalForMongo.astraflowMongoClientPromise = undefined;
      await client.close().catch(() => undefined);
      throw error;
    });
  }

  return globalForMongo.astraflowMongoClientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getMongoConfig().dbName);
}

export async function mongoCollection<TSchema extends Document = Document>(
  name: CollectionName
): Promise<Collection<TSchema>> {
  const db = await getMongoDb();
  return db.collection<TSchema>(name);
}

export async function withMongoTransaction<T>(callback: (session: ClientSession) => Promise<T>) {
  const client = await getMongoClient();
  const session = client.startSession();
  let result: T | undefined;

  try {
    await session.withTransaction(async () => {
      result = await callback(session);
    });

    return result as T;
  } finally {
    await session.endSession();
  }
}

export async function checkMongoReady() {
  const db = await getMongoDb();
  await db.command({ ping: 1 });
  return {
    ok: true,
    dbName: getMongoConfig().dbName
  };
}
