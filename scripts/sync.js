#!/usr/bin/env node
/**
 * Reads your udrop.com account, resolves a real direct-download link for
 * every file, builds a .zip for every folder (recursively), uploads the
 * zips as assets on a fixed GitHub Release, and writes files.json for the
 * static site to read. Everything happens here in Actions — the browser
 * never talks to udrop and never sees your API keys.
 *
 * Env (all provided automatically except the two UDROP_ ones):
 *   UDROP_KEY1, UDROP_KEY2   required — set as repo Actions secrets
 *   GITHUB_TOKEN             auto-provided by Actions
 *   GITHUB_REPOSITORY        auto-provided by Actions ("owner/repo")
 *   ROOT_FOLDER_ID           optional, only publish this folder + children
 *
 * Costs of this approach vs. a live backend: every run that finds changes
 * re-downloads every file and rebuilds every zip from scratch. Fine for a
 * modest drive of scripts/PDFs; would get slow on a very large one.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import archiver from 'archiver';

const API = 'https://www.udrop.com/api/v2';
const KEY1 = process.env.UDROP_KEY1;
const KEY2 = process.env.UDROP_KEY2;
const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || '').split('/');
const RELEASE_TAG = 'file-zips';
const OUT = 'files.json';
const CACHE = '.udrop-cache';

if (!KEY1 || !KEY2) {
  console.error('UDROP_KEY1 and/or UDROP_KEY2 are not set.');
  process.exit(1);
}
if (!GITHUB_TOKEN || !OWNER || !REPO_NAME) {
  console.error('GITHUB_TOKEN / GITHUB_REPOSITORY not available (are you running this outside Actions?).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sanitize = (s) => (s || 'root').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80) || 'root';

// ---- udrop API -------------------------------------------------------

async function api(path, params = {}, attempt = 0) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (res.status === 429 && attempt < 3) {
    const wait = 5 * (attempt + 1);
    console.warn(`Rate limited on ${path}; waiting ${wait}s`);
    await sleep(wait * 1000);
    return api(path, params, attempt + 1);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json._status === 'error') {
    throw new Error(`${path} -> ${json?.response || `HTTP ${res.status}`}`);
  }
  return json;
}

const authorize = async () => (await api('/authorize', { key1: KEY1, key2: KEY2 })).data;

const listFolder = async (auth, folderId) =>
  (await api('/folder/listing', {
    access_token: auth.access_token,
    account_id: auth.account_id,
    ...(folderId ? { parent_folder_id: folderId } : {}),
  })).data;

const fileDownloadUrl = async (auth, fileId) =>
  (await api('/file/download', {
    access_token: auth.access_token,
    account_id: auth.account_id,
    file_id: fileId,
  })).data.download_url;

/** Walk the whole tree, building both the flat list (for files.json) and a
 *  nested tree (for zipping), in one pass. */
async function walk(auth, folderId, trail, treeNode, flatOut) {
  const { folders = [], files = [] } = await listFolder(auth, folderId);

  for (const folder of folders) {
    const childTree = { id: folder.id, name: folder.folderName, children: [] };
    treeNode.children.push(childTree);
    flatOut.push({
      id: folder.id,
      name: folder.folderName,
      folder: true,
      path: trail,
      size: null,
      extension: null,
      modified: folder.date_updated || folder.date_added || null,
      description: null,
    });
    await walk(auth, folder.id, [...trail, folder.folderName], childTree, flatOut);
  }

  for (const file of files) {
    const downloadUrl = await fileDownloadUrl(auth, file.id);
    treeNode.children.push({ id: file.id, name: file.filename, isFile: true, downloadUrl });
    flatOut.push({
      id: file.id,
      name: file.filename,
      folder: false,
      path: trail,
      size: Number(file.fileSize) || 0,
      extension: file.extension || null,
      modified: null,
      description: file.keywords || null,
      downloadUrl,
    });
  }
}

// ---- local caching + zipping ------------------------------------------

