export function videoSourceUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new Error('Add a Google Drive file link or an Archive.org /download/ link');
  const value=input.trim();
  if (/^[A-Za-z0-9_-]{10,200}$/.test(value)) return 'https://drive.usercontent.google.com/download?id='+encodeURIComponent(value)+'&export=download&confirm=t';
  let url; try { url=new URL(value); } catch { throw new Error('Invalid video URL'); }
  if(url.protocol!=='https:'||url.username||url.password||url.port) throw new Error('Video links must use HTTPS without credentials or custom ports');
  const host=url.hostname.toLowerCase();
  if(host==='drive.google.com'||host==='drive.usercontent.google.com'){
    const id=url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/)?.[1]||url.searchParams.get('id');
    if(!id||!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new Error('Use a Google Drive file link, not a folder link. Set General access to Anyone with the link (Viewer).');
    return 'https://drive.usercontent.google.com/download?id='+encodeURIComponent(id)+'&export=download&confirm=t';
  }
  if(host.endsWith('.googleusercontent.com')&&url.pathname!=='/') return url.toString();
  if(host==='archive.org'||host.endsWith('.archive.org')){
    const parts=url.pathname.split('/').filter(Boolean);
    if((parts[0]==='download'&&parts.length>=3)||(host!=='archive.org'&&parts.includes('items')&&parts.length>=4)) return url.toString();
    throw new Error('Use an Archive.org file URL such as https://archive.org/download/IDENTIFIER/video.mp4');
  }
  throw new Error('Only Google Drive and Archive.org video links are supported');
}
export function sourceProvider(input){const host=new URL(input).hostname.toLowerCase();return host==='archive.org'||host.endsWith('.archive.org')?'archive.org':'google-drive'}
