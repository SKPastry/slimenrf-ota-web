// GitHub Release & Actions artifact firmware download module.
//
// - Releases: list via API (CORS OK), download via proxy or browser link
// - Artifacts: list via API (CORS OK), download via proxy or nightly.link
// - Zip extraction via fflate
// - When deployed on Cloudflare Pages, uses /api/proxy for CORS-free downloads

import { unzipSync } from 'fflate';

// ── Configuration ────────────────────────────────────────────────────

const OWNER = 'jitingcn';
const TRACKER_REPO = 'SlimeVR-Tracker-nRF';
const RECEIVER_REPO = 'SlimeVR-Tracker-nRF-Receiver';
const TRACKER_API_BASE = `https://api.github.com/repos/${OWNER}/${TRACKER_REPO}`;
const RECEIVER_API_BASE = `https://api.github.com/repos/${OWNER}/${RECEIVER_REPO}`;
const TRACKER_NIGHTLY_LINK = `https://nightly.link/${OWNER}/${TRACKER_REPO}`;
const RECEIVER_NIGHTLY_LINK = `https://nightly.link/${OWNER}/${RECEIVER_REPO}`;

// Only show releases with tags that are numeric and ≥ this value (OTA-compatible)
const MIN_RELEASE_TAG = 260527;
// Only show tracker CI runs with run_number ≥ this value
const MIN_RUN_NUMBER = 191;
// Only show receiver CI runs with run_number ≥ this value
const MIN_RECEIVER_RUN_NUMBER = 68;

// ── Proxy Detection ─────────────────────────────────────────────────

/**
 * Build a proxied URL if the CORS proxy is available (CF Pages deployment).
 * Falls back to the original URL for local development.
 */
function proxyUrl(url) {
  // Use /api/proxy when deployed (same origin)
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

/**
 * Check if the CORS proxy is available (CF Pages deployment).
 * Cached after first check.
 */
let _proxyAvailable = null;
export async function isProxyAvailable() {
  if (_proxyAvailable !== null) return _proxyAvailable;
  try {
    const resp = await fetch('/api/proxy', { method: 'GET' });
    // Health-check returns 200 with { status: 'ok' }
    _proxyAvailable = resp.ok;
  } catch {
    _proxyAvailable = false;
  }
  return _proxyAvailable;
}

// ── Release API ──────────────────────────────────────────────────────

/**
 * Fetch releases from GitHub API.
 * Filters to releases with numeric tags ≥ MIN_RELEASE_TAG.
 * Returns both tracker and receiver assets, tagged with `type`.
 * Returns: [{ tag, name, date, prerelease, assets: [{ name, size, downloadUrl, type }] }]
 */
export async function fetchReleases() {
  const resp = await fetch(`${TRACKER_API_BASE}/releases?per_page=20`);
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();

  return data
    .filter((r) => {
      const m = r.tag_name.match(/^(\d{6})/);
      if (!m) return false;
      const tag = parseInt(m[1], 10);
      return tag >= MIN_RELEASE_TAG;
    })
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      date: r.published_at,
      prerelease: r.prerelease,
      body: r.body || '',
      assets: r.assets
        .filter((a) => a.name.endsWith('.uf2') || a.name.endsWith('.hex'))
        .filter((a) => !a.name.startsWith('update-'))
        .filter((a) => !a.name.includes('bootloader'))
        .filter((a) => !a.name.includes('foxdongle'))
        .map((a) => ({
          name: a.name,
          size: a.size,
          downloadUrl: a.browser_download_url,
          type: a.name.toLowerCase().includes('receiver') ? 'receiver' : 'tracker',
        })),
    }))
    .filter((r) => r.assets.length > 0);
}

// ── CI Runs API ──────────────────────────────────────────────────────

/**
 * Fetch successful tracker CI runs from dev branch (push events).
 * Returns: [{ id, number, title, date, sha, branch }]
 */
export async function fetchCIRuns() {
  const params = new URLSearchParams({
    branch: 'dev',
    event: 'push',
    status: 'success',
    per_page: '10',
  });
  const resp = await fetch(`${TRACKER_API_BASE}/actions/runs?${params}`);
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();

  return data.workflow_runs
    .filter((r) => r.run_number >= MIN_RUN_NUMBER)
    .map((r) => ({
      id: r.id,
      number: r.run_number,
      title: r.display_title,
      date: r.created_at,
      sha: r.head_sha.slice(0, 8),
      branch: r.head_branch,
    }));
}

/**
 * Fetch artifacts for a specific tracker CI run.
 * Filters OUT receiver artifacts (those are in the receiver repo).
 * Returns: [{ name, size, downloadUrl (nightly.link) }]
 */