async function downloadToCache(node) {
  const cachePath = join(CACHE, String(node.id));
  if (existsSync(cachePath)) return cachePath;
  const res = await fetch(node.downloadUrl);
  if (!res.ok) throw new Error(`download failed for ${node.name}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(cachePath));
  return cachePath;
}

/** Every file under `node`, recursively, with a path relative to `node`. */
function collectFiles(node, prefix, out) {
  for (const c of node.children) {
    if (c.isFile) out.push({ ...c, zipPath: prefix + c.name });
    else collectFiles(c, prefix + c.name + '/', out);
  }
  return out;
}

async function buildZip(node, key) {
  const files = collectFiles(node, '', []);
  if (!files.length) return null;

  const zipPath = join(CACHE, `${sanitize(key)}.zip`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const finished = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);

  for (const f of files) {
    const cached = await downloadToCache(f);
    archive.file(cached, { name: f.zipPath });
  }
  await archive.finalize();
  await finished;
  return zipPath;
}

// ---- GitHub Releases (used as static file hosting for the zips) -------

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.status === 204 ? null : res.json();
}

async function getOrCreateRelease() {
  try {
    return await gh(`/repos/${OWNER}/${REPO_NAME}/releases/tags/${RELEASE_TAG}`);
  } catch {
    return gh(`/repos/${OWNER}/${REPO_NAME}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        name: 'File zips (auto-generated)',
        body: 'Generated by sync.js. Do not edit or delete manually — it will be recreated on the next run.',
        prerelease: true,
      }),
    });
  }
}

async function uploadAsset(release, name, filePath) {
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) await gh(`/repos/${OWNER}/${REPO_NAME}/releases/assets/${existing.id}`, { method: 'DELETE' });

  const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(name)}`);
  const body = await readFile(filePath);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/zip' },
    body,
  });
  if (!res.ok) throw new Error(`asset upload failed for ${name}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()).browser_download_url;
}

/** Recursively zip + upload every folder in the tree, attaching zipAsset
 *  onto each matching entry in the flat list. */
async function zipAndPublishAll(tree, flatByKey, release) {
  async function visit(node, key) {
    const zipPath = await buildZip(node, key || 'root');
    if (zipPath) {
      const assetName = `${sanitize(key || 'root')}.zip`;
      const url = await uploadAsset(release, assetName, zipPath);
      const entry = flatByKey.get(key);
      if (entry) entry.zipAsset = url;
      else flatByKey.set('', { zipAsset: url }); // root
    }
    for (const c of node.children) {
      if (!c.isFile) await visit(c, key ? `${key}/${c.name}` : c.name);
    }
  }
  await visit(tree, '');
}

// ---- main ---------------------------------------------------------------

const auth = await authorize();
const flat = [];
const tree = { id: ROOT_FOLDER_ID, name: 'root', children: [] };
await walk(auth, ROOT_FOLDER_ID, [], tree, flat);

flat.sort((a, b) => {
  if (a.folder !== b.folder) return a.folder ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
});

// download_url tokens are per-run and may expire, so files.json (and its
// links) get rewritten on EVERY run, even when nothing else changed. Only
// the expensive part — downloading every file's bytes and rebuilding zips —
// is skipped when the folder structure itself hasn't changed.
const prevRaw = await readFile(OUT, 'utf8').catch(() => '');
let prevParsed = null;
try { prevParsed = JSON.parse(prevRaw); } catch { /* no previous file, or unreadable */ }

const comparable = (list) =>
  JSON.stringify((list || []).map(({ id, name, folder, path, size }) => ({ id, name, folder, path, size })));
const structureChanged = comparable(prevParsed?.files) !== comparable(flat);

let rootZip = prevParsed?.rootZip || null;
const prevZipByKey = new Map(
  (prevParsed?.files || [])
    .filter((f) => f.folder)
    .map((f) => [[...(f.path || []), f.name].join('/'), f.zipAsset || null])
);

if (structureChanged || !prevParsed) {
  await rm(CACHE, { recursive: true, force: true });
  await mkdir(CACHE, { recursive: true });

  const release = await getOrCreateRelease();
  const flatByKey = new Map();
  for (const f of flat) {
    if (f.folder) flatByKey.set([...(f.path || []), f.name].join('/'), f);
  }
  await zipAndPublishAll(tree, flatByKey, release);

  for (const f of flat) {
    if (f.folder) f.zipAsset = flatByKey.get([...(f.path || []), f.name].join('/'))?.zipAsset || null;
  }
  rootZip = flatByKey.get('')?.zipAsset || rootZip;

  await rm(CACHE, { recursive: true, force: true });
  console.log('Folder contents changed — rebuilt zips.');
} else {
  // Structure unchanged: carry forward the existing zip asset URLs untouched
  // (they're still correct — zips don't depend on udrop tokens) and only
  // refresh each file's download link.
  for (const f of flat) {
    if (f.folder) f.zipAsset = prevZipByKey.get([...(f.path || []), f.name].join('/')) || null;
  }
  console.log('Folder contents unchanged — reused existing zips, refreshed file links only.');
}

await writeFile(OUT, JSON.stringify({
  files: flat,
  rootZip,
  generated: new Date().toISOString(),
}, null, 2) + '\n');

console.log(`Wrote ${flat.length} entries to ${OUT}.`);
