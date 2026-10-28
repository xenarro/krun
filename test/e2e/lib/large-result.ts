// Shared by the native Function and its independent byte/hash acceptance oracle.
export const largeResult = (input: unknown): string => {
  const empty = JSON.stringify({ input, padding: "" });
  const remaining = 1024 * 1024 - Buffer.byteLength(empty);
  if (remaining < 0) throw new Error("Native result fixture input is too large");
  return JSON.stringify({ input, padding: "x".repeat(remaining) });
};
