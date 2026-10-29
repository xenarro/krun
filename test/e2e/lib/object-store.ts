import { z } from "zod";

export { largeResult } from "./large-result.js";

export const objectStoreEndpoint = "http://krun-test-minio.krun-test-minio.svc.cluster.local:9000";
export const objectStoreBucket = "krun-test-results";
const witness = z.looseObject({
  metadata: z.looseObject({ labels: z.looseObject({ "krun.io/run-id": z.uuidv7() }) }),
  spec: z.looseObject({
    containers: z.array(
      z.looseObject({
        name: z.string(),
        env: z.array(z.looseObject({ name: z.string(), value: z.string().optional() })),
      }),
    ),
  }),
});

const platformSecrets = new Set([
  "krun-test-minio-credentials",
  "krun-test-postgres",
  "krun-e2e-keys",
  "krun-e2e-webhook-keys",
]);
// Inspect reference fields,not substrings: a fresh jobs namespace legitimately
// contains "krun-test-postgres",but may never reference the platform DB Secret.
const platformSecretReference = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(platformSecretReference);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "secretName" && typeof child === "string" && platformSecrets.has(child))
      return true;
    if (
      ["secretKeyRef", "secretRef", "secret", "nodePublishSecretRef"].includes(key) &&
      child &&
      typeof child === "object" &&
      "name" in child &&
      typeof child.name === "string" &&
      platformSecrets.has(child.name)
    )
      return true;
    if (
      key === "imagePullSecrets" &&
      Array.isArray(child) &&
      child.some(
        (reference) =>
          reference &&
          typeof reference === "object" &&
          "name" in reference &&
          typeof reference.name === "string" &&
          platformSecrets.has(reference.name),
      )
    )
      return true;
    if (platformSecretReference(child)) return true;
  }
  return false;
};

// D107 requires this one capability in the Function environment. Do not exempt
// other fields, other containers, foreign keys, input, or inline credentials.
export const privatePodManifest = (
  content: string,
  observe: (url: string) => void = () => {},
  privacy?: {
    accessKeyId: string;
    forbidden: ReadonlySet<string>;
    capabilities?: ReadonlySet<string>;
  },
): string => {
  const fail = () => {
    throw new Error("Invalid native upload URL witness");
  };
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return fail();
  }
  const decoded = witness.safeParse(raw);
  if (!decoded.success) return fail();
  const pod = decoded.data;
  const functions = pod.spec.containers.filter((container) => container.name === "function");
  const container = functions[0];
  if (
    functions.length !== 1 ||
    !container ||
    container.env.some((env) => /^(?:KRUN_S3_|MINIO_ROOT_)/.test(env.name)) ||
    platformSecretReference(pod.spec)
  )
    return fail();
  const uploads = container.env.filter((env) => env.name === "KRUN_RESULT_UPLOAD_URL");
  const entry = uploads[0];
  const id = pod.metadata.labels["krun.io/run-id"];
  if (
    uploads.length !== 1 ||
    !entry?.value ||
    entry.valueFrom !== undefined ||
    container.env.filter((env) => env.name === "KRUN_RUN_ID" && env.value === id).length !== 1
  )
    return fail();
  let url: URL;
  try {
    url = new URL(entry.value);
  } catch {
    return fail();
  }
  if (
    url.origin !== objectStoreEndpoint ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/${objectStoreBucket}/runs/${id}/result.json` ||
    url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    url.searchParams.get("X-Amz-SignedHeaders") !== "host" ||
    !/^[a-f0-9]{64}$/.test(url.searchParams.get("X-Amz-Signature") ?? "") ||
    !/^[1-9]\d*$/.test(url.searchParams.get("X-Amz-Expires") ?? "")
  )
    return fail();
  // Closed, single-valued parameters prevent arbitrary private data from being
  // erased with the one deliberately allowed capability field.
  const required = [
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-Signature",
    "X-Amz-SignedHeaders",
  ];
  const allowed = new Set([...required, "X-Amz-Content-Sha256", "x-id"]);
  for (const name of url.searchParams.keys())
    if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) return fail();
  if (required.some((name) => !url.searchParams.has(name))) return fail();
  const date = url.searchParams.get("X-Amz-Date") ?? "";
  if (
    !/^\d{8}T\d{6}Z$/.test(date) ||
    !z.iso
      .datetime({ precision: 0 })
      .safeParse(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      ).success
  )
    return fail();
  const credential = url.searchParams.get("X-Amz-Credential") ?? "";
  const accessKey = privacy?.accessKeyId ?? credential.split("/")[0] ?? "";
  if (
    !/^[A-Za-z0-9_-]+$/.test(accessKey) ||
    credential !== `${accessKey}/${date.slice(0, 8)}/us-east-1/s3/aws4_request` ||
    Number(url.searchParams.get("X-Amz-Expires")) > 604800 ||
    (url.searchParams.has("X-Amz-Content-Sha256") &&
      url.searchParams.get("X-Amz-Content-Sha256") !== "UNSIGNED-PAYLOAD") ||
    (url.searchParams.has("x-id") && url.searchParams.get("x-id") !== "PutObject")
  )
    return fail();
  if (privacy) {
    const signature = url.searchParams.get("X-Amz-Signature");
    const decoded = [...url.searchParams].map(([name, value]) => `${name}=${value}`).join("&");
    const withoutAccessKey = [...url.searchParams]
      .map(
        ([name, value]) =>
          `${name}=${name === "X-Amz-Credential" ? value.slice(accessKey.length) : value}`,
      )
      .join("&");
    for (const value of privacy.forbidden) {
      // Repeated native Pod observations contain the previously validated URL
      // and signature. These are distinct from private input/token/secret values.
      if (privacy.capabilities?.has(value) && (value === entry.value || value === signature))
        continue;
      const scanned =
        value === privacy.accessKeyId
          ? `${url.origin}${url.pathname}?${withoutAccessKey}`
          : `${entry.value}\n${url.origin}${url.pathname}?${decoded}`;
      if (scanned.includes(value) || scanned.includes(encodeURIComponent(value))) return fail();
    }
  }
  const upload = entry.value;
  delete entry.value;
  const sanitized = JSON.stringify(pod);
  if (/X-Amz-(?:Credential|Signature|Security-Token)=/i.test(sanitized)) return fail();
  observe(upload);
  return sanitized;
};
