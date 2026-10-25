import { z } from "zod";

const scope = z.enum(["functions:read", "runs:read", "runs:write", "runs:priority", "admin"]);
export type KeyScope = z.output<typeof scope>;

const secret = z.string().min(1);
const entry = z.strictObject({
  // This is a label VALUE, not a DNS-1123 resource name. Preserve case.
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/),
  key: z.union([secret, z.array(secret).min(1)]),
  scopes: z.array(scope),
  functions: z.array(z.string().min(1)).optional(),
  maxQueued: z.int().min(1).optional(),
});

export const keysFileSchema = z.strictObject({ keys: z.array(entry) }).superRefine((file, ctx) => {
  const names = new Set<string>();
  for (const [index, key] of file.keys.entries()) {
    if (names.has(key.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["keys", index, "name"],
        message: "Duplicate API key name",
      });
    }
    names.add(key.name);
    if (
      !key.scopes.includes("admin") &&
      (key.functions === undefined || key.functions.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["keys", index, "functions"],
        message: "Function globs required",
      });
    }
  }
});
