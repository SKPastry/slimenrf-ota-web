// GitHub Release & Actions artifact firmware download module.
//
// - Releases: list via API (CORS OK), download via proxy or browser link
// - Artifacts: list via API (CORS OK), download via proxy or nightly.link
// - Zip extraction via fflate
// - When deployed on Cloudflare Pages, uses /api/proxy for CORS-free downloads

import { unzipSync } from 'fflate';

// ── Configuration ────────────────────────────────────────────────────

const TRACKER_OWNER = 'SKPastry';
const RECEIVER_OWNER = 'SKPastry';
const TRACKER_REPO = 'SlimeVR-Tracker-nRF';
const RECEIVER_REPO = 'SlimeVR-Tracker-nRF-Receiver';
const TRACKER_API_BASE = `https://api.github.com/repos/${TRACKER_OWNER}/${TRACKER_REPO}`;
const RECEIVER_API_BASE = `https://api.github.com/repos/${RECEIVER_OWNER}/${RECEIVER_REPO}`;
const TRACKER_NIGHTLY_LINK = `https://nightly.link/${TRACKER_OWNER}/${TRACKER_REPO}`;
const RECEIVER_NIGHTLY_LINK = `https://nightly.link/${RECEIVER_OWNER}/${RECEIVER_REPO}`;

// Only show tracker CI runs with run_number ≥ this value
const MIN_RUN_NUMBER = 1;
// Only show receiver CI runs with run_number ≥ this value
const MIN_RECEIVER_RUN_NUMBER = 1;
const CI_RUN_LIST_LIMIT = 10;
const CI_RUN_EVENTS = ['push', 'workflow_dispatch'];

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
    if (!resp.ok || !resp.headers.get('content-type')?.includes('application/json')) {
      _proxyAvailable = false;
      return false;
    }
    const status = await resp.json();
    _proxyAvailable = status?.service === 'slimenrf-ota-proxy';
  } catch {
    _proxyAvailable = false;
  }
  return _proxyAvailable;
}

// ── Release API ──────────────────────────────────────────────────────

/**
 * Fetch releases from GitHub API.
 * Keeps all published releases from the configured tracker repository.
 * Returns both tracker and receiver assets, tagged with `type`.
 * Returns: [{ tag, name, date, prerelease, assets: [{ name, size, downloadUrl, type }] }]
 */
export async function fetchReleases() {
  const resp = await fetch(`${TRACKER_API_BASE}/releases?per_page=20`);
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();

  return data
    .filter((r) => !r.draft)
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

async function fetchSuccessfulCIRuns(apiBase, minRunNumber) {
  const runLists = await Promise.all(
    CI_RUN_EVENTS.map(async (event) => {
      const params = new URLSearchParams({
        event,
        status: 'success',
        per_page: String(CI_RUN_LIST_LIMIT),
      });
      const resp = await fetch(`${apiBase}/actions/runs?${params}`);
      if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
      const data = await resp.json();
      return data.workflow_runs || [];
    })
  );

  const seen = new Set();
  return runLists
    .flat()
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return r.run_number >= minRunNumber;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, CI_RUN_LIST_LIMIT)
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
 * Fetch successful tracker CI runs across all branches.
 * Includes automated push builds and manually dispatched workflow runs.
 * Returns: [{ id, number, title, date, sha, branch }]
 */
export async function fetchCIRuns() {
  return fetchSuccessfulCIRuns(TRACKER_API_BASE, MIN_RUN_NUMBER);
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
 * Fetch successful receiver CI runs across all branches.
 * Includes automated push builds and manually dispatched workflow runs.
 * Returns: [{ id, number, title, date, sha, branch }]
 */
export async function fetchReceiverCIRuns() {
  return fetchSuccessfulCIRuns(RECEIVER_API_BASE, MIN_RECEIVER_RUN_NUMBER);
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
/**
 * Extract firmware files (.uf2, .hex) from a ZIP archive.
 * When both .uf2 and .hex exist with the same base name, prefer .uf2.
 * @param {Uint8Array|ArrayBuffer} zipData
 * @returns {{ name: string, data: ArrayBuffer }[]}
 */
export function extractUF2FromZip(zipData) {
  const data = zipData instanceof Uint8Array ? zipData : new Uint8Array(zipData);
  const extracted = unzipSync(data);
  const fwExtensions = ['.uf2', '.hex'];

  // Collect all firmware files grouped by base name
  const byBaseName = new Map(); // baseName → { uf2?: entry, hex?: entry }
  for (const [path, fileData] of Object.entries(extracted)) {
    const lower = path.toLowerCase();
    const ext = fwExtensions.find(e => lower.endsWith(e));
    if (!ext) continue;

    const fileName = path.split('/').pop();
    const baseName = fileName.replace(/\.(uf2|hex)$/i, '');
    const entry = {
      name: fileName,
      data: fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength),
    };

    if (!byBaseName.has(baseName)) byBaseName.set(baseName, {});
    const group = byBaseName.get(baseName);
    if (ext === '.uf2') group.uf2 = entry;
    else group.hex = entry;
  }

  // Prefer .uf2 when both exist; fall back to .hex
  const firmwareFiles = [];
  for (const group of byBaseName.values()) {
    firmwareFiles.push(group.uf2 || group.hex);
  }

  if (firmwareFiles.length === 0) {
    throw new Error('No firmware files (.uf2/.hex) found in archive');
  }

  return firmwareFiles;
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
