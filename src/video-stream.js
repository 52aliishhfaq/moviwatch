/**
 * Relay a sequence of contiguous upstream HTTP 206 response bodies without
 * buffering a complete cache chunk in Worker memory.
 *
 * Some providers cap a Range response below the requested end. In that case
 * the relay requests the next contiguous window only after the current body
 * has been consumed. Every response is checked against its Content-Range.
 */
export function createRangeRelayStream({
  firstPart,
  end,
  total,
  fetchPart,
  maxRequests = 128
}) {
  if (!firstPart?.range || !firstPart.body ||
      typeof firstPart.body.getReader !== 'function' ||
      typeof fetchPart !== 'function' ||
      !Number.isSafeInteger(end) || !Number.isSafeInteger(total) ||
      !Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new TypeError('Invalid progressive range relay configuration');
  }

  const expectedTotal = total;
  const requestedEnd = Math.min(end, total - 1);
  let currentPart = firstPart;
  let currentReader = null;
  let currentRange = null;
  let currentBytes = 0;
  let nextOffset = firstPart.range.start;
  let requests = 1;
  let closed = false;

  const validatePart = (part, expectedStart) => {
    const range = part?.range;
    if (!range || !part.body || typeof part.body.getReader !== 'function' ||
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        !Number.isSafeInteger(range.total) ||
        range.start !== expectedStart ||
        range.end < range.start ||
        range.end > requestedEnd ||
        range.total !== expectedTotal) {
      throw new Error('Video source returned a non-contiguous or inconsistent byte range');
    }
    return range;
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        while (!closed) {
          if (!currentReader) {
            if (!currentPart) {
              if (nextOffset > requestedEnd) {
                closed = true;
                controller.close();
                return;
              }
              if (++requests > maxRequests) {
                throw new Error('Video source returned too many small byte ranges');
              }
              currentPart = await fetchPart(nextOffset, requestedEnd);
              if (currentPart?.unsatisfiedTotal !== undefined) {
                throw new Error('Video source ended before the cached segment was complete');
              }
            }

            currentRange = validatePart(currentPart, nextOffset);
            currentReader = currentPart.body.getReader();
            currentPart = null;
            currentBytes = 0;
          }

          const { done, value } = await currentReader.read();
          if (done) {
            const expectedBytes = currentRange.end - currentRange.start + 1;
            if (currentBytes !== expectedBytes) {
              throw new Error('Video source ended before the requested byte range was complete');
            }
            nextOffset = currentRange.end + 1;
            currentReader = null;
            currentRange = null;
            currentBytes = 0;
            if (nextOffset > requestedEnd) {
              closed = true;
              controller.close();
              return;
            }
            continue;
          }

          if (!(value instanceof Uint8Array) || value.byteLength < 1) {
            continue;
          }
          const expectedBytes = currentRange.end - currentRange.start + 1;
          if (currentBytes + value.byteLength > expectedBytes) {
            throw new Error('Video source sent more bytes than its Content-Range declared');
          }
          currentBytes += value.byteLength;
          controller.enqueue(value);
          return;
        }
      } catch (error) {
        closed = true;
        try { await currentReader?.cancel(error); } catch {}
        controller.error(error);
      }
    },

    async cancel(reason) {
      closed = true;
      try { await currentReader?.cancel(reason); } catch {}
    }
  });
}
