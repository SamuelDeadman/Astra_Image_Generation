import "server-only";

import { nanoid } from "nanoid";
import type { ClientSession } from "mongodb";
import { mongoCollection } from "@/server/db/mongodb";
import { collectionNames, type CreditTransactionDocument, type CreditTransactionKind } from "@/server/db/types";

type CreditLedgerInput = {
  userId: string;
  kind: CreditTransactionKind;
  amount: number;
  referenceId: string;
  metadata?: Record<string, unknown>;
  session?: ClientSession;
};

export type CreditLedgerResult = {
  transaction: CreditTransactionDocument | null;
  inserted: boolean;
};

function assertLedgerAmount(amount: number) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("Credit transaction amount must be a non-negative integer.");
  }
}

export async function writeCreditTransactionOnce(input: CreditLedgerInput): Promise<CreditLedgerResult> {
  assertLedgerAmount(input.amount);

  const transactions = await mongoCollection<CreditTransactionDocument>(collectionNames.creditTransactions);
  const now = new Date();
  const transaction: CreditTransactionDocument = {
    _id: nanoid(),
    userId: input.userId,
    kind: input.kind,
    amount: input.amount,
    referenceId: input.referenceId,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: now
  };
  const result = await transactions.updateOne(
    { referenceId: input.referenceId },
    { $setOnInsert: transaction },
    { upsert: true, session: input.session }
  );

  if (result.upsertedCount === 1) {
    return { transaction, inserted: true };
  }

  const existing = await transactions.findOne({ referenceId: input.referenceId }, { session: input.session });
  return { transaction: existing, inserted: false };
}

export async function reserveGenerationCredits(input: {
  userId: string;
  jobId: string;
  amount: number;
  workflowRevisionId: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
  session?: ClientSession;
}) {
  return writeCreditTransactionOnce({
    userId: input.userId,
    kind: "RESERVATION",
    amount: input.amount,
    referenceId: `generation:${input.jobId}:reservation`,
    metadata: {
      jobId: input.jobId,
      workflowRevisionId: input.workflowRevisionId,
      modelId: input.modelId,
      ...(input.metadata ?? {})
    },
    session: input.session
  });
}

export async function captureGenerationCredits(input: {
  userId: string;
  jobId: string;
  attemptId: string;
  amount: number;
  reservedCredits?: number;
  metadata?: Record<string, unknown>;
  session?: ClientSession;
}) {
  return writeCreditTransactionOnce({
    userId: input.userId,
    kind: "CAPTURE",
    amount: input.amount,
    referenceId: `generation:${input.jobId}:capture`,
    metadata: {
      jobId: input.jobId,
      attemptId: input.attemptId,
      reservedCredits: input.reservedCredits,
      ...(input.metadata ?? {})
    },
    session: input.session
  });
}

export async function refundGenerationCredits(input: {
  userId: string;
  jobId: string;
  attemptId?: string;
  amount: number;
  reason: string;
  metadata?: Record<string, unknown>;
  session?: ClientSession;
}) {
  return writeCreditTransactionOnce({
    userId: input.userId,
    kind: "REFUND",
    amount: input.amount,
    referenceId: `generation:${input.jobId}:refund`,
    metadata: {
      jobId: input.jobId,
      attemptId: input.attemptId,
      reason: input.reason,
      ...(input.metadata ?? {})
    },
    session: input.session
  });
}
