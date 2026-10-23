import { z } from "zod";

// Keep the wire schema transform-free for Function/CRD generation.
export const durationStringSchema = z.string().regex(/^\d+(ms|s|m|h)$/);
