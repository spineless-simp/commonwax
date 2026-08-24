import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { commonwaxPrisma?: PrismaClient };

export const db = globalForPrisma.commonwaxPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.commonwaxPrisma = db;

export * from "@prisma/client";
