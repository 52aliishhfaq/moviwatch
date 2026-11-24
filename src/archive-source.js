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
        url.username || url.password || url.port) return null;

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
