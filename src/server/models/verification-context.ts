import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

// Only the operator CLI and a database-marked verification job enter this scope.
// No browser request, workflow or task payload can select it.
const context = new AsyncLocalStorage<string>();
export function withModelVerification<T>(modelId: string, action: () => Promise<T>) { return context.run(modelId, action); }
export function isVerifyingModel(modelId: string) { return context.getStore() === modelId; }
