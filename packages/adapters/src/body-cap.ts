import { AdapterError } from "./types.js";

/**
 * Audit 2026-08-22 V3: the previous byte caps checked only the
 * content-length HEADER — a chunked (header-less) response skipped the cap
 * entirely and res.json()/res.text() buffered it unbounded into isolate
 * memory. This helper reads the body through a stream with a hard running
 * byte budget, aborting as soon as the cap is exceeded regardless of how the
 * response is framed.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  const lengthHeader = Number(res.headers.get("content-length"));
  if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) {
    // No stream (tests/mocked responses): fall back to whole-body read.
    return res.text();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`streamed response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Adapter-flavored wrapper: converts cap violations to AdapterError("malformed"). */
export async function readJsonWithCap<T>(res: Response, maxBytes: number): Promise<T> {
  try {
    const text = await readBodyWithCap(res, maxBytes);
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof Error && err.message.includes("exceeds")) {
      throw new AdapterError("malformed", err.message);
    }
    throw err;
  }
}
