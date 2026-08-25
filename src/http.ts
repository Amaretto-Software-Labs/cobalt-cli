const responseForegroundSignals = new WeakMap<Response, AbortSignal>();

export class ResponseReadError extends Error {
  public constructor(
    public readonly interrupted: boolean,
    options?: ErrorOptions,
  ) {
    super(
      interrupted
        ? "Response reading was interrupted."
        : "Response reading failed.",
      options,
    );
    this.name = "ResponseReadError";
  }
}

export function trackResponseForegroundSignal(
  response: Response,
  signal?: AbortSignal,
): void {
  if (signal) responseForegroundSignals.set(response, signal);
}

export async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new RangeError("Response body exceeded the allowed size.");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new ResponseReadError(
      responseForegroundSignals.get(response)?.aborted ?? false,
      { cause: error },
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
