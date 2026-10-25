import { Data } from "effect";
import { z } from "zod";

class RequestSchemaInvalid extends Data.TaggedError("RequestSchemaInvalid") {}

const cloneWrapper = (schema: z.ZodType, inner: z.ZodType): z.ZodType => {
  // In particular, Default/Prefault hold a getter. Spreading the definition
  // would execute it once at registration and freeze a dynamic default value.
  const descriptors = Object.getOwnPropertyDescriptors(schema.def);
  descriptors.innerType = { value: inner, enumerable: true, configurable: true, writable: true };
  const definition: z.ZodType["def"] = Object.create(
    Object.getPrototypeOf(schema.def),
    descriptors,
  );
  return schema.clone(definition, { parent: true });
};

// Only follow root wrappers, never nested fields/opaque user schemas. Forms
// that can swallow errors, admit null or obscure the accepted root keys are
// unsupported at this boundary and fail registration rather than strip data.
export const strictRequestRoot = (schema: unknown): z.ZodType => {
  if (schema instanceof z.ZodObject) {
    return schema.clone(schema.strict().def, { parent: true });
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodExactOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional
  ) {
    return cloneWrapper(schema, strictRequestRoot(schema.unwrap()));
  }
  throw new RequestSchemaInvalid();
};
