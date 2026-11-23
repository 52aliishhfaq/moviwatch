/**
 * Video source resolver (v2)
 * Google Drive aur Archive.org ke links ko validate karke normalized source deta hai.
 * Archive.org mirror URLs playback ke liye preserve hote hain; download ke liye
 * archiveDownloadUrl() unhein canonical archive.org/download URL mein convert karta hai.
 * Public Drive links ke liye fileId bhi return hota hai, taake route OAuth API path chun sake.
 */

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const ARCHIVE_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_INPUT_LENGTH = 2048;
const INPUT_HINT = 'Add a Google Drive file link or an Archive.org direct file link';

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_VIDEO_SOURCE';
  return error;
}

const isArchiveHost = (host) => host === 'archive.org' || host.endsWith('.archive.org');

// Sirf Google ke content hosts. Koi bhi arbitrary Google-hosted path yahan se accept nahi hota.
const isGoogleContentHost = (host) => host.endsWith('.googleusercontent.com');

function driveDownloadUrl(fileId) {
  return 'https://drive.usercontent.google.com/download?id=' +
    encodeURIComponent(fileId) + '&export=download&confirm=t';
}

function driveFileIdFromUrl(url) {
  const fromPath = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/)?.[1];
  if (fromPath) return fromPath;
  const fromQuery = url.searchParams.get('id');
  return fromQuery && DRIVE_ID_RE.test(fromQuery) ? fromQuery : null;
}

/**
 * Archive.org ke supported direct-file paths validate karke canonical download URL banata hai.
 * Supported formats:
 *   /download/IDENTIFIER/file.mp4
 *   /items/IDENTIFIER/file.mp4
 *   /NN/items/IDENTIFIER/file.mp4 (Archive.org item-server mirror)
 */
function archiveDirectUrl(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  let identifier;
  let filePath;

  if (parts[0] === 'download' && parts.length >= 3) {
    identifier = parts[1];
    filePath = parts.slice(2);
  } else {
    const itemsIndex = parts.indexOf('items');
    if (itemsIndex < 0 || parts.length < itemsIndex + 3) return null;
    identifier = parts[itemsIndex + 1];
    filePath = parts.slice(itemsIndex + 2);
  }

  if (!ARCHIVE_ID_RE.test(identifier) || !filePath.length) return null;

  // Reject traversal, encoded path separators and control characters.
  for (const part of filePath) {
    let decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') ||
        decoded.includes('\\') || /[\x00-\x1f\x7f]/.test(decoded)) return null;
  }

  const direct = new URL('https://archive.org/download/' + identifier + '/' + filePath.join('/'));
  direct.search = url.search;
  return direct.toString();
}

/**
 * Single source of truth. Input ko validate karke { provider, fileId, url } deta hai.
 * Stored (already resolved) URLs par bhi ye safely chalta hai.
 */
export function resolveVideoSource(input) {
  if (typeof input !== 'string') throw invalid(INPUT_HINT);
  const value = input.trim();
  if (!value || value.length > MAX_INPUT_LENGTH) throw invalid(INPUT_HINT);

  if (DRIVE_ID_RE.test(value)) {
    return { provider: 'google-drive', fileId: value, url: driveDownloadUrl(value) };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid('Invalid video URL');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw invalid('Video links must use HTTPS without credentials or custom ports');
  }

  const host = url.hostname.toLowerCase();

  if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
    const fileId = driveFileIdFromUrl(url);
    if (!fileId) {
      throw invalid('Use a Google Drive file link, not a folder link. Set General access to Anyone with the link (Viewer).');
    }
    return { provider: 'google-drive', fileId, url: driveDownloadUrl(fileId) };
  }

  if (isGoogleContentHost(host)) {
    if (url.pathname === '/') throw invalid('Use a direct Google-hosted video file URL');
    return { provider: 'google-drive', fileId: null, url: url.toString() };
  }

  if (isArchiveHost(host)) {
    // Validate that this is a direct file URL, but keep the supplied mirror URL
    // for playback. The Worker can discover/rank Archive.org mirrors from it.
    if (!archiveDirectUrl(url)) {
      throw invalid('Use an Archive.org file URL such as https://archive.org/download/IDENTIFIER/video.mp4');
    }
    return { provider: 'archive.org', fileId: null, url: url.toString() };
  }

  throw invalid('Only Google Drive and Archive.org video links are supported');
}

export function videoSourceUrl(input) {
  return resolveVideoSource(input).url;
}

export function sourceProvider(input) {
  const source = resolveVideoSource(input);
  const host = new URL(source.url).hostname.toLowerCase();
  return host==='archive.org'||host.endsWith('.archive.org')?'archive.org':'google-drive';
}

export function archiveDownloadUrl(input) {
  const source = resolveVideoSource(input);
  if (source.provider !== 'archive.org') {
    throw invalid('Use an Archive.org direct file URL to download this item');
  }

  const canonical = archiveDirectUrl(new URL(source.url));
  if (!canonical) throw invalid('Use an Archive.org direct file URL to download this item');
  return canonical;
}
