/**
 * Progressive range relay.
 *
 * Streams contiguous upstream byte ranges to the browser without buffering the
 * complete video. Retries are bounded, interrupted bodies resume at the first
 * byte not yet delivered, and viewer cancellation aborts pending fetches.
 */
export function createRangeRelayStream({
  firstPart,
  end,
  total,
  fetchPart,
  maxRequests = 8192,
  maxRetries = 2,
  retryDelayMs = 200,
  idleTimeoutMs = 25000,
}) {
  if (!firstPart?.range || !firstPart.body ||
      typeof firstPart.body.getReader !== 'function' ||
      typeof fetchPart !== 'function' ||
      !Number.isSafeInteger(end) || !Number.isSafeInteger(total) || total < 1 ||
      !Number.isInteger(maxRequests) || maxRequests < 1 ||
      !Number.isInteger(maxRetries) || maxRetries < 0 ||
      !Number.isFinite(retryDelayMs) || retryDelayMs < 0 ||
      !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new TypeError('Invalid progressive range relay configuration');
  }

  const lastByte = Math.min(end, total - 1);
  const abortController = new AbortController();
  const pending = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let controller = null;
  let closed = false;
  let requests = 1;
  let failures = 0;
  let nextOffset = firstPart.range.start;
  let reader = null;
  let currentRange = null;
  let currentBytes = 0;

  pending.set(firstPart.range.start, Promise.resolve(firstPart));

  const validatePart = (part, expectedStart) => {
    const range = part?.range;
    if (!range || !part.body || typeof part.body.getReader !== 'function' ||
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        !Number.isSafeInteger(range.total) ||
        range.start !== expectedStart ||
        range.end < range.start ||
        range.end > lastByte ||
        range.total !== total) {
      throw new Error('Video source returned a non-contiguous or inconsistent byte range');
    }
    return { start: range.start, end: range.end };
  };

  const toUint8 = (value) => {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError('Video source sent a non-binary chunk');
  };

  const quietCancel = async (target, reason) => {
    try { await target?.cancel(reason); } catch {}
  };

  const fetchWithRetry = async (offset) => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let part;
      try {
        part = await fetchPart(offset, lastByte, abortController.signal);
      } catch (error) {
        if (closed || attempt >= maxRetries) throw error;
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      if (part?.unsatisfiedTotal !== undefined) {
        throw new Error('Video source ended before the segment was complete');
      }
      return part;
    }
    throw new Error('Video source request retries exhausted');
  };

  const requestWindow = (offset) => {
    if (closed) throw new Error('Relay is closed');
    let promise = pending.get(offset);
    if (!promise) {
      if (++requests > maxRequests) {
        throw new Error('Video source needed too many byte-range requests');
      }
      promise = fetchWithRetry(offset).catch((error) => {
        pending.delete(offset);
        throw error;
      });
      promise.catch(() => {});
      pending.set(offset, promise);
    }
    return promise;
  };

  const discardPending = (keepFromOffset) => {
    for (const [offset, promise] of pending) {
      if (offset >= keepFromOffset) continue;
      pending.delete(offset);
      promise.then((part) => quietCancel(part?.body, 'stale window'), () => {});
    }
  };

  const dropSegment = async (reason) => {
    const current = reader;
    reader = null;
    currentRange = null;
    currentBytes = 0;
    await quietCancel(current, reason);
  };

  const readChunk = (current) => {
    const read = current.read();
    read.catch(() => {});
    let timer;
    const stalled = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Video source stalled')), idleTimeoutMs);
    });
    return Promise.race([read, stalled]).finally(() => clearTimeout(timer));
  };

  const resumeAfter = async (error) => {
    const length = currentRange.end - currentRange.start + 1;
    const complete = currentBytes >= length;
    const resumeAt = complete ? currentRange.end + 1 : currentRange.start + currentBytes;

    await dropSegment(error);
    nextOffset = resumeAt;
    discardPending(nextOffset);

    if (complete) {
      failures = 0;
      return;
    }
    if (++failures > maxRetries) throw error;
    await sleep(retryDelayMs * 2 ** (failures - 1));
  };

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    abortController.abort(reason);
    dropSegment(reason);
    for (const promise of pending.values()) {
      promise.then((part) => quietCancel(part?.body, reason), () => {});
    }
    pending.clear();
  };

  const finish = () => {
    shutdown();
    controller.close();
  };

  const fail = (error) => {
    if (closed) return;
    shutdown(error);
    controller.error(error);
  };

  return new ReadableStream({
    start(c) {
      controller = c;
    },

    async pull(c) {
      try {
        while (!closed) {
          if (!reader) {
            if (nextOffset > lastByte) {
              finish();
              return;
            }

            const part = await requestWindow(nextOffset);
            pending.delete(nextOffset);

            if (closed) {
              await quietCancel(part?.body, 'closed');
              return;
            }

            try {
              currentRange = validatePart(part, nextOffset);
            } catch (error) {
              await quietCancel(part?.body, error);
              throw error;
            }

            reader = part.body.getReader();
            currentBytes = 0;
          }

          const length = currentRange.end - currentRange.start + 1;
          let step;
          try {
            step = await readChunk(reader);
          } catch (error) {
            if (closed) return;
            await resumeAfter(error);
            continue;
          }
          if (closed) return;

          if (step.done) {
            if (currentBytes === length) {
              nextOffset = currentRange.end + 1;
              reader = null;
              currentRange = null;
              currentBytes = 0;
              failures = 0;
              continue;
            }
            await resumeAfter(new Error('Video source ended before the requested byte range was complete'));
            continue;
          }

          const bytes = toUint8(step.value);
          if (bytes.byteLength === 0) continue;
          if (currentBytes + bytes.byteLength > length) {
            throw new Error('Video source sent more bytes than its Content-Range declared');
          }
          currentBytes += bytes.byteLength;
          // Keep the retry budget across partial body reads. Reset it only
          // after the complete upstream range has been consumed; otherwise
          // a source that repeatedly sends one chunk and disconnects can
          // evade maxRetries indefinitely (until maxRequests is exhausted).
          c.enqueue(bytes);
          return;
        }
      } catch (error) {
        fail(error);
      }
    },

    cancel(reason) {
      shutdown(reason);
    },
  });
}
