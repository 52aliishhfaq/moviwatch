/**
 * Strict parser for Archive.org download URLs used by the playback and
 * publication-validation paths. Filename segments are decoded exactly once
 * before being passed to probeArchiveFile(), which safely re-encodes them.
 */
export function parseArchiveSourceUrl(sourceUrl) {
  if (typeof sourceUrl !== "string" || sourceUrl.length > 2048) return null;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" ||
        (url.hostname !== "archive.org" && !url.hostname.endsWith(".archive.org")) ||
        url.username || url.password || url.port || url.search || url.hash) return null;

    const rawParts = url.pathname.split("/").filter(Boolean);
    const parts = rawParts.map((part) => decodeURIComponent(part));
    const at = parts[0] === "download" ? 0 : parts.indexOf("items");
    if (at < 0 || parts.length < at + 3) return null;

    const identifier = parts[at + 1];
    const fileParts = parts.slice(at + 2);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(identifier) ||
        !fileParts.length || fileParts.some((part) =>
          !part || part === "." || part === ".." || part.includes("/") ||
          part.includes("\\") || /[\u0000-\u001f\u007f]/.test(part))) return null;

    const file = fileParts.join("/");
    if (file.length > 1600) return null;
    return { identifier, file, search: url.search, original: url.toString() };
  } catch {
    return null;
  }
}

/**
 * Verify each candidate with a real HTTP byte-range probe. The injected
 * function keeps the workflow unit-testable without network access.
 */
export async function verifyArchiveSources(sources, probeFile, now = () => new Date()) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 8) {
    throw new Error("Add between 1 and 8 Archive.org sources before publishing.");
  }
  if (typeof probeFile !== "function" || typeof now !== "function") {
    throw new TypeError("Archive.org verification dependencies are invalid.");
  }

  const verified = [];
  for (let offset = 0; offset < sources.length; offset += 3) {
    const batch = sources.slice(offset, offset + 3);
    const results = await Promise.all(batch.map(async (source, index) => {
      if (!source || source.provider !== "archive.org" || typeof source.url !== "string") {
        throw new Error("Only Archive.org file URLs can be published.");
      }
      const parsed = parseArchiveSourceUrl(source.url);
      if (!parsed) throw new Error("Invalid canonical Archive.org download URL for source: " + (source.label || "Video"));
      try {
        const probe = await probeFile(parsed.identifier, parsed.file);
        if (!probe || probe.status !== 206 || !Number.isSafeInteger(probe.size) || probe.size < 1) {
          throw new Error("The upstream file did not return a valid HTTP 206 byte range.");
        }
        const verifiedAt = now();
        if (!(verifiedAt instanceof Date) || !Number.isFinite(verifiedAt.getTime())) {
          throw new Error("Verification clock returned an invalid timestamp.");
        }
        return {
          label: typeof source.label === "string" && source.label.trim()
            ? source.label.trim().slice(0, 60) : "Archive.org " + (offset + index + 1),
          url: typeof probe.url === "string" ? probe.url : parsed.original,
          provider: "archive.org",
          verified_at: verifiedAt.toISOString(),
          verified_size: probe.size
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown Archive.org probe error.";
        throw new Error('Archive.org verification failed for "' +
          (source.label || ("source " + (offset + index + 1))) + '": ' + detail);
      }
    }));
    verified.push(...results);
  }
  return verified;
}
