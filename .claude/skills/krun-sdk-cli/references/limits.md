# Byte limits and truncation (SDK side)

Source of truth: docs/INTERNAL-API.md section 8 (lines 308-324) and SPEC.md:710-715.
The gateway enforces these limits; the SDK truncates *before* sending so a
well-behaved function never sees a 400 or 413 for its own reports.

## Limits by field

| Call | Field / body | Limit | SDK action when over | Gateway answer if sent anyway |
|---|---|---|---|---|
| ReportStatus | `message` | 1024 bytes | truncate on a character boundary | 400 `REQUEST_INVALID` |
| ReportStatus | `message` | at least 1 byte | never send empty; use `"status"` if the caller passed `""` (decide once, pin with a test) | 400 `REQUEST_INVALID` |
| ReportStatus | `progress` | 0 to 1 inclusive | omit the field when outside the range or not finite, log once | 400 `REQUEST_INVALID` |
| ReportStatus | `data` | 4096 bytes serialised | omit `data`, keep `message`/`progress`, log the omission | 400 `REQUEST_INVALID` |
| ReportStatus | whole body | 16384 bytes | cannot happen after the field rules | 413 `REQUEST_TOO_LARGE`, body unread |
| SetError | `message` | 4096 bytes, at least 1 byte | truncate; `"error"` when empty | 400 `REQUEST_INVALID` |
| SetError | `type` | 128 bytes | truncate | 400 `REQUEST_INVALID` |
| SetError | `details` | 8192 bytes serialised | drop `details.stack` lines from the end until it fits; if still over, send `{}`-less body without `details` | 400 `REQUEST_INVALID` |
| SetError | whole body | 32768 bytes | cannot happen after the field rules | 413 `REQUEST_TOO_LARGE` |
| SetResult | whole body | `KRUN_MAX_RESULT_BYTES` (default 262144, hard 1048576) | switch to the presigned upload, or `ResultWriteError` when no URL | 413 `RESULT_TOO_LARGE` |
| SetResult | body `null` | forbidden | a `null`/`undefined`/`None` return sends no request at all (SPEC.md:702-703) | 400 `REQUEST_INVALID` |
| Upload | object | no cap | n/a | n/a |
| Error stack | `details.stack` | first 20 lines (SPEC.md:709-710) | slice before measuring | n/a |

## How to measure

- Measure the **compact JSON serialisation in UTF-8 bytes** (SPEC.md:711-712):
  Node `Buffer.byteLength(JSON.stringify(v), "utf8")`; Python
  `len(json.dumps(v, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))`.
  `ensure_ascii=False` matters: the default escapes non-ASCII as `\uXXXX`, which
  changes the byte count and the bytes the gateway receives.
- For a string field the limit applies to the UTF-8 bytes of the string
  value, not including JSON quotes or escapes. Be conservative: if the
  gateway measures the escaped form, a string full of `"` or control
  characters can exceed it; pin the gateway's actual rule with one
  conformance case containing quotes and newlines.
- `KRUN_MAX_RESULT_BYTES` arrives as a decimal string; parse once with
  `Number.parseInt(v, 10)` / `int(v)`. Missing or unparseable in pod mode is a
  bug in the scheduler: fall back to 262144 and log at warn.

## Truncating on a character boundary

Never cut inside a multi-byte sequence or a UTF-16 surrogate pair.

Node:

```ts
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // back up over UTF-8 continuation bytes (10xxxxxx)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}
```

Python:

```python
def truncate_utf8(s: str, max_bytes: int) -> str:
    b = s.encode("utf-8")
    if len(b) <= max_bytes:
        return s
    return b[:max_bytes].decode("utf-8", errors="ignore")
```

Both versions must produce identical output for the same input; add the
same three cases to both suites: ASCII at the limit, a 2-byte character
straddling the limit, a 4-byte emoji straddling the limit.

## Stack dropping

1. `stack = error.stack.split("\n").slice(0, 20)` (Node) /
   `traceback.format_exception(e)` joined then split into lines, first 20 (Python).
2. While `bytes(details) > 8192` and `stack.length > 0`: `stack.pop()`.
3. If still over (other keys in `details`), drop `details` entirely.

Never truncate *inside* a stack line to make it fit; drop whole lines from the
end (SPEC.md:714-715).

## Tests that pin this (P8.1, P8.2, P8.3)

- Oversized status `message` and `data` arrive truncated/omitted, never 400.
- Oversized error `message`, `type` and stack arrive within limits, stack
  lines removed from the end.
- Result of exactly `KRUN_MAX_RESULT_BYTES` goes inline; one byte more goes
  to the upload URL with `Content-Length` (PLAN.md:775-776).
- Result over the cap with no upload URL: `SetError` type
  `ResultWriteError`, exit 1 (docs/INTERNAL-API.md:231-232).