export async function fetchRunArtifacts(runId) {
  const resp = await fetch(`${TRACKER_API_BASE}/actions/runs/${runId}/artifacts?per_page=100`);
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();

  return data.artifacts
    .filter((a) => !a.expired)
    .filter((a) => !a.name.toLowerCase().includes('receiver'))
    .map((a) => ({
      name: a.name,
      size: a.size_in_bytes,
      downloadUrl: `${TRACKER_NIGHTLY_LINK}/actions/runs/${runId}/${a.name}.zip`,
    }));
}

/**
 * Fetch successful receiver CI runs from dev branch (push events).
 * Returns: [{ id, number, title, date, sha, branch }]
 */
export async function fetchReceiverCIRuns() {
  const params = new URLSearchParams({
    branch: 'dev',
    event: 'push',
    status: 'success',
    per_page: '10',
  });
  const resp = await fetch(`${RECEIVER_API_BASE}/actions/runs?${params}`);
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();

  return data.workflow_runs
    .filter((r) => r.run_number >= MIN_RECEIVER_RUN_NUMBER)
    .map((r) => ({
      id: r.id,
      number: r.run_number,
      title: r.display_title,
      date: r.created_at,
      sha: r.head_sha.slice(0, 8),
      branch: r.head_branch,
    }));
}

/**
 * Fetch artifacts for a specific receiver CI run.
 * Returns: [{ name, size, downloadUrl (nightly.link) }]
 */
export async function fetchReceiverRunArtifacts(runId) {
  const resp = await fetch(`${RECEIVER_API_BASE}/actions/runs/${runId}/artifacts?per_page=100`);
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();

  return data.artifacts
    .filter((a) => !a.expired)
    .map((a) => ({
      name: a.name,
      size: a.size_in_bytes,
      downloadUrl: `${RECEIVER_NIGHTLY_LINK}/actions/runs/${runId}/${a.name}.zip`,
    }));
}

// ── Download Helpers ─────────────────────────────────────────────────

/**
 * Fetch a URL with streaming progress. Tries proxy if available.
 * Returns ArrayBuffer on success, null on CORS/network failure.
 */
async function fetchWithProgress(url, onProgress, useProxy = false) {
  const fetchUrl = useProxy ? proxyUrl(url) : url;
  const resp = await fetch(fetchUrl, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  let received = 0;

  const reader = resp.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress && total > 0) {
      onProgress(received / total);
    }
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data.buffer;
}

/**
 * Download a CI artifact and extract .uf2 files.
 * Tries: 1) CORS proxy (if available), 2) direct fetch, 3) returns null for fallback.
 */
export async function downloadArtifact(url, onProgress) {
  const proxy = await isProxyAvailable();

  // Try proxy first (most reliable), then direct
  const attempts = proxy ? [true, false] : [false];
  for (const useProxy of attempts) {
    try {
      const buffer = await fetchWithProgress(url, onProgress, useProxy);
      return extractUF2FromZip(new Uint8Array(buffer));
    } catch {
      // Continue to next attempt
    }
  }
  return null; // All attempts failed — signal fallback
}

/**
 * Download a release asset (.uf2 file).
 * Tries: 1) CORS proxy (if available), 2) direct fetch, 3) returns null for fallback.
 */
export async function downloadReleaseAsset(url, onProgress) {
  const proxy = await isProxyAvailable();

  const attempts = proxy ? [true, false] : [false];
  for (const useProxy of attempts) {
    try {
      const buffer = await fetchWithProgress(url, onProgress, useProxy);
      return { data: buffer };
    } catch {
      // Continue to next attempt
    }
  }
  return null; // All attempts failed — signal fallback
}

/**
 * Open a release asset URL in a new browser tab for manual download.
 */
export function openDownloadUrl(url) {
  window.open(url, '_blank');
}

/**
 * Extract .uf2 files from a zip archive (Uint8Array or ArrayBuffer).
 * Returns: [{ name: string, data: ArrayBuffer }]
 */
export function extractUF2FromZip(zipData) {
  const data = zipData instanceof Uint8Array ? zipData : new Uint8Array(zipData);
  const extracted = unzipSync(data);
  const uf2Files = [];

  for (const [path, fileData] of Object.entries(extracted)) {
    if (path.endsWith('.uf2')) {
      uf2Files.push({
        name: path.split('/').pop(),
        data: fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength),
      });
    }
  }

  if (uf2Files.length === 0) {
    throw new Error('No .uf2 files found in archive');
  }

  return uf2Files;
}

/**
 * Format a date string for display.
 */
export function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format bytes to human-readable size.
 */
export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
