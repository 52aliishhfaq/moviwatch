/**
 * Archive.org catalogue integration.
 *
 * This module uses Archive.org's public JSON APIs directly. It deliberately
 * does not import or copy the internetarchive Python SDK (AGPL-3.0).
 */

const ARCHIVE_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_QUERY_LENGTH = 160;
const SEARCH_FIELDS = [
  "identifier", "title", "year", "creator", "description",
  "mediatype", "collection", "licenseurl", "publicdate"
];
const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "ogv", "ogg", "mov", "mkv", "avi", "mpeg", "mpg"
]);
const VIDEO_FORMATS = /^(mpeg4|h\.264|h\.264 ia|mpeg2|webm|quicktime|ogg video|matroska|avi|mpeg1|mpeg2 video)$/i;

function archiveError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeText(value, max = 2000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function escapeLucene(value) {
  return value.replace(/([+\-!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function archiveJson(response, label) {
  if (!response.ok) {
    throw archiveError(`Archive.org ${label} request failed (HTTP ${response.status}).`, 502);
  }
  return response.json().catch(() => {
    throw archiveError(`Archive.org returned invalid JSON for ${label}.`, 502);
  });
}

function fileExtension(name) {
  const clean = String(name || "").split("/").pop() || "";
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function isArchiveIdentifier(value) {
  return typeof value === "string" && ARCHIVE_ID_RE.test(value);
}

export function buildArchiveSearchUrl({ query = "", year = "", page = 1, rows = 24, sort = "downloads desc" } = {}) {
  const term = safeText(query, MAX_QUERY_LENGTH);
  if (query && !term) throw archiveError("Enter a valid Archive.org search term.");
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw archiveError("Invalid search page.");
  if (!Number.isInteger(rows) || rows < 1 || rows > 50) throw archiveError("Search page size must be between 1 and 50.");
  if (year && !/^\d{4}$/.test(String(year))) throw archiveError("Year must contain four digits.");
  const allowedSort = new Set(["downloads desc", "downloads asc", "date desc", "date asc", "titleSorter asc", "titleSorter desc"]);
  if (!allowedSort.has(sort)) throw archiveError("Unsupported Archive.org sort order.");

  const clauses = ["mediatype:movies"];
  if (term) {
    const words = term.split(/\s+/).filter(Boolean).slice(0, 10).map(escapeLucene);
    const expression = words.map((word) => `title:(${word}) OR description:(${word}) OR creator:(${word})`).join(" AND ");
    clauses.push(`(${expression})`);
  }
  if (year) clauses.push(`year:${year}`);

  const url = new URL("https://archive.org/advancedsearch.php");
  url.searchParams.set("q", clauses.join(" AND "));
  for (const field of SEARCH_FIELDS) url.searchParams.append("fl[]", field);
  url.searchParams.append("sort[]", sort);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("page", String(page));
  url.searchParams.set("output", "json");
  return url;
}

export async function searchArchiveItems(options = {}, fetchImpl = fetch) {
  const url = buildArchiveSearchUrl(options);
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "Moviwatch/1.0 (Archive.org public catalogue)" },
    signal: AbortSignal.timeout(12000)
  });
  const payload = await archiveJson(response, "search");
  const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
  return {
    page: Number(payload?.response?.start || 0) / Number(payload?.response?.rows || 24) + 1,
    rows: Number(payload?.response?.rows || 24),
    total: Number(payload?.response?.numFound || 0),
    items: docs.filter((item) => isArchiveIdentifier(item.identifier)).map((item) => ({
      identifier: item.identifier,
      title: safeText(item.title, 300) || item.identifier,
      year: safeText(String(item.year || ""), 12),
      creator: safeText(Array.isArray(item.creator) ? item.creator.join(", ") : String(item.creator || ""), 500),
      description: safeText(Array.isArray(item.description) ? item.description.join(" ") : String(item.description || ""), 1000),
      mediatype: safeText(item.mediatype, 40),
      collection: Array.isArray(item.collection) ? item.collection.slice(0, 20).map((v) => safeText(v, 120)) : [],
      licenseurl: safeText(item.licenseurl, 500),
      publicdate: safeText(item.publicdate, 40)
    }))
  };
}

export async function getArchiveItem(identifier, fetchImpl = fetch) {
  if (!isArchiveIdentifier(identifier)) throw archiveError("Invalid Archive.org item identifier.");
  const url = new URL("https://archive.org/metadata/" + encodeURIComponent(identifier));
  url.searchParams.set("extended_err", "1");
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "Moviwatch/1.0 (Archive.org item metadata)" },
    signal: AbortSignal.timeout(12000)
  });
  const payload = await archiveJson(response, "item metadata");
  const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const rawFiles = Array.isArray(payload?.files) ? payload.files : [];
  const files = rawFiles.flatMap((file) => {
    if (!file || typeof file.name !== "string") return [];
    const name = safeText(file.name, 1000);
    const ext = fileExtension(name);
    const format = safeText(file.format, 100);
    const size = /^\d+$/.test(String(file.size || "")) ? Number(file.size) : null;
    const isVideo = VIDEO_EXTENSIONS.has(ext) || VIDEO_FORMATS.test(format);
    if (!isVideo || !name || name.startsWith("__")) return [];
    return [{
      name,
      format,
      size,
      source: safeText(file.source, 80),
      md5: /^[a-f0-9]{32}$/i.test(String(file.md5 || "")) ? String(file.md5).toLowerCase() : null,
      sha1: /^[a-f0-9]{40}$/i.test(String(file.sha1 || "")) ? String(file.sha1).toLowerCase() : null,
      private: file.private === "true" || file.private === true,
      original: file.original === "true" || file.original === true
    }];
  }).filter((file) => !file.private).sort((a, b) => {
    const rank = (f) => (f.ext === "mp4" ? 0 : f.ext === "webm" ? 1 : 2);
    return rank({ ext: fileExtension(a.name) }) - rank({ ext: fileExtension(b.name) }) ||
      (b.size || 0) - (a.size || 0);
  });
  const server = safeText(payload.server, 200);
  const d1 = safeText(payload.d1, 200);
  const d2 = safeText(payload.d2, 200);
  const errorCode = Number(payload.error || payload.metadata?.error || 0) || null;
  const availability = errorCode ? ({
    101: "creation_pending", 102: "temporarily_offline",
    103: "unbacked_item", 104: "deleted"
  }[errorCode] || "unavailable") : (payload.is_dark ? "dark" : "available");
  return {
    identifier,
    title: safeText(metadata.title, 300) || identifier,
    description: safeText(metadata.description, 5000),
    year: safeText(String(metadata.year || ""), 12),
    creator: safeText(Array.isArray(metadata.creator) ? metadata.creator.join(", ") : String(metadata.creator || ""), 500),
    mediatype: safeText(metadata.mediatype, 40),
    collection: Array.isArray(metadata.collection) ? metadata.collection.slice(0, 50).map((v) => safeText(v, 120)) : [],
    licenseurl: safeText(metadata.licenseurl, 500),
    rights: safeText(metadata.rights, 1000),
    availability,
    errorCode,
    files,
    storage: { server: server || null, d1: d1 || null, d2: d2 || null }
  };
}

