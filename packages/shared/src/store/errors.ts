import { Data } from "effect";

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly id: string;
}> {
  override get message(): string {
    return "Run not found";
  }
}

export class ConflictError extends Data.TaggedError("ConflictError") {
  override get message(): string {
    return "Idempotency conflict";
  }
}

// Retain the operation, not arbitrary driver errors that may contain SQL,
// bound values, credentials or a connection string.
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string;
}> {
  override get message(): string {
    return "Database operation failed";
  }
}
