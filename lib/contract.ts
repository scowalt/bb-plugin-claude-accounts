// The host RPC contract the server calls on each machine. Tokens never cross it: the host reads usage and returns numbers.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageWindowSchema } from "./usage";

const directorySchema = z.string().min(1).max(512);

export const inspectedAccountSchema = z
  .object({
    /** As configured, for example `~/.claude-b`. */
    directory: z.string(),
    /** Absolute on that machine. */
    path: z.string(),
    /** The machine's default `~/.claude`, which turns never set CLAUDE_CONFIG_DIR for. */
    isDefault: z.boolean(),
    exists: z.boolean(),
    signedIn: z.boolean(),
    accountUuid: z.string().nullable(),
    organizationUuid: z.string().nullable(),
    email: z.string().nullable(),
    subscriptionType: z.string().nullable(),
    rateLimitTier: z.string().nullable(),
    refreshTokenExpiresAt: z.number().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type InspectedAccount = z.infer<typeof inspectedAccountSchema>;

export const inspectResultSchema = z
  .object({
    home: z.string(),
    platform: z.string(),
    accounts: z.array(inspectedAccountSchema),
  })
  .strict();
export type InspectResult = z.infer<typeof inspectResultSchema>;

export const usageReadSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), observedAt: z.number(), windows: z.array(usageWindowSchema) }).strict(),
  z.object({ status: z.enum(["expired", "signed-out", "error"]), message: z.string() }).strict(),
]);
export type UsageRead = z.infer<typeof usageReadSchema>;

export const hostContract = defineRpcContract({
  inspect: {
    input: z.object({ directories: z.array(directorySchema).min(1).max(16) }).strict(),
    output: inspectResultSchema,
  },
  readUsage: {
    input: z.object({ directory: directorySchema }).strict(),
    output: usageReadSchema,
  },
});
