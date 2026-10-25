import { sql } from "kysely";

// PostgreSQL text cannot represent U+0000. The disjoint NUL domain has a
// reversible binary slot; all shipped ordinary/null identifiers remain text.
// UTF-16LE preserves exact JS code units, without Unicode normalization.
export const requestIdStorage = (dialect: "postgres" | "sqlite", key: string | null) =>
  dialect === "postgres" && key?.includes("\0")
    ? { column: sql`idempotency_key_nul`, value: Buffer.from(key, "utf16le") }
    : { column: sql`idempotency_key`, value: key };
