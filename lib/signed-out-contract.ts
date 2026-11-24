import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const signedOutMachineSchema = z.object({
  providerId: z.string().min(1),
  accountKey: z.string().min(1).describe("The provider-issued account identity the plugin's provider-usage.v1 resources use for this account."),
  hostId: z.string().min(1),
  hostName: z.string().min(1),
  status: z.enum(["unauthenticated", "expired"]),
});
export const signedOutListSchema = z.object({ machines: z.array(signedOutMachineSchema) });
export type SignedOutMachine = z.infer<typeof signedOutMachineSchema>;
export const signedOutListMethod = "account-sign-ins.v1.listSignedOut";
export const signedOutRpcContract = defineRpcContract({
  [signedOutListMethod]: {
    input: z.object({}),
    output: signedOutListSchema,
    experimental_description:
      "Machines where an account this plugin manages has no usable login: never signed in there, signed out, or its login expired. Reads local metadata only; never contacts providers.",
  },
});