export async function probeArchiveFile(identifier, filename, fetchImpl = fetch) {
  if (!isArchiveIdentifier(identifier)) throw archiveError("Invalid Archive.org item identifier.");
  if (typeof filename !== "string" || !filename || filename.length > 1000 ||
      filename.split("/").some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) {
    throw archiveError("Invalid Archive.org filename.");
  }
  const encodedPath = filename.split("/").map(encodeURIComponent).join("/");
  const url = "https://archive.org/download/" + encodeURIComponent(identifier) + "/" + encodedPath;
  let requestUrl = new URL(url);
  let response;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (requestUrl.protocol !== "https:" ||
        !(requestUrl.hostname === "archive.org" || requestUrl.hostname.endsWith(".archive.org")) ||
        requestUrl.username || requestUrl.password || requestUrl.port) {
      throw archiveError("Archive.org redirected the file probe to an untrusted host.", 502);
    }
    response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: { range: "bytes=0-0", "accept-encoding": "identity" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    try { await response.body?.cancel(); } catch {}
    if (!location || redirect === 5) throw archiveError("Archive.org file probe exceeded the redirect limit.", 502);
    requestUrl = new URL(location, requestUrl);
  }
  const contentRange = response.headers.get("content-range") || "";
  const match = /^bytes 0-0\/(\d+)$/.exec(contentRange);
  const valid = response.status === 206 && Boolean(match) && Number(match[1]) > 0;
  try { await response.body?.cancel(); } catch {}
  if (!valid) throw archiveError("Selected Archive.org file did not pass the byte-range availability check.", 422);
  return {
    url,
    size: Number(match[1]),
    contentType: safeText(response.headers.get("content-type") || "", 120),
    status: response.status
  };
}
