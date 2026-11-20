(function (global) {
  'use strict';

  // Browser requests are deliberately small. Cloudflare still stores the
  // corresponding larger 8 MiB cache blocks, shared across all viewers.
  const CHUNK_SIZE = 1024 * 1024;
  const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;
  const DEFAULT_PREFETCH_AHEAD = 2;
  const MAX_PARALLEL_READS = 4;

  class MoviwatchRangeSource {
    constructor(url, options) {
      if (typeof url !== 'string' || !url) throw new TypeError('A video URL is required');
      options = options || {};
      this.url = url;
      this.chunkSize = Number.isSafeInteger(options.chunkSize) && options.chunkSize > 0
        ? options.chunkSize : CHUNK_SIZE;
      this.maxCacheBytes = Number.isSafeInteger(options.maxCacheBytes) &&
        options.maxCacheBytes >= this.chunkSize
        ? options.maxCacheBytes : DEFAULT_MAX_CACHE_BYTES;
      this.prefetchAhead = Number.isSafeInteger(options.prefetchAhead) &&
        options.prefetchAhead >= 0
        ? Math.min(options.prefetchAhead, 4) : DEFAULT_PREFETCH_AHEAD;

      this.totalSize = null;
      this.position = 0;
      this.cache = new Map();
      this.cacheBytes = 0;
      this.pending = new Map();
      this.speculative = new Set();
      this.playbackActive = false;
      this.closed = false;
    }

    _assertOpen() {
      if (this.closed) throw new Error('Video range source is closed');
    }

    _parseContentRange(value) {
      const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(value || '');
      if (!match) return null;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = Number(match[3]);
      if (![start, end, total].every(Number.isSafeInteger) ||
          start < 0 || end < start || total <= end) return null;
      return { start, end, total };
    }

    async _responseError(response, fallback) {
      let message = fallback + ' (HTTP ' + response.status + ')';
      try {
        const payload = await response.json();
        if (typeof payload.error === 'string' && payload.error) message = payload.error;
      } catch {}
      return new Error(message);
    }

    async getSize() {
      this._assertOpen();
      if (this.totalSize !== null) return this.totalSize;

      // The Worker HEAD path validates the source and warms the first shared
      // Cloudflare cache block before the player's first byte-range read.
      const response = await fetch(this.url, {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'same-origin'
      });
      this._assertOpen();
      if (!response.ok) throw await this._responseError(response, 'Video metadata request failed');

      let total = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(total) || total < 1) {
        const probe = await fetch(this.url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          cache: 'no-store',
          credentials: 'same-origin'
        });
        if (probe.status !== 206) {
          throw await this._responseError(probe, 'Could not determine video size');
        }
        const range = this._parseContentRange(probe.headers.get('content-range'));
        try { await probe.body?.cancel(); } catch {}
        if (!range || range.start !== 0) throw new Error('Video source returned invalid size metadata');
        total = range.total;
      }

      if (!Number.isSafeInteger(total) || total < 1) {
        throw new Error('Video source returned an invalid file size');
      }
      this.totalSize = total;
      return total;
    }

    _store(index, bytes) {
      const old = this.cache.get(index);
      if (old) {
        this.cacheBytes -= old.byteLength;
        this.cache.delete(index);
      }
      this.cache.set(index, bytes);
      this.cacheBytes += bytes.byteLength;

      // Map insertion order is the LRU order: oldest entries leave first.
      while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 0) {
        const oldestIndex = this.cache.keys().next().value;
        const oldest = this.cache.get(oldestIndex);
        this.cache.delete(oldestIndex);
        this.cacheBytes -= oldest.byteLength;
      }
    }

    _getSegment(index, speculative) {
      this._assertOpen();
      const cached = this.cache.get(index);
      if (cached) {
        this.cache.delete(index);
        this.cache.set(index, cached);
        return Promise.resolve(cached);
      }

      const existing = this.pending.get(index);
      if (existing && !existing.controller.signal.aborted) {
        if (!speculative) {
          existing.needed = true;
          existing.speculative = false;
          this.speculative.delete(index);
        }
        return existing.promise;
      }
      if (existing) this.pending.delete(index);

      const controller = new AbortController();
      const entry = {
        controller,
        speculative: Boolean(speculative),
        needed: !speculative,
        promise: null
      };

      const promise = (async () => {
        const total = await this.getSize();
        const start = index * this.chunkSize;
        if (start >= total) return new Uint8Array(0);
        const end = Math.min(total - 1, start + this.chunkSize - 1);

        const response = await fetch(this.url, {
          method: 'GET',
          headers: {
            Range: 'bytes=' + start + '-' + end,
            Accept: 'video/*'
          },
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal
        });

        if (response.status !== 206) {
          throw await this._responseError(response, 'Video range request failed');
        }

        const range = this._parseContentRange(response.headers.get('content-range'));
        if (!range || range.start !== start || range.end !== end || range.total !== total) {
          throw new Error('Video server returned an unexpected byte range');
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== end - start + 1) {
          throw new Error('Video server returned an incomplete 1 MiB segment');
        }

        this._store(index, bytes);
        return bytes;
      })().finally(() => {
        if (this.pending.get(index) === entry) this.pending.delete(index);
        this.speculative.delete(index);
      });

      entry.promise = promise;
      this.pending.set(index, entry);
      return promise;
    }

    async read(offset, length) {
      this._assertOpen();
      if (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(length) || length < 0) {
        throw new RangeError('Invalid video byte-range read');
      }

      const total = await this.getSize();
      this._assertOpen();
      if (length === 0 || offset >= total) return new ArrayBuffer(0);

      const actualLength = Math.min(length, total - offset);
      const absoluteEnd = offset + actualLength;
      const firstIndex = Math.floor(offset / this.chunkSize);
      const lastIndex = Math.floor((absoluteEnd - 1) / this.chunkSize);
      const segments = new Map();

      // Bound concurrency so a large demuxer read cannot flood a mobile link.
      for (let batchStart = firstIndex; batchStart <= lastIndex; batchStart += MAX_PARALLEL_READS) {
        const indexes = [];
        for (let index = batchStart;
          index <= Math.min(lastIndex, batchStart + MAX_PARALLEL_READS - 1);
          index++) indexes.push(index);

        const batch = await Promise.all(indexes.map(index => this._getSegment(index, false)));
        for (let i = 0; i < indexes.length; i++) segments.set(indexes[i], batch[i]);
      }

      const output = new Uint8Array(actualLength);
      let written = 0;
      for (let index = firstIndex; index <= lastIndex; index++) {
        const bytes = segments.get(index);
        if (!bytes) throw new Error('Video range cache missed a requested segment');
        const chunkStart = index * this.chunkSize;
        const from = Math.max(offset, chunkStart) - chunkStart;
        const through = Math.min(absoluteEnd, chunkStart + bytes.byteLength) - chunkStart;
        if (through <= from) continue;
        const piece = bytes.subarray(from, through);
        output.set(piece, written);
        written += piece.byteLength;
      }

      if (written !== actualLength) throw new Error('Video range assembly returned incomplete data');
      this.position = absoluteEnd;

      // Prefetch only after playback is active. Metadata/index probes during
      // initial demuxing must not trigger speculative reads through the movie.
      if (this.playbackActive) this._prefetchAfter(lastIndex);
      return output.buffer;
    }

    _prefetchAfter(lastIndex) {
      if (!this.playbackActive || this.closed || this.prefetchAhead < 1 ||
          !Number.isSafeInteger(this.totalSize)) return;

      for (let distance = 1; distance <= this.prefetchAhead; distance++) {
        const index = lastIndex + distance;
        if (index * this.chunkSize >= this.totalSize) break;
        if (this.cache.has(index) || this.pending.has(index)) continue;
        if (this.speculative.size >= this.prefetchAhead) break;

        const promise = this._getSegment(index, true);
        const entry = this.pending.get(index);
        if (entry && entry.speculative) this.speculative.add(index);
        promise.catch(error => {
          if (!this.closed && error?.name !== 'AbortError') {
            console.debug('Moviwatch range prefetch failed:', error?.message || error);
          }
        }).finally(() => this.speculative.delete(index));
      }
    }

    _cancelSpeculative() {
      for (const entry of this.pending.values()) {
        if (entry.speculative && !entry.needed) entry.controller.abort();
      }
      this.speculative.clear();
    }

    setPlaybackActive(active) {
      if (this.closed) return;
      this.playbackActive = Boolean(active);
      if (!this.playbackActive) this._cancelSpeculative();
    }

    seek(offset) {
      if (Number.isSafeInteger(offset) && offset >= 0) this.position = offset;
      this._cancelSpeculative();
      return this.position;
    }

    getPosition() {
      return this.position;
    }

    getKey() {
      return 'moviwatch-range:' + this.url;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.playbackActive = false;
      for (const entry of this.pending.values()) entry.controller.abort();
      this.pending.clear();
      this.speculative.clear();
      this.cache.clear();
      this.cacheBytes = 0;
    }
  }

  global.MoviwatchRangeSource = MoviwatchRangeSource;
})(window);
