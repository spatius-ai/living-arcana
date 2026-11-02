/**
 * s16le PCM frame alignment for network-chunked audio.
 *
 * Network chunks arrive with arbitrary byte lengths, but s16le PCM frames are
 * 2 bytes: an odd-length chunk must carry its trailing byte into the next one.
 * Dropping it shifts every later sample by one byte and turns speech into
 * loud static. (See HANDOFF §5.6 — this behavior is load-bearing.)
 *
 * Pure function: merges `remainder` (carried bytes from the previous call)
 * with `chunk`, and returns
 *   { send, remainder }
 * where `send` is an ArrayBuffer of whole frames to forward (null when there
 * is nothing to send on a non-final call) and `remainder` is the carried
 * trailing byte (always empty on a final call). On `last`, `send` is never
 * null — a zero-length buffer still closes the utterance downstream.
 */
export function splitPcmFrames(remainder, chunk, last = false) {
  const merged = new Uint8Array(remainder.byteLength + chunk.byteLength);
  merged.set(remainder);
  merged.set(chunk, remainder.byteLength);

  const evenLength = merged.byteLength - (merged.byteLength % 2);
  if (last) {
    return { send: merged.buffer.slice(0, evenLength), remainder: new Uint8Array(0) };
  }
  return {
    send: evenLength ? merged.buffer.slice(0, evenLength) : null,
    remainder: merged.slice(evenLength),
  };
}
