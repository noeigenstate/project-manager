const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { resolveProjectPath } = require('./project-files.cjs');

const WEB_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
};

// Preview documents never share the privileged application's origin or preload.
// A random, short-lived host grants access only to this project's web resources.
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' https: 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' https: 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "connect-src 'self' https:",
  "media-src 'self' https: data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'self'",
  "sandbox allow-scripts allow-same-origin",
].join('; ');

function allowsHiddenPath(session, relativePath) {
  if (relativePath === session.filePath.replace(/\\/g, '/')) return true;
  const parts = relativePath.split(/[\\/]/);
  const selectedParents = session.filePath.replace(/\\/g, '/').split('/').slice(0, -1);
  return parts.every((part, index) => !part.startsWith('.') || (index < selectedParents.length && parts.slice(0, index + 1).every((value, i) => value === selectedParents[i])));
}

class PreviewResources {
  constructor() { this.sessions = new Map(); }

  open(project, filePath, kind) {
    const previewId = randomBytes(24).toString('hex');
    this.sessions.set(previewId, { project, filePath, kind });
    if (this.sessions.size > 32) this.sessions.delete(this.sessions.keys().next().value);
    const encoded = filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return { previewId, url: `project-preview://${previewId}/${encoded}` };
  }

  close(previewId) { if (typeof previewId === 'string') this.sessions.delete(previewId); }
  closeProject(projectId) { for (const [id, session] of this.sessions) if (session.project.id === projectId) this.sessions.delete(id); }
  hasUrl(url) { try { const value = new URL(url); return value.protocol === 'project-preview:' && this.sessions.has(value.hostname); } catch { return false; } }

  async resolve(url) {
    const address = new URL(url);
    const session = address.protocol === 'project-preview:' && this.sessions.get(address.hostname);
    if (!session || address.username || address.password || address.port) throw new Error('Preview expired');
    const relativePath = decodeURIComponent(address.pathname).replace(/^\//, '');
    if (!relativePath || !allowsHiddenPath(session, relativePath)) throw new Error('Hidden paths are not preview resources');
    if (session.kind === 'image' && relativePath !== session.filePath.replace(/\\/g, '/')) throw new Error('Image preview is limited to the selected file');
    const mimeType = WEB_TYPES[path.extname(relativePath).toLowerCase()];
    if (!mimeType) throw new Error('Unsupported preview resource');
    const resolved = await resolveProjectPath(session.project, relativePath);
    const relativeReal = path.relative(await fs.realpath(session.project.path), resolved);
    if (!allowsHiddenPath(session, relativeReal.split(path.sep).join('/'))) throw new Error('Hidden link targets are not preview resources');
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('Preview resource is not a supported file');
    return { path: resolved, mimeType, size: stat.size, headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': PREVIEW_CSP,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    } };
  }
}

module.exports = { PreviewResources, PREVIEW_CSP };
