import picomatch from "picomatch";

/** Pure compilation shared by Function admission and the runtime webhook policy. */
export const compileHostAllowlist = (
  patterns: readonly string[],
): ((hostname: string) => boolean) | undefined => {
  try {
    const matches = picomatch(
      [...patterns].map((pattern) => pattern.toLowerCase()),
      {
        nocase: false,
        dot: true,
      },
    );
    return (hostname) => matches(hostname.toLowerCase());
  } catch {
    // The caller chooses its own bounded configuration/admission error.
    return undefined;
  }
};
