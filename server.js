'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'music'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIXES_DIR = path.join(MUSIC_DIR, '.mixes');
const STORE_DIR = path.join(MUSIC_DIR, '.store');
const DUPES_DIR = path.join(MUSIC_DIR, '.dupes-backup');
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const PLAYLISTS_FILE = process.env.PLAYLISTS_FILE || path.join(__dirname, 'playlists.json');
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));
const ART_CACHE_DIR = path.join(CACHE_DIR, 'art');
const META_CACHE_FILE = path.join(CACHE_DIR, 'metadata.json');
const LIBRARY_FILE = path.join(CACHE_DIR, 'library.json');
const PATHMAP_FILE = path.join(CACHE_DIR, 'pathmap.json');
const HISTORY_FILE = path.join(CACHE_DIR, 'history.json');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MB_UA = 'Aria/1.0 (self-hosted personal music player; contact: none)';

const AUDIO_EXT = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.webm': 'audio/webm',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function extOf(name) { return path.extname(name).toLowerCase(); }

function listSongs(dir, base = dir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      out = out.concat(listSongs(path.join(dir, entry.name), base));
    } else if (AUDIO_EXT[extOf(entry.name)]) {
      out.push(path.relative(base, path.join(dir, entry.name)));
    }
  }
  return out;
}

function prettify(rel) { return path.basename(rel, path.extname(rel)).replace(/_/g, ' ').trim(); }

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const type = STATIC_TYPES[extOf(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveAudio(req, res, absPath) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const total = stat.size;
    const type = AUDIO_EXT[extOf(absPath)] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return; }
      let start = match[1] === '' ? 0 : parseInt(match[1], 10);
      let end = match[2] === '' ? total - 1 : parseInt(match[2], 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return; }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(absPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': total, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(absPath).pipe(res);
    }
  });
}

function readJsonBody(req, cb) {
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) { aborted = true; req.destroy(); } });
  req.on('end', () => {
    if (aborted) return cb(new Error('Request body too large'));
    try { cb(null, JSON.parse(body || '{}')); } catch { cb(new Error('Invalid JSON')); }
  });
  req.on('error', cb);
}

function isYouTubeUrl(raw) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  return host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be';
}

function isSoundCloudUrl(raw) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '').toLowerCase();
  return host === 'soundcloud.com';
}

function isMixcloudUrl(raw) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '').toLowerCase();
  return host === 'mixcloud.com';
}

function isValidDownloadUrl(raw) { return isYouTubeUrl(raw) || isSoundCloudUrl(raw); }

function ensureCacheDirs() { try { fs.mkdirSync(ART_CACHE_DIR, { recursive: true }); } catch {} }
function ensureMixesDir() { try { fs.mkdirSync(MIXES_DIR, { recursive: true }); } catch {} }
function ensureStoreDirs() { try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch {} try { fs.mkdirSync(DUPES_DIR, { recursive: true }); } catch {} }

let metaCache = {};
let metaCacheDirty = false;

function loadMetaCache() { try { metaCache = JSON.parse(fs.readFileSync(META_CACHE_FILE, 'utf8')); } catch { metaCache = {}; } }

function saveMetaCache() {
  if (!metaCacheDirty) return;
  try { ensureCacheDirs(); fs.writeFileSync(META_CACHE_FILE, JSON.stringify(metaCache)); metaCacheDirty = false; } catch {}
}

function probeTags(absPath) {
  try {
    const r = spawnSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', absPath], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 15000 });
    if (r.status !== 0 || !r.stdout) return {};
    const data = JSON.parse(r.stdout);
    const rawTags = (data.format && data.format.tags) || {};
    const tags = {};
    for (const k of Object.keys(rawTags)) tags[k.toLowerCase()] = rawTags[k];
    let lyrics = '';
    for (const k of Object.keys(tags)) { if (k === 'lyrics' || k.startsWith('lyrics-') || k.startsWith('lyrics ')) { lyrics = tags[k]; break; } }
    const duration = data.format && data.format.duration ? Math.round(parseFloat(data.format.duration)) : 0;
    return { title: (tags.title || '').trim(), artist: (tags.artist || tags.album_artist || '').trim(), album: (tags.album || '').trim(), duration, embeddedLyrics: (lyrics || '').trim() };
  } catch { return {}; }
}

function getMetadata(rel, absPath, stat) {
  const cached = metaCache[rel];
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
  const tags = probeTags(absPath);
  const entry = {
    size: stat.size, mtimeMs: stat.mtimeMs,
    title: tags.title || '', artist: tags.artist || '', album: tags.album || '',
    duration: tags.duration || 0, embeddedLyrics: tags.embeddedLyrics || '',
    lyricsFetched: false, lyricsSource: '', plainLyrics: '', syncedLyrics: '',
  };
  metaCache[rel] = entry;
  metaCacheDirty = true;
  return entry;
}

let library = null;
let pathmap = {};

function loadLibrary() {
  try { library = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')); } catch { library = null; }
  if (!library || !Array.isArray(library.tracks)) library = null;
  if (library) {
    library.tracks.forEach((t) => { t.owners = (t.owners || []).map((o) => (o === 'shared' ? '__shared__' : o)); });
  }
}

function saveLibrary() { try { fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2)); } catch {} }
function loadPathmap() { try { pathmap = JSON.parse(fs.readFileSync(PATHMAP_FILE, 'utf8')); } catch { pathmap = {}; } }
function savePathmap() { try { fs.writeFileSync(PATHMAP_FILE, JSON.stringify(pathmap)); } catch {} }

function normKeyPart(s) { return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim(); }

function dedupKey(title, artist, filename) {
  const t = normKeyPart(title);
  const a = normKeyPart(artist);
  if (t) return a + '::' + t;
  return 'file::' + normKeyPart(filename);
}

function runMigrationIfNeeded() {
  loadPathmap();
  loadLibrary();
  if (library) return;
  try {
    ensureStoreDirs();
    const files = [];
    const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && AUDIO_EXT[extOf(e.name)]) files.push({ rel: e.name, owner: '__shared__' });
      else if (e.isDirectory() && !e.name.startsWith('.')) {
        const walk = (dir) => {
          let ces; try { ces = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const ce of ces) {
            const full = path.join(dir, ce.name);
            if (ce.isDirectory()) walk(full);
            else if (AUDIO_EXT[extOf(ce.name)]) files.push({ rel: path.relative(MUSIC_DIR, full), owner: e.name });
          }
        };
        walk(path.join(MUSIC_DIR, e.name));
      }
    }
    const groups = new Map();
    for (const f of files) {
      const abs = path.join(MUSIC_DIR, f.rel);
      let stat = null; try { stat = fs.statSync(abs); } catch {}
      if (!stat) continue;
      const meta = getMetadata(f.rel, abs, stat);
      const key = dedupKey(meta.title || prettify(f.rel), meta.artist, f.rel);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ rel: f.rel, owner: f.owner, stat, meta });
    }
    const tracks = [];
    for (const list of groups.values()) {
      list.sort((a, b) => b.stat.size - a.stat.size);
      const primary = list[0];
      const ext = extOf(primary.rel);
      const id = crypto.randomBytes(8).toString('hex');
      const newRel = path.join('.store', id + ext);
      fs.renameSync(path.join(MUSIC_DIR, primary.rel), path.join(MUSIC_DIR, newRel));
      if (metaCache[primary.rel]) { metaCache[newRel] = metaCache[primary.rel]; metaCacheDirty = true; }
      const owners = [];
      for (const item of list) { if (!owners.includes(item.owner)) owners.push(item.owner); }
      for (const item of list) {
        pathmap[item.rel] = newRel;
        if (item !== primary) {
          const flat = item.rel.split(path.sep).join(' ');
          try { fs.renameSync(path.join(MUSIC_DIR, item.rel), path.join(DUPES_DIR, flat)); } catch {}
        }
      }
      tracks.push({ id, file: newRel, title: primary.meta.title || prettify(primary.rel), artist: primary.meta.artist || '', album: primary.meta.album || '', duration: primary.meta.duration || 0, added: primary.stat.mtimeMs, owners });
    }
    library = { tracks };
    saveLibrary(); savePathmap(); saveMetaCache();
    const pls = readPlaylists();
    pls.forEach((pl) => { pl.songs = pl.songs.map((p) => pathmap[p] || p); });
    writePlaylists(pls);
    console.log('[library] migrated ' + tracks.length + ' unique tracks from ' + files.length + ' files.');
  } catch (e) {
    console.log('[library] migration failed, falling back to folder scan: ' + e.message);
    library = null;
  }
}

function downloadAudio(url, ownerKey, cb) {
  ensureStoreDirs();
  const tmpName = '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpTemplate = path.join(STORE_DIR, tmpName + '.%(ext)s');
  const ytArgs = isYouTubeUrl(url) ? ['--extractor-args', 'youtube:player_client=android'] : [];
  const args = [...ytArgs, '-f', 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[ext=ogg]/bestaudio/best', '-x', '--audio-quality', '0', '--embed-thumbnail', '--embed-metadata', '--no-playlist', '--no-progress', '--no-simulate', '--print', 'after_move:filepath', '-o', tmpTemplate, url];
  let stdout = ''; let stderr = ''; let done = false;
  const finish = (err, result) => { if (!done) { done = true; cb(err, result); } };
  const child = spawn(YTDLP, args);
  child.on('error', (e) => finish(new Error(e.code === 'ENOENT' ? 'yt-dlp not found.' : 'Could not start yt-dlp: ' + e.message)));
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => {
    if (code !== 0) return finish(new Error(stderr.trim().split('\n').filter(Boolean).pop() || 'download failed'));
    const filepath = stdout.trim().split('\n').filter(Boolean).pop();
    if (!filepath) return finish(new Error('Download finished but no file was produced.'));
    try {
      const tmpRel = path.relative(MUSIC_DIR, filepath);
      const stat = fs.statSync(filepath);
      const tags = probeTags(filepath);
      const key = dedupKey(tags.title || prettify(tmpRel), tags.artist, tmpRel);
      if (library) {
        const existing = library.tracks.find((t) => dedupKey(t.title, t.artist, t.file) === key);
        if (existing) {
          try { fs.unlinkSync(filepath); } catch {}
          if (!existing.owners.includes(ownerKey)) existing.owners.push(ownerKey);
          saveLibrary();
          const enc = existing.file.split(path.sep).map(encodeURIComponent).join('/');
          return finish(null, { ok: true, title: existing.title || prettify(existing.file), url: '/music/' + enc, path: existing.file, profile: ownerKey === '__shared__' ? null : ownerKey, already: true });
        }
      }
      const id = crypto.randomBytes(8).toString('hex');
      const newRel = path.join('.store', id + extOf(filepath));
      fs.renameSync(filepath, path.join(MUSIC_DIR, newRel));
      metaCache[newRel] = { size: stat.size, mtimeMs: stat.mtimeMs, title: tags.title || '', artist: tags.artist || '', album: tags.album || '', duration: tags.duration || 0, embeddedLyrics: tags.embeddedLyrics || '', lyricsFetched: false, lyricsSource: '', plainLyrics: '', syncedLyrics: '' };
      metaCacheDirty = true;
      if (library) {
        library.tracks.push({ id, file: newRel, title: tags.title || prettify(newRel), artist: tags.artist || '', album: tags.album || '', duration: tags.duration || 0, added: Date.now(), owners: [ownerKey] });
        saveLibrary();
      }
      saveMetaCache();
      const enc = newRel.split(path.sep).map(encodeURIComponent).join('/');
      finish(null, { ok: true, title: tags.title || prettify(newRel), url: '/music/' + enc, path: newRel, profile: ownerKey === '__shared__' ? null : ownerKey });
    } catch (e) { finish(new Error('Could not finalize download: ' + e.message)); }
  });
}

function downloadMix(url, cb) {
  try { fs.mkdirSync(MIXES_DIR, { recursive: true }); } catch (e) { cb(new Error('Could not create mixes folder: ' + e.message)); return; }
  const args = ['-f', 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best', '-x', '--audio-quality', '0', '--embed-thumbnail', '--embed-metadata', '--no-playlist', '--no-progress', '--no-simulate', '--print', 'after_move:filepath', '-o', path.join(MIXES_DIR, '%(title)s.%(ext)s'), url];
  let stdout = ''; let stderr = ''; let done = false;
  const finish = (err, result) => { if (!done) { done = true; cb(err, result); } };
  const child = spawn(YTDLP, args);
  child.on('error', (e) => finish(new Error(e.code === 'ENOENT' ? 'yt-dlp not found.' : 'Could not start yt-dlp: ' + e.message)));
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => {
    if (code !== 0) return finish(new Error(stderr.trim().split('\n').filter(Boolean).pop() || 'mix download failed'));
    const filepath = stdout.trim().split('\n').filter(Boolean).pop();
    if (!filepath) return finish(new Error('Download finished but no file was produced.'));
    const rel = path.relative(MUSIC_DIR, filepath);
    finish(null, { ok: true, title: prettify(rel), url: '/music/' + rel.split(path.sep).map(encodeURIComponent).join('/'), path: rel });
  });
}

function stripYoutubeNoise(title) {
  return title.replace(/\s*[\[(]\s*(official\s*(video|audio|music\s*video|lyric\s*video|visualizer)?|lyrics?|hd|4k)\s*[\])]/gi, '').replace(/\s*[-–]\s*topic\s*$/i, '').trim();
}

function cleanTitleForQuery(rawTitle, artist) {
  let t = stripYoutubeNoise(rawTitle || '');
  if (artist) {
    const escaped = artist.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('^' + escaped + '\\s*[-–]\\s*', 'i'), '');
  }
  return t.trim();
}

function cleanForApi(text) {
  return (text || '').replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
}

function normalizeQueryText(text) {
  return cleanForApi(text || '').replace(/([^)]*)/g, '$1').replace(/[[^\]]*]/g, '')
    .replace(/\b(official|audio|video|music video|lyric video|lyrics|visualizer|hd|4k|remaster(ed)?|deluxe|version|edit|single|mix|live|performance|concert|topic)\b/gi, ' ')
    .replace(/[|/\\:*?"<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function primaryArtist(artist) {
  if (!artist) return '';
  let a = cleanForApi(artist);
  a = a.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0];
  a = a.split(/\s*[&,]\s*/)[0];
  a = a.split(/\s+x\s+/i)[0];
  return a.trim();
}

function parseArtistTitleFromName(name) {
  const cleaned = cleanForApi(name || '').replace(/^\s*\d{1,3}[\s.-]+/, '').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { artist, title };
  }
  return null;
}

function buildLyricsQueries(meta, rel) {
  const queries = [];
  const seen = new Set();
  const add = (artist, title) => {
    const a = primaryArtist(artist);
    const t = normalizeQueryText(title);
    if (!a || !t) return;
    const key = a.toLowerCase() + '::' + t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ artist: a, title: t });
  };
  const fileBase = cleanForApi(path.basename(rel, path.extname(rel))).replace(/_/g, ' ').replace(/^\s*\d{1,3}[\s.-]+/, '').trim();
  const parsedFile = parseArtistTitleFromName(fileBase);
  add(meta.artist || '', meta.title || '');
  add(meta.artist || '', meta.title ? meta.title.replace(/([^)]*)/g, '$1') : '');
  if (parsedFile) { add(parsedFile.artist, parsedFile.title); if (meta.artist) add(meta.artist, parsedFile.title); }
  if (meta.artist) add(meta.artist, fileBase);
  return queries.slice(0, 6);
}

function normalizeMatchText(text) {
  return cleanForApi(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/([^)]*)/g, '$1').replace(/[[^\]]*]/g, '')
    .replace(/\b(official|audio|video|music video|lyric video|lyrics|visualizer|hd|4k|remaster(ed)?|deluxe|version|edit|single|mix|live|performance|concert|topic)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSimilarity(a, b) {
  const tokensA = normalizeMatchText(a).split(' ').filter(Boolean);
  const tokensB = normalizeMatchText(b).split(' ').filter(Boolean);
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) { if (setB.has(token)) intersection++; }
  const union = setA.size + setB.size - intersection;
  if (!union) return 0;
  return (intersection / union + intersection / Math.min(setA.size, setB.size)) / 2;
}

function artMatchScore(candidateTitle, candidateArtist, q) {
  const titleScore = tokenSimilarity(candidateTitle || '', q.title || '');
  const artistScore = q.artist ? tokenSimilarity(candidateArtist || '', q.artist || '') : 0;
  const score = q.artist ? titleScore * 0.65 + artistScore * 0.35 : titleScore;
  return { score, titleScore, artistScore };
}

function isGoodArtMatch(match, q) {
  if (!match) return false;
  if (q.artist) return match.score >= 0.60 && match.titleScore >= 0.48 && match.artistScore >= 0.32;
  return match.score >= 0.78 && match.titleScore >= 0.78;
}

function buildArtQueries(meta, rel) {
  const queries = [];
  const seen = new Set();
  const add = (artist, title) => {
    const a = primaryArtist(artist);
    const t = normalizeQueryText(title);
    if (!a || !t) return;
    const key = a.toLowerCase() + '::' + t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ artist: a, title: t });
  };
  const fileBase = cleanForApi(path.basename(rel, path.extname(rel))).replace(/_/g, ' ').replace(/^\s*\d{1,3}[\s.-]+/, '').trim();
  const parsedFile = parseArtistTitleFromName(fileBase);
  add(meta.artist || '', meta.title || '');
  add(meta.artist || '', meta.title ? meta.title.replace(/([^)]*)/g, '$1') : '');
  if (parsedFile) { add(parsedFile.artist, parsedFile.title); if (meta.artist) add(meta.artist, parsedFile.title); }
  if (meta.artist) add(meta.artist, fileBase);
  return queries.slice(0, 5);
}

function parseLrc(lrc) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{2}(?:\.\d+)?)\]/g;
  lrc.split('\n').forEach((line) => {
    const matches = [...line.matchAll(re)];
    if (!matches.length) return;
    const text = line.replace(re, '').trim();
    matches.forEach((m) => { lines.push({ time: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text }); });
  });
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function fetchJsonSmart(urlStr, ua, cb, hops) {
  const left = hops == null ? 3 : hops;
  let done = false;
  const finish = (v, why) => { if (!done) { done = true; cb(v, why); } };
  let u;
  try { u = new URL(urlStr); } catch { finish(null, 'bad-url'); return; }
  const options = { protocol: u.protocol, hostname: u.hostname, path: u.pathname + u.search, family: 4, timeout: 12000, headers: { 'User-Agent': ua || 'Aria/1.0', 'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate, br' } };
  try {
    const req = https.get(options, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && left > 0) {
        res.resume(); done = true;
        fetchJsonSmart(new URL(res.headers.location, urlStr).toString(), ua, cb, left - 1);
        return;
      }
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      let body = '';
      stream.on('data', (d) => { body += d; });
      stream.on('end', () => {
        if (res.statusCode !== 200) {
          console.log('[http] ' + res.statusCode + ' from ' + u.hostname + u.pathname + ' :: ' + body.slice(0, 200).replace(/\s+/g, ' '));
          return finish(null, 'status-' + res.statusCode);
        }
        try { finish(JSON.parse(body), null); } catch { finish(null, 'bad-json'); }
      });
      stream.on('error', (e) => finish(null, 'error-' + e.message));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => finish(null, 'error-' + e.message));
  } catch (e) { finish(null, 'error-' + e.message); }
}

function fetchJsonAsync(urlStr, ua) { return new Promise((resolve) => fetchJsonSmart(urlStr, ua, (data, why) => resolve({ data, why }))); }

async function fetchLyricsOvh(artist, title) {
  try {
    const u = 'https://api.lyrics.ovh/v1/' + encodeURIComponent(artist) + '/' + encodeURIComponent(title);
    const { data } = await fetchJsonAsync(u, null);
    if (data && typeof data.lyrics === 'string' && data.lyrics.trim().length > 0) return data.lyrics.trim();
  } catch {}
  return null;
}

const lyricsMissCache = new Map();
const LYRICS_MISS_TTL = 5 * 60 * 1000;

function healLyricsMeta(meta) {
  const LRC = /[\d{1,2}:\d{2}(?:\.\d+)?]/;
  let changed = false;
  if (meta.syncedLyrics && meta.plainLyrics && LRC.test(meta.plainLyrics) && !LRC.test(meta.syncedLyrics)) {
    const tmp = meta.syncedLyrics; meta.syncedLyrics = meta.plainLyrics; meta.plainLyrics = tmp; changed = true;
  }
  if (!meta.syncedLyrics && meta.plainLyrics && LRC.test(meta.plainLyrics)) {
    meta.syncedLyrics = meta.plainLyrics; meta.plainLyrics = ''; changed = true;
  }
  if (!meta.syncedLyrics && !meta.plainLyrics && meta.embeddedLyrics && LRC.test(meta.embeddedLyrics)) {
    meta.syncedLyrics = meta.embeddedLyrics; changed = true;
  }
  if (changed) metaCacheDirty = true;
  return meta;
}

async function ensureLyricsAsync(rel, absPath, stat, refresh) {
  const meta = getMetadata(rel, absPath, stat);
  const LRC = /[\d{1,2}:\d{2}(?:\.\d+)?]/;
  if (meta.syncedLyrics && meta.plainLyrics && LRC.test(meta.plainLyrics) && !LRC.test(meta.syncedLyrics)) {
    const tmp = meta.syncedLyrics; meta.syncedLyrics = meta.plainLyrics; meta.plainLyrics = tmp; metaCacheDirty = true;
  }
  if (!meta.syncedLyrics && meta.plainLyrics && LRC.test(meta.plainLyrics)) {
    meta.syncedLyrics = meta.plainLyrics; meta.plainLyrics = ''; metaCacheDirty = true;
  }
  if (!meta.syncedLyrics && !meta.plainLyrics && meta.embeddedLyrics && LRC.test(meta.embeddedLyrics)) {
    meta.syncedLyrics = meta.embeddedLyrics; metaCacheDirty = true;
  }
  if (meta.lyricsFetched && (meta.plainLyrics || meta.syncedLyrics || meta.embeddedLyrics)) return meta;
  if (!refresh) {
    const missedAt = lyricsMissCache.get(rel);
    if (missedAt && Date.now() - missedAt < LYRICS_MISS_TTL) return meta;
  }
  lyricsMissCache.delete(rel);
  const setFound = (source, plain, synced) => {
    meta.lyricsSource = source; meta.plainLyrics = plain || ''; meta.syncedLyrics = synced || '';
    meta.lyricsFetched = true; metaCacheDirty = true;
    return meta;
  };
  if (meta.embeddedLyrics) {
    const isSynced = /[\d{1,2}:\d{2}(?:\.\d+)?]/.test(meta.embeddedLyrics);
    return setFound('embedded', isSynced ? '' : meta.embeddedLyrics, isSynced ? meta.embeddedLyrics : '');
  }
  const album = cleanForApi(meta.album);
  const tryGet = async (t, a, dur) => {
    if (!t || !a) return null;
    const params = new URLSearchParams({ track_name: t, artist_name: a });
    if (album) params.set('album_name', album);
    if (dur && dur > 0) params.set('duration', String(dur));
    const { data } = await fetchJsonAsync('https://lrclib.net/api/get?' + params.toString(), null);
    return data && (data.plainLyrics || data.syncedLyrics) ? data : null;
  };
  const trySearch = async (params) => {
    const { data } = await fetchJsonAsync('https://lrclib.net/api/search?' + params.toString(), null);
    if (!Array.isArray(data) || !data.length) return null;
    return data.find((r) => r && r.syncedLyrics) || data.find((r) => r && (r.plainLyrics || r.syncedLyrics)) || null;
  };
  const queries = buildLyricsQueries(meta, rel);
  let result = null;
  if (queries.length) {
    const first = queries[0];
    result = await tryGet(first.title, first.artist, meta.duration);
    if (!result) result = await tryGet(first.title, first.artist, 0);
    if (!result) { const plain = await fetchLyricsOvh(first.artist, first.title); if (plain) return setFound('lyrics.ovh', plain, ''); }
    if (!result) { for (const q of queries.slice(1, 3)) { result = await tryGet(q.title, q.artist, 0); if (result) break; } }
    if (!result) { for (const q of queries.slice(1, 3)) { const plain = await fetchLyricsOvh(q.artist, q.title); if (plain) return setFound('lyrics.ovh', plain, ''); } }
    if (!result) { for (const q of queries.slice(0, 3)) { result = await trySearch(new URLSearchParams({ track_name: q.title, artist_name: q.artist })); if (result) break; } }
    if (!result) result = await trySearch(new URLSearchParams({ q: first.artist + ' ' + first.title }));
    if (result) return setFound('lrclib', result.plainLyrics || '', result.syncedLyrics || '');
  }
  const titleOnly = normalizeQueryText(meta.title || prettify(rel));
  if (titleOnly) {
    result = await trySearch(new URLSearchParams({ q: titleOnly }));
    if (result) return setFound('lrclib', result.plainLyrics || '', result.syncedLyrics || '');
  }
  meta.lyricsSource = 'none'; meta.plainLyrics = ''; meta.syncedLyrics = '';
  meta.lyricsFetched = false; metaCacheDirty = true;
  lyricsMissCache.set(rel, Date.now());
  return meta;
}

function ensureLyrics(rel, absPath, stat, refresh, cb) {
  ensureLyricsAsync(rel, absPath, stat, refresh).then((meta) => cb(meta)).catch(() => cb(getMetadata(rel, absPath, stat)));
}

function hashRel(rel) { return crypto.createHash('sha1').update(rel).digest('hex'); }

function downloadImage(urlStr, dest, cb, hops) {
  let done = false;
  const finish = (ok) => { if (!done) { done = true; cb(ok); } };
  const left = hops == null ? 3 : hops;
  let u; try { u = new URL(urlStr); } catch { finish(false); return; }
  const options = { protocol: u.protocol, hostname: u.hostname, path: u.pathname + u.search, family: 4, timeout: 15000, headers: { 'User-Agent': BROWSER_UA } };
  try {
    const req = https.get(options, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && left > 0) {
        res.resume(); done = true;
        downloadImage(new URL(res.headers.location, urlStr).toString(), dest, cb, left - 1);
        return;
      }
      if (res.statusCode !== 200 || !(res.headers['content-type'] || '').startsWith('image/')) { res.resume(); finish(false); return; }
      const tmp = dest + '.tmp';
      const f = fs.createWriteStream(tmp);
      res.pipe(f);
      f.on('finish', () => { f.close(() => { try { fs.renameSync(tmp, dest); finish(true); } catch { finish(false); } }); });
      f.on('error', () => finish(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(false));
  } catch { finish(false); }
}

async function fetchItunesArtwork(q) {
  const term = cleanForApi(q.artist + ' ' + q.title).trim();
  if (!term) return null;
  const apiUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&media=music&entity=song&limit=10';
  const { data } = await fetchJsonAsync(apiUrl, BROWSER_UA);
  if (!data || !Array.isArray(data.results)) return null;
  let best = null;
  for (const r of data.results) {
    const art = r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : null;
    if (!art) continue;
    const match = artMatchScore(r.trackName || '', r.artistName || '', q);
    if (!isGoodArtMatch(match, q)) continue;
    if (!best || match.score > best.score) best = Object.assign({ url: art, source: 'itunes' }, match);
  }
  return best;
}

async function fetchDeezerArtwork(q) {
  const artist = cleanForApi(q.artist || '').replace(/"/g, '').trim();
  const title = cleanForApi(q.title || '').replace(/"/g, '').trim();
  if (!artist || !title) return null;
  const query = `artist:"${artist}" track:"${title}"`;
  const apiUrl = 'https://api.deezer.com/search?q=' + encodeURIComponent(query) + '&limit=5';
  const { data } = await fetchJsonAsync(apiUrl, BROWSER_UA);
  const items = data && Array.isArray(data.data) ? data.data : [];
  let best = null;
  for (const r of items) {
    const art = r.album && (r.album.cover_big || r.album.cover_medium || r.album.cover);
    if (!art) continue;
    const match = artMatchScore(r.title || '', (r.artist && r.artist.name) || '', q);
    if (!isGoodArtMatch(match, q)) continue;
    if (!best || match.score > best.score) best = Object.assign({ url: art, source: 'deezer' }, match);
  }
  return best;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

let lastMbRequest = 0;
async function fetchMusicBrainzArtwork(q) {
  if (!q.artist || !q.title) return null;
  const clean = (s) => cleanForApi(s || '').replace(/["\\]/g, ' ').trim();
  const query = 'recording: "' + clean(q.title) + '" AND artist: "' + clean(q.artist) + '"';
  const wait = Math.max(0, 1100 - (Date.now() - lastMbRequest));
  if (wait) await sleep(wait);
  lastMbRequest = Date.now();
  const url = 'https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&inc=releases&query=' + encodeURIComponent(query);
  const { data } = await fetchJsonAsync(url, MB_UA);
  const recordings = data && Array.isArray(data.recordings) ? data.recordings : [];
  for (const rec of recordings) {
    const rel = rec && rec.releases && rec.releases[0];
    if (rel && rel.id) return { url: 'https://coverartarchive.org/release/' + rel.id + '/front-500', source: 'musicbrainz', score: 1, titleScore: 1, artistScore: 1 };
  }
  return null;
}

async function findOnlineArtwork(meta, rel) {
  const queries = buildArtQueries(meta, rel);
  if (!queries.length) return null;
  for (const q of queries.slice(0, 2)) { try { const m = await fetchItunesArtwork(q); if (m) return m; } catch {} }
  for (const q of queries.slice(0, 2)) { try { const m = await fetchDeezerArtwork(q); if (m) return m; } catch {} }
  for (const q of queries.slice(0, 1)) { try { const m = await fetchMusicBrainzArtwork(q); if (m) return m; } catch {} }
  return null;
}

const artLookupInFlight = new Map();
function findOnlineArtworkWithDedupe(rel, meta) {
  if (artLookupInFlight.has(rel)) return artLookupInFlight.get(rel);
  const p = findOnlineArtwork(meta, rel).then(
    (value) => { artLookupInFlight.delete(rel); return value; },
    (err) => { artLookupInFlight.delete(rel); throw err; }
  );
  artLookupInFlight.set(rel, p);
  return p;
}

function serveArt(res, rel, refresh, preferEmbedded) {
  const absPath = path.join(MUSIC_DIR, rel);
  if (!absPath.startsWith(MUSIC_DIR + path.sep) && absPath !== MUSIC_DIR) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
  ensureCacheDirs();
  const h = hashRel(rel);
  const cachedImg = path.join(ART_CACHE_DIR, h + '.artv2.jpg');
  const noArtMarker = path.join(ART_CACHE_DIR, h + '.artv2.noart');
  const sendFile = (filePath) => {
    fs.stat(filePath, (err, stat) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
      fs.createReadStream(filePath).pipe(res);
    });
  };
  if (refresh) { try { fs.unlinkSync(cachedImg); } catch {} try { fs.unlinkSync(noArtMarker); } catch {} }
  if (fs.existsSync(cachedImg)) { sendFile(cachedImg); return; }
  if (fs.existsSync(noArtMarker)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('No artwork'); return; }
  let stat = null; try { stat = fs.statSync(absPath); } catch {}
  if (!stat) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  const meta = getMetadata(rel, absPath, stat);
  const extractEmbedded = (cb) => {
    const tmp = path.join(ART_CACHE_DIR, h + '.' + process.pid + '.tmp.jpg');
    let r;
    try { r = spawnSync(FFMPEG, ['-y', '-i', absPath, '-an', '-vcodec', 'mjpeg', '-vframes', '1', tmp], { timeout: 15000 }); } catch { r = { status: 1 }; }
    if (r.status === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) { try { fs.renameSync(tmp, cachedImg); cb(true); } catch { cb(false); } }
    else { try { fs.unlinkSync(tmp); } catch {} cb(false); }
  };
  const embeddedFallback = () => {
    extractEmbedded((ok) => {
      if (ok) { console.log('[art] embedded thumbnail for ' + rel); sendFile(cachedImg); }
      else {
        try { fs.writeFileSync(noArtMarker, ''); } catch {}
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No artwork');
      }
    });
  };
  const onlineLookup = () => {
    findOnlineArtworkWithDedupe(rel, meta).then((best) => {
      if (!best || !best.url) { embeddedFallback(); return; }
      downloadImage(best.url, cachedImg, (ok) => {
        if (ok) { console.log('[art] ' + (best.source || 'online') + ' art for ' + rel); sendFile(cachedImg); }
        else { console.log('[art] matched image failed to download for ' + rel); embeddedFallback(); }
      });
    }).catch(() => { embeddedFallback(); });
  };
  if (preferEmbedded) { extractEmbedded((ok) => { if (ok) sendFile(cachedImg); else onlineLookup(); }); return; }
  onlineLookup();
}

function readPlaylists() { try { const data = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); return Array.isArray(data) ? data : []; } catch { return []; } }
function writePlaylists(playlists) { fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlists, null, 2)); }

function sanitizeName(raw) { return typeof raw === 'string' ? raw.trim().slice(0, 100) : ''; }

function sanitizeProfileName(raw) {
  if (typeof raw !== 'string') return '';
  let name = raw.trim().slice(0, 60);
  if (!name || name === '.' || name === '..') return '';
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return '';
  return name;
}

function handlePlaylists(req, res, pathname) {
  const rest = pathname.slice('/api/playlists'.length);
  const id = rest.startsWith('/') ? rest.slice(1) : '';
  if (!id) {
    if (req.method === 'GET') { sendJSON(res, 200, readPlaylists()); return; }
    if (req.method === 'POST') {
      readJsonBody(req, (err, data) => {
        if (err) { sendJSON(res, 400, { error: err.message }); return; }
        const name = sanitizeName(data && data.name);
        if (!name) { sendJSON(res, 400, { error: 'Playlist name is required.' }); return; }
        const profile = sanitizeProfileName(data && data.profile) || null;
        const playlists = readPlaylists();
        const pl = { id: crypto.randomUUID(), name, songs: [], profile };
        playlists.push(pl); writePlaylists(playlists); sendJSON(res, 200, pl);
      });
      return;
    }
    sendJSON(res, 405, { error: 'Method not allowed' }); return;
  }
  const playlists = readPlaylists();
  const idx = playlists.findIndex((p) => p.id === id);
  if (idx === -1) { sendJSON(res, 404, { error: 'Playlist not found.' }); return; }
  if (req.method === 'GET') { sendJSON(res, 200, playlists[idx]); return; }
  if (req.method === 'DELETE') { playlists.splice(idx, 1); writePlaylists(playlists); sendJSON(res, 200, { ok: true }); return; }
  if (req.method === 'PATCH' || req.method === 'PUT') {
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      if (data && typeof data.name === 'string') {
        const name = sanitizeName(data.name);
        if (!name) { sendJSON(res, 400, { error: 'Playlist name cannot be empty.' }); return; }
        playlists[idx].name = name;
      }
      if (data && Array.isArray(data.songs)) playlists[idx].songs = data.songs.filter((s) => typeof s === 'string');
      writePlaylists(playlists); sendJSON(res, 200, playlists[idx]);
    });
    return;
  }
  sendJSON(res, 405, { error: 'Method not allowed' });
}

let historyData = {};
function loadHistory() {
  try { historyData = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { historyData = {}; }
  if (!historyData || typeof historyData !== 'object' || Array.isArray(historyData)) historyData = {};
}
function saveHistory() { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyData)); } catch {} }

function addHistoryEntry(profileKey, songPath) {
  if (!historyData[profileKey]) historyData[profileKey] = [];
  const arr = historyData[profileKey];
  arr.push({ path: songPath, timestamp: Date.now() });
  if (arr.length > 500) historyData[profileKey] = arr.slice(-500);
  saveHistory();
}

function searchProvider(searchTerm, source, limit, cb) {
  const args = ['--flat-playlist', '--playlist-end', String(limit), '--no-warnings', '--no-progress', '--dump-json', searchTerm];
  let stdout = ''; let stderr = ''; let done = false; let child = null;
  const timer = setTimeout(() => { try { if (child) child.kill(); } catch {} finish(null, []); }, 25000);
  const finish = (err, results) => { if (!done) { done = true; clearTimeout(timer); cb(err, results); } };
  child = spawn(YTDLP, args);
  child.on('error', () => finish(null, []));
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', () => {
    const results = [];
    stdout.split('\n').forEach((line) => {
      if (!line.trim()) return;
      try {
        const d = JSON.parse(line);
        if (!d.id && !d.webpage_url) return;
        let trackUrl, thumb;
        if (source === 'soundcloud') {
          trackUrl = d.webpage_url || d.url || '';
          const thumbs = d.thumbnails;
          thumb = (Array.isArray(thumbs) && thumbs.length) ? thumbs[thumbs.length - 1].url : '';
        } else {
          trackUrl = 'https://www.youtube.com/watch?v=' + d.id;
          thumb = 'https://i.ytimg.com/vi/' + d.id + '/hqdefault.jpg';
        }
        results.push({ source, id: String(d.id || ''), title: d.title || d.track || 'Untitled', channel: d.channel || d.uploader || d.artist || '', duration: typeof d.duration === 'number' ? d.duration : 0, thumb, url: trackUrl });
      } catch {}
    });
    finish(null, results);
  });
}

function searchAll(query, cb) {
  let completed = 0;
  const grouped = { youtube: [], soundcloud: [], ytmusic: [] };
  const total = 3;
  function onComplete() {
    completed++;
    if (completed < total) return;
    const seenIds = new Set();
    grouped.youtube.forEach((r) => { if (r.id) seenIds.add(r.id); });
    const ytmDeduped = grouped.ytmusic.filter((r) => !seenIds.has(r.id));
    cb(null, [...grouped.youtube, ...ytmDeduped, ...grouped.soundcloud]);
  }
  searchProvider('ytsearch6:' + query, 'youtube', 6, (err, results) => { if (results) grouped.youtube = results; onComplete(); });
  searchProvider('scsearch5:' + query, 'soundcloud', 5, (err, results) => { if (results) grouped.soundcloud = results; onComplete(); });
  const ytmUrl = 'https://music.youtube.com/search?q=' + encodeURIComponent(query);
  searchProvider(ytmUrl, 'ytmusic', 5, (err, results) => { if (results) grouped.ytmusic = results; onComplete(); });
}

function searchMixcloud(q, cb) {
  const apiUrl = 'https://api.mixcloud.com/search/?q=' + encodeURIComponent(q) + '&type=cloudcast&limit=10';
  fetchJsonSmart(apiUrl, BROWSER_UA, (data) => {
    if (!data || !Array.isArray(data.data)) return cb(null, []);
    const results = data.data.map((r) => ({
      source: 'mixcloud',
      title: r.name || 'Untitled',
      channel: (r.user && (r.user.name || r.user.username)) || '',
      duration: typeof r.audio_length === 'number' ? r.audio_length : 0,
      thumb: (r.pictures && (r.pictures.extra_large || r.pictures.large || r.pictures.medium)) || '',
      url: r.url || (r.key ? 'https://www.mixcloud.com' + r.key : ''),
    })).filter((r) => r.url);
    cb(null, results);
  });
}

const liveSockets = new Map();
const sessions = new Map();
const INVITE_TTL = 10 * 60 * 1000;

function sseWrite(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} }

function sendToProfiles(profiles, exceptDevice, obj) {
  profiles.forEach((p) => {
    const devMap = liveSockets.get(p);
    if (!devMap) return;
    devMap.forEach((r, devId) => { if (devId === exceptDevice) return; sseWrite(r, obj); });
  });
}

function sessionMembers(s) { return [s.host].concat(s.guests); }
function pruneInvites(s) { s.invited = s.invited.filter((iv) => Date.now() - iv.at < INVITE_TTL); }

function endSession(id, reason) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  const everyone = sessionMembers(s).concat(s.invited.map((iv) => iv.profile));
  sendToProfiles(everyone, null, { type: 'session-end', sessionId: id, reason: reason || 'ended' });
}

/* ─── family radio ─── */
const LASTFM_KEY = process.env.LASTFM_KEY || '';
const RADIO_FILE = path.join(CACHE_DIR, 'radio.json');
const radio = (() => {
  const POOL_TARGET = 120;
  const STATIONS = [
    { id: 'raves', name: 'Techno & EDM', emoji: '🎛️', desc: 'Techno, electro & heavy bass', gradient: 'linear-gradient(135deg,#FF2D55,#5E5CE6)', era: null, tags: ['techno', 'edm', 'electro house', 'dubstep'], artists: ['Skrillex', 'deadmau5', 'Eric Prydz', 'Daft Punk', 'Justice', 'Knife Party'], sprinkles: ['techno banger', 'edm anthem', 'electro house mix'], gateTags: ['techno', 'minimal techno', 'detroit techno', 'acid techno', 'hard techno', 'melodic techno', 'edm', 'electro', 'electro house', 'dubstep', 'brostep', 'complextro', 'moombahton', 'big beat', 'electronic', 'dance', 'trance', 'hard dance'] },
    { id: 'chill', name: 'Chill & Feel-Good', emoji: '🌙', desc: 'Upbeat, sunny & recognizable', gradient: 'linear-gradient(135deg,#64D2FF,#2C2C54)', era: null, tags: ['chill pop', 'future bass', 'electropop', 'indie pop', 'chillstep', 'tropical house'], artists: ['TheFatRat', 'Ookay', 'Nicky Youre', 'dazy', 'Tobu', 'Alan Walker', 'Marshmello', 'Gryffin', 'Lost Frequencies', 'Kygo', 'Petit Biscuit', 'Jonas Blue', 'NOTD'], sprinkles: ['feel good pop hits', 'chill edm hits', 'sunroof vibe songs'], gateTags: ['future bass', 'melodic dubstep', 'electropop', 'synthpop', 'tropical house', 'chillstep', 'indie pop', 'dance pop', 'pop', 'edm', 'chillout', 'downtempo', 'deep house', 'dance', 'electronic'] },
    { id: 'pop', name: 'Pop Hits', emoji: '🎤', desc: 'Current popular pop', gradient: 'linear-gradient(135deg,#FF375F,#FF9F0A)', era: 'new', deezerGenres: [0, 132], tags: ['pop'], artists: ['Taylor Swift', 'The Weeknd', 'Dua Lipa', 'Olivia Rodrigo', 'Sabrina Carpenter', 'Billie Eilish', 'Ariana Grande', 'Harry Styles', 'SZA', 'Tate McRae', 'Gracie Abrams', 'Bruno Mars', 'Justin Bieber'], sprinkles: ['new pop hits', 'pop hits 2025', 'trending pop songs', 'tiktok pop hits'], gateTags: ['pop', 'dance pop', 'electropop', 'synthpop', 'art pop', 'indie pop', 'post-teen pop', 'teen pop', 'pop rock', 'dance', 'edm', 'contemporary r&b', 'r&b', 'hip hop', 'uk pop'] },
    { id: 'throw', name: 'Throwbacks', emoji: '⏪', desc: '2000s & 2010s hits', gradient: 'linear-gradient(135deg,#BF5AF2,#FF453A)', era: null, tags: ['2000s', '2010s'], artists: ['Ed Sheeran', 'Shawn Mendes', 'The Chainsmokers', 'Camila Cabello', 'One Direction', 'Justin Bieber'], sprinkles: ['2010s pop hits', '2000s throwbacks'], gateTags: ['pop', 'dance pop', 'teen pop', 'pop rock', 'rock', 'alternative rock', 'indie rock', 'britpop', 'pop punk', 'emo', 'hip hop', 'rap', 'r&b', 'contemporary r&b', 'soul', 'funk', 'disco', 'dance', 'eurodance', 'crunk', 'grunge'] },
    { id: 'desi', name: 'Desi Beats', emoji: '🪩', desc: 'Mainstream Bollywood & Punjabi', gradient: 'linear-gradient(135deg,#FF9F0A,#FF453A)', era: null, tags: ['bollywood', 'hindi', 'punjabi'], artists: [], sprinkles: ['latest bollywood hits', 'popular punjabi song'], gateTags: ['bollywood', 'filmi', 'hindi', 'punjabi', 'bhangra', 'desi', 'indian pop', 'indian', 'urdu', 'pop', 'dance'] },
    { id: 'house', name: 'Holy Grail of House', emoji: '🏠', desc: 'Timeless house classics', gradient: 'linear-gradient(135deg,#32D74B,#64D2FF)', era: null, tags: ['classic house', 'deep house', 'chicago house', 'french house'], artists: ['Daft Punk', 'Swedish House Mafia', 'Avicii', 'David Guetta', 'Calvin Harris', 'Tiësto', 'Armin van Buuren', 'deadmau5', 'Frankie Knuckles', 'Marshall Jefferson', 'Larry Heard', 'Kerri Chandler', 'Masters At Work', 'Todd Terry', 'Eric Prydz', 'Fatboy Slim', 'Carl Cox', 'Martin Garrix', 'Hardwell', 'Alesso', 'Zedd', 'Galantis', 'MEDUZA'], sprinkles: ['classic house anthems'], gateTags: ['house', 'deep house', 'tech house', 'progressive house', 'electro house', 'french house', 'chicago house', 'funky house', 'vocal house', 'tribal house', 'latin house', 'dutch house', 'big room', 'complextro', 'eurodance', 'disco', 'dance', 'electronic', 'trance', 'electro', 'big beat'] },
    { id: 'guetta-avicii', name: 'Guetta & Avicii Radio', emoji: '🎧', desc: 'Their complete discography', gradient: 'linear-gradient(135deg,#FF9500,#FF2D55)', era: null, tags: [], artists: ['David Guetta', 'Avicii'], sprinkles: ['David Guetta songs', 'David Guetta best songs', 'Avicii songs', 'Avicii best songs'], gateTags: [] },
    { id: 'aditya-rikhari', name: 'Aditya Rikhari Radio', emoji: '🎶', desc: 'Full discography', gradient: 'linear-gradient(135deg,#FF6B6B,#FFE66D)', era: null, tags: [], artists: ['Aditya Rikhari'], sprinkles: ['Aditya Rikhari songs', 'Aditya Rikhari all songs', 'Aditya Rikhari music', 'Aditya Rikhari latest'], gateTags: [] },
  ];
  const BAD_TITLE = /\b(remix|slowed|reverb|sped ?up|nightcore|cover|live|acoustic|instrumental|karaoke|mashup|medley|1 hour|one hour|full album|album|playlist|dj mix|extended mix|tiktok|tutorial|reaction)\b/i;
  let db = { stations: {}, likes: {}, urls: {}, gate: {} };
  try { db = JSON.parse(fs.readFileSync(RADIO_FILE, 'utf8')); } catch {}
  db.stations = db.stations || {}; db.likes = db.likes || {}; db.urls = db.urls || {}; db.gate = db.gate || {};
  let dbDirty = false;
  let getLibrary = () => null;
  function save() { try { fs.writeFileSync(RADIO_FILE, JSON.stringify(db)); dbDirty = false; } catch {} }
  setInterval(() => { if (dbDirty) save(); }, 15000);
  const rnorm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
  const tkey = (t, a) => rnorm(a) + '::' + rnorm(t);
  function mulberry(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0; return h; }
  function dayNum() { return Math.floor(Date.now() / (24 * 3600 * 1000)); }
  function st(id) { if (!db.stations[id]) db.stations[id] = { pool: [], order: [], pos: 0, slotStart: 0, builtAt: 0, building: false }; return db.stations[id]; }
  function reshuffle(id) { const s = st(id); const rnd = mulberry(hashStr(id + ':' + dayNum() + ':' + s.pos)); const idx = s.pool.map((_, i) => i); for (let j = idx.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); const tmp = idx[j]; idx[j] = idx[k]; idx[k] = tmp; } s.order = idx; }
  function advance(id, now) {
    const s = st(id);
    if (!s.pool.length) return null;
    if (!s.order.length) reshuffle(id);
    if (!s.slotStart) s.slotStart = now;
    let guard = 0;
    while (guard++ < 5000) {
      const track = s.pool[s.order[s.pos % s.order.length]];
      if (!track) { s.pos++; continue; }
      const dur = (track.d || 180) * 1000;
      if (now < s.slotStart + dur) return { track: track, offset: Math.max(0, (now - s.slotStart) / 1000) };
      s.slotStart += dur; s.pos++; dbDirty = true;
      if (s.pos % s.order.length === 0) reshuffle(id);
    }
    s.slotStart = now;
    const track = s.pool[s.order[s.pos % s.order.length]];
    return track ? { track: track, offset: 0 } : null;
  }
  const lastfmAsync = (m, p) => new Promise((resolve) => {
    const q = new URLSearchParams(Object.assign({ method: m, api_key: LASTFM_KEY, format: 'json' }, p));
    const urlStr = 'https://ws.audioscrobbler.com/2.0/?' + q.toString();
    let u; try { u = new URL(urlStr); } catch { return resolve(null); }
    const options = { protocol: u.protocol, hostname: u.hostname, path: u.pathname + u.search, timeout: 15000, headers: { 'User-Agent': 'Aria/1.0', 'Accept': 'application/json' } };
    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) { console.log('[radio] lastfm status ' + res.statusCode + ' for ' + m); return resolve(null); }
        try {
          const data = JSON.parse(body);
          if (data && data.error) { console.log('[radio] lastfm error: ' + data.message); return resolve(null); }
          resolve(data);
        } catch (e) { console.log('[radio] lastfm bad json'); resolve(null); }
      });
    });
    req.on('error', (e) => { resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
  function radioSearch(term, limit, cb) {
    const args = ['--flat-playlist', '--playlist-end', String(limit), '--no-warnings', '--no-progress', '--dump-json', 'ytsearch' + limit + ':' + term];
    let stdout = ''; let done = false; let child = null;
    const timer = setTimeout(() => { try { if (child) child.kill(); } catch {} fin([]); }, 25000);
    const fin = (r) => { if (!done) { done = true; clearTimeout(timer); cb(r || []); } };
    child = spawn(YTDLP, args);
    child.on('error', () => fin([]));
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => { fin(parseSearchOut(stdout)); });
  }
  function radioSearchFull(term, limit, cb) {
    const args = ['--no-warnings', '--no-progress', '--dump-json', '--playlist-items', String(limit), 'ytsearch' + limit + ':' + term];
    let stdout = ''; let done = false; let child = null;
    const timer = setTimeout(() => { try { if (child) child.kill(); } catch {} fin([]); }, 40000);
    const fin = (r) => { if (!done) { done = true; clearTimeout(timer); cb(r || []); } };
    child = spawn(YTDLP, args);
    child.on('error', () => fin([]));
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => { fin(parseSearchOut(stdout)); });
  }
  function parseSearchOut(stdout) {
    const results = [];
    stdout.split('\n').forEach((line) => {
      if (!line.trim()) return;
      try {
        const d = JSON.parse(line);
        if (!d.id && !d.webpage_url) return;
        results.push({ title: d.title || 'Untitled', channel: d.channel || d.uploader || d.artist || '', duration: typeof d.duration === 'number' ? d.duration : 0, thumb: d.thumbnail || ('https://i.ytimg.com/vi/' + d.id + '/hqdefault.jpg'), url: d.webpage_url || ('https://www.youtube.com/watch?v=' + d.id), uploadDate: d.upload_date || '' });
      } catch {}
    });
    return results;
  }
  function eraOk(r, cfg) {
    if (cfg.era !== 'new' || !r.uploadDate) return true;
    const y = parseInt(String(r.uploadDate).slice(0, 4), 10);
    return !y || y >= cfg.eraYear;
  }
  function ytVerify(results, cand, cfg) {
    for (const r of results.slice(0, 3)) {
      if (!r || !r.url) continue;
      if (BAD_TITLE.test(r.title || '')) continue;
      if (!(r.duration >= 90 && r.duration <= 420)) continue;
      if (!eraOk(r, cfg)) continue;
      const titleScore = tokenSimilarity(r.title || '', cand.t);
      const artistScore = tokenSimilarity(r.channel || '', cand.a);
      if (titleScore >= 0.6 || (titleScore >= 0.35 && artistScore >= 0.4 && (0.6 * titleScore + 0.4 * artistScore) >= 0.5)) return r;
    }
    return null;
  }
  function gateCheck(artist, cfg) {
    if (!cfg.gateTags || !cfg.gateTags.length) return Promise.resolve(true);
    const key = artist.toLowerCase();
    const g = db.gate[key];
    if (g && Date.now() - g.at < 30 * 24 * 3600 * 1000) return Promise.resolve(g.ok);
    return lastfmAsync('artist.gettoptags', { artist: artist, limit: 12 }).then((d) => {
      const tags = d && d.toptags && Array.isArray(d.toptags.tag) ? d.toptags.tag.map((t) => (t.name || '').toLowerCase()) : null;
      if (!tags) return true;
      const ok = tags.some((at) => cfg.gateTags.some((gt) => at === gt || at.includes(gt) || gt.includes(at)));
      db.gate[key] = { ok: ok, at: Date.now() };
      dbDirty = true;
      return ok;
    });
  }
  function addResolved(id, entry) {
    const s = st(id);
    if (s.pool.length >= POOL_TARGET) return;
    const k = tkey(entry.t, entry.a);
    if (s.pool.some((p) => tkey(p.t, p.a) === k)) return;
    s.pool.push(entry); dbDirty = true;
    if (!s.slotStart && s.pool.length >= 4) { s.slotStart = Date.now(); reshuffle(id); }
  }
  function churnPool(s, likedKeys) {
    if (s.pool.length < 10) return;
    const target = Math.max(6, Math.round(s.pool.length * 0.2));
    const idxs = s.pool.map((_, i) => i).filter((i) => !likedKeys.has(tkey(s.pool[i].t, s.pool[i].a)));
    for (let j = idxs.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); const tmp = idxs[j]; idxs[j] = idxs[k]; idxs[k] = tmp; }
    const removeSet = new Set(idxs.slice(0, target));
    s.pool = s.pool.filter((_, i) => !removeSet.has(i));
    dbDirty = true;
  }
  const buildQueue = []; let building = false;
  const radioSessions = new Map();
  function queueBuild(id) { const s = st(id); if (s.building) return; s.building = true; dbDirty = true; buildQueue.push(id); kickBuild(); }
  async function kickBuild() { if (building) return; building = true; while (buildQueue.length) { const id = buildQueue.shift(); try { await buildStation(id); } catch (e) { console.log('[radio] build error: ' + e.message); } } building = false; }
  async function buildStation(id) {
    const cfg = STATIONS.find((x) => x.id === id); const s = st(id);
    cfg.eraYear = new Date().getFullYear() - 5;
    console.log('[radio] building pool for ' + cfg.name);
    const day = dayNum();
    const likedKeys = new Set();
    const L = db.likes[id];
    if (L && L.tracks) Object.values(L.tracks).forEach((arr) => arr.forEach((x) => likedKeys.add(tkey(x.t, x.a))));
    if (cfg.tags.length) churnPool(s, likedKeys);
    if (cfg.artists.length && cfg.tags.length) {
      const seedNames = new Set(cfg.artists.map((a) => a.toLowerCase()));
      const isSeed = (p) => seedNames.has((p.a || '').toLowerCase());
      const seedCount = s.pool.filter(isSeed).length;
      if (s.pool.length > 20 && seedCount / s.pool.length < 0.5) {
        const removable = [];
        s.pool.forEach((p, i) => { if (!isSeed(p) && !likedKeys.has(tkey(p.t, p.a))) removable.push(i); });
        for (let j = removable.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); const tmp = removable[j]; removable[j] = removable[k]; removable[k] = tmp; }
        const removeSet = new Set(removable.slice(0, 40));
        if (removeSet.size) { s.pool = s.pool.filter((_, i) => !removeSet.has(i)); dbDirty = true; }
      }
    }
    const candSeed = []; const candOther = []; const seen = new Set();
    const push = (t, a, seed) => { const k = tkey(t, a); if (!t || !a || seen.has(k)) return; seen.add(k); (seed ? candSeed : candOther).push({ t: t, a: a }); };
    const tracksOf = (d) => { const root = d && (d.toptracks || d.tracks); return root && Array.isArray(root.track) ? root.track : []; };
    if (cfg.artists.length) {
      for (const ar of cfg.artists) {
        const dAr = await lastfmAsync('artist.gettoptracks', { artist: ar, limit: 50 });
        tracksOf(dAr).forEach((tr) => push(tr.name, (tr.artist && tr.artist.name) || ar, true));
        await sleep(250);
      }
    }
    if (cfg.era !== 'new') {
      for (const tag of cfg.tags) {
        const page = (day % 6) + 1;
        const d = await lastfmAsync('tag.gettoptracks', { tag: tag, limit: 50, page: page });
        tracksOf(d).forEach((tr) => push(tr.name, tr.artist && tr.artist.name, false));
        await sleep(250);
      }
    }
    if (cfg.artists.length) {
      const seeds = [cfg.artists[day % cfg.artists.length], cfg.artists[(day + 3) % cfg.artists.length]];
      for (const seed of seeds) {
        const sim = await lastfmAsync('artist.getsimilar', { artist: seed, limit: 6 }); await sleep(250);
        const sims = sim && sim.similar && Array.isArray(sim.similar.artist) ? sim.similar.artist.slice(0, 2) : [];
        for (const sa of sims) {
          const d2 = await lastfmAsync('artist.gettoptracks', { artist: sa.name, limit: 10 }); await sleep(250);
          tracksOf(d2).forEach((tr) => push(tr.name, (tr.artist && tr.artist.name) || sa.name, false));
        }
      }
      if (cfg.tags.length) {
        const baseTag = cfg.tags[day % cfg.tags.length];
        const rt = await lastfmAsync('tag.gettoptags', { tag: baseTag }); await sleep(250);
        const rel = rt && rt.toptags && Array.isArray(rt.toptags.tag) ? rt.toptags.tag.map((t) => (t.name || '').toLowerCase()) : [];
        const pickTag = rel.find((t) => !cfg.tags.includes(t) && !cfg.gateTags.includes(t));
        if (pickTag) {
          const d3 = await lastfmAsync('tag.gettoptracks', { tag: pickTag, limit: 15 }); await sleep(250);
          tracksOf(d3).forEach((tr) => push(tr.name, tr.artist && tr.artist.name, false));
        }
      }
      const likedArtists = Object.entries(((db.likes[id] || {}).artists) || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
      for (const ar of likedArtists) {
        const d4 = await lastfmAsync('artist.gettoptracks', { artist: ar, limit: 5 }); await sleep(250);
        tracksOf(d4).forEach((tr) => push(tr.name, (tr.artist && tr.artist.name) || ar, true));
      }
    }
    if (cfg.deezerGenres) {
      for (const gid of cfg.deezerGenres) {
        const dzr = await fetchJsonAsync('https://api.deezer.com/genre/' + gid + '/charts?limit=50', BROWSER_UA);
        const dz = dzr && dzr.data;
        const trs = dz && dz.tracks && Array.isArray(dz.tracks.data) ? dz.tracks.data : [];
        trs.forEach((tr) => push(tr.title, tr.artist && tr.artist.name, false));
        await sleep(250);
      }
    }
    const sprinkleEntries = [];
    for (const sp of cfg.sprinkles) {
      const rs = await new Promise((resolve) => radioSearchFull(sp, 8, resolve));
      rs.forEach((r) => {
        if (!(r.duration >= 90 && r.duration <= 420)) return;
        if (BAD_TITLE.test(r.title || '')) return;
        if (!eraOk(r, cfg)) return;
        sprinkleEntries.push({ t: cleanTitleForQuery(r.title, r.channel), a: r.channel, d: r.duration, u: r.url, th: r.thumb });
      });
    }
    const gateAll = async (arr) => { const out = []; for (const c of arr) { if (await gateCheck(c.a, cfg)) out.push(c); await sleep(120); } return out; };
    const gSeed = await gateAll(candSeed);
    const gOther = await gateAll(candOther);
    console.log('[radio] ' + cfg.name + ' candidates seed: ' + candSeed.length + ' other: ' + candOther.length + ' (gated seed: ' + gSeed.length + ', gated other: ' + gOther.length + ')');
    const inPool = new Set(s.pool.map((p) => tkey(p.t, p.a)));
    const fS = gSeed.filter((c) => !inPool.has(tkey(c.t, c.a)));
    const fO = gOther.filter((c) => !inPool.has(tkey(c.t, c.a)));
    const need = [];
    let iS = 0, iO = 0;
    while (need.length < 90 && (iS < fS.length || iO < fO.length)) {
      if (iS < fS.length) need.push(fS[iS++]);
      if (iS < fS.length && need.length < 90) need.push(fS[iS++]);
      if (iO < fO.length && need.length < 90) need.push(fO[iO++]);
    }
    let resolved = 0;
    await new Promise((resolve) => {
      let idx = 0, active = 0, finished = false, misses = 0;
      const tick = () => {
        if (finished) return;
        if (active === 0 && (idx >= need.length || misses >= 14 || s.pool.length >= POOL_TARGET || resolved >= 70)) { finished = true; resolve(); return; }
        while (active < 2 && idx < need.length && s.pool.length < POOL_TARGET) {
          const c = need[idx++]; active++;
          radioSearch(c.a + ' ' + c.t, 3, (rs) => {
            const r = ytVerify(rs, c, cfg);
            if (r) { addResolved(id, { t: c.t, a: c.a, d: r.duration, u: r.url, th: r.thumb, addedDay: day }); resolved++; misses = 0; } else misses++;
            active--;
            setTimeout(tick, 400);
          });
        }
      };
      tick();
    });
    sprinkleEntries.forEach((e) => { addResolved(id, Object.assign({ addedDay: day }, e)); });
    s.builtAt = Date.now(); s.building = false; dbDirty = true; save();
    if (s.pool.length < 20) setTimeout(() => queueBuild(id), 10 * 60 * 1000);
    console.log('[radio] ' + cfg.name + ' pool size: ' + s.pool.length);
  }
  function directUrl(track, cb) {
    const k = tkey(track.t, track.a);
    const c = db.urls[k];
    if (c && c.exp > Date.now()) return cb(c.url);
    let done = false; let child = null;
    const fin = (u) => { if (!done) { done = true; cb(u); } };
    const timer = setTimeout(() => { try { if (child) child.kill(); } catch {} fin(null); }, 20000);
    child = spawn(YTDLP, ['--extractor-args', 'youtube:player_client=android', '-g', '--no-warnings', '-f', 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio/best', track.u]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); fin(null); });
    child.on('close', () => { clearTimeout(timer); const u = out.trim().split('\n')[0] || null; if (u) { db.urls[k] = { url: u, exp: Date.now() + 3 * 3600 * 1000 }; dbDirty = true; } fin(u); });
  }
  function dropUrl(track) { if (track) { delete db.urls[tkey(track.t, track.a)]; dbDirty = true; } }
  function stream(req, res, id, sid) {
    if (!STATIONS.some((x) => x.id === id)) { sendJSON(res, 404, { error: 'Unknown station' }); return; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    let stopped = false;
    let upstream = null;
    let ffFails = 0;
    let wrote = false;
    let trackStarted = 0;
    let curTrack = null;
    let curOffset = 0;
    let curUrl = null;
    let waitTimer = null;
    let sess = null;
    if (sid) { sess = { connStart: Date.now(), timeline: [] }; radioSessions.set(sid, sess); }
    res.on('close', () => { stopped = true; if (waitTimer) clearTimeout(waitTimer); if (upstream) { try { upstream.destroy(); } catch {} } if (sid) radioSessions.delete(sid); });
    res.on('drain', () => { if (upstream) { try { upstream.resume(); } catch {} } });
    const writeChunk = (d) => { if (stopped) return; wrote = true; if (!res.write(d)) { try { upstream.pause(); } catch {} } };
    function skipCurrent() { const s = st(id); s.slotStart += ((curTrack && curTrack.d) || 180) * 1000; s.pos++; dbDirty = true; }
    function nextTrack() {
      if (stopped) return;
      const now = advance(id, Date.now());
      if (!now) { try { res.end(); } catch {} return; }
      if (curTrack && now.track === curTrack) {
        const s2 = st(id);
        const waitMs = Math.max(300, (s2.slotStart + ((curTrack.d || 180) * 1000)) - Date.now());
        waitTimer = setTimeout(nextTrack, waitMs);
        return;
      }
      curTrack = now.track; curOffset = now.offset; wrote = false; trackStarted = Date.now();
      if (sess) { sess.timeline.push({ at: trackStarted, track: curTrack }); if (sess.timeline.length > 100) sess.timeline.shift(); }
      directUrl(curTrack, (u) => {
        if (stopped) return;
        if (!u) { skipCurrent(); return nextTrack(); }
        curUrl = u;
        if (ffFails >= 2) passthroughStart(u); else ffmpegStart(u);
      });
    }
    function trackDone(secs) {
      if (curTrack && secs > 30) { curTrack.d = Math.round(secs); dbDirty = true; }
      nextTrack();
    }
    function ffmpegStart(u) {
      const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.floor(curOffset)), '-re', '-i', u, '-f', 'mp3', '-b:a', '128k', 'pipe:1']);
      let errTail = '';
      upstream = child.stdout;
      child.stdout.on('data', writeChunk);
      child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-300); });
      child.on('error', () => { upstream = null; if (!stopped) { skipCurrent(); nextTrack(); } });
      child.on('close', (code) => {
        upstream = null;
        if (stopped) return;
        const secs = (Date.now() - trackStarted) / 1000 + curOffset;
        if (code !== 0 && !wrote) {
          dropUrl(curTrack);
          ffFails++;
          if (ffFails === 2) console.log('[radio] ffmpeg failing (' + (errTail || 'no output').trim().slice(-200) + ') — using passthrough');
          skipCurrent();
          return nextTrack();
        }
        ffFails = 0;
        trackDone(secs);
      });
    }
    function passthroughStart(u) {
      const follow = (uu, hops) => {
        if (stopped) return;
        let parsed; try { parsed = new URL(uu); } catch { skipCurrent(); return nextTrack(); }
        const mod = parsed.protocol === 'http:' ? http : https;
        const rreq = mod.get({ protocol: parsed.protocol, hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'User-Agent': BROWSER_UA }, timeout: 15000 }, (r) => {
          if (r.statusCode >= 301 && r.statusCode <= 308 && r.headers.location && hops > 0) { r.resume(); follow(new URL(r.headers.location, uu).toString(), hops - 1); return; }
          if (r.statusCode !== 200) { dropUrl(curTrack); console.log('[radio] passthrough ' + r.statusCode + ' for ' + (curTrack ? curTrack.t : '?')); r.resume(); skipCurrent(); return nextTrack(); }
          upstream = r;
          r.on('data', writeChunk);
          r.on('end', () => { if (!stopped) { upstream = null; trackDone((Date.now() - trackStarted) / 1000); } });
          r.on('error', () => { if (!stopped) { upstream = null; skipCurrent(); nextTrack(); } });
        });
        rreq.on('error', () => { if (!stopped) { skipCurrent(); nextTrack(); } });
        rreq.on('timeout', () => { try { rreq.destroy(); } catch {} });
      };
      follow(u, 3);
    }
    nextTrack();
  }
  function handle(req, res, url, pathname) {
    const route = pathname.slice('/api/radio'.length) || '/';
    if (route === '/stations' && req.method === 'GET') {
      sendJSON(res, 200, STATIONS.map((c) => {
        const s = st(c.id);
        const ready = s.pool.length >= 1;
        const now = ready ? advance(c.id, Date.now()) : null;
        return { id: c.id, name: c.name, emoji: c.emoji, desc: c.desc, gradient: c.gradient, ready: ready, builtAt: s.builtAt, now: now ? { title: now.track.t, artist: now.track.a } : null };
      }));
      return;
    }
    if (route === '/now' && req.method === 'GET') {
      const id = url.searchParams.get('station');
      const profile = sanitizeProfileName(url.searchParams.get('profile')) || '__shared__';
      const sid = url.searchParams.get('sid');
      const sess = sid ? radioSessions.get(sid) : null;
      let now = null;
      if (sess && sess.timeline.length) {
        const t = parseFloat(url.searchParams.get('t'));
        const b = parseFloat(url.searchParams.get('b'));
        const ct = isFinite(t) ? t : 0;
        const cb = isFinite(b) ? b : 0;
        const heardAt = sess.connStart + (ct + cb) * 1000;
        let pick = sess.timeline[0];
        for (const e of sess.timeline) { if (e.at <= heardAt) pick = e; else break; }
        now = { track: pick.track, offset: 0 };
      } else if (st(id)) { now = advance(id, Date.now()); }
      if (!now) { sendJSON(res, 200, { ready: false }); return; }
      const L = db.likes[id]; const liked = !!(L && L.tracks && (L.tracks[profile] || []).some((x) => tkey(x.t, x.a) === tkey(now.track.t, now.track.a)));
      sendJSON(res, 200, { ready: true, title: now.track.t, artist: now.track.a, thumb: now.track.th, u: now.track.u, offset: now.offset, liked: liked });
      return;
    }
    if (route === '/like' && req.method === 'POST') {
      readJsonBody(req, (err, data) => {
        if (err) { sendJSON(res, 400, { error: err.message }); return; }
        const id = data.station; const profile = sanitizeProfileName(data && data.profile) || '__shared__';
        const a = ((data && data.artist) || '').trim(); const t = ((data && data.title) || '').trim();
        if (!id || !t) { sendJSON(res, 400, { error: 'missing fields' }); return; }
        if (!db.likes[id]) db.likes[id] = { artists: {}, tracks: {} };
        const L = db.likes[id];
        if (a) L.artists[a] = (L.artists[a] || 0) + 1;
        if (!L.tracks[profile]) L.tracks[profile] = [];
        const k = tkey(t, a);
        if (!L.tracks[profile].some((x) => tkey(x.t, x.a) === k)) L.tracks[profile].push({ t: t, a: a });
        dbDirty = true; save();
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
    if (route === '/stream' && req.method === 'GET') { stream(req, res, url.searchParams.get('station'), url.searchParams.get('sid')); return; }
    sendJSON(res, 404, { error: 'Unknown radio route' });
  }
  function init(getLib) {
    getLibrary = getLib || getLibrary;
    STATIONS.forEach((c) => { const s0 = st(c.id); if (s0.building) { s0.building = false; dbDirty = true; } });
    STATIONS.forEach((c, i) => {
      setTimeout(() => { const s = st(c.id); if (s.pool.length < 20 || Date.now() - s.builtAt > 24 * 3600 * 1000) queueBuild(c.id); }, 5000 + i * 1000);
    });
    setInterval(() => { STATIONS.forEach((c) => { const s = st(c.id); if (!s.building && (Date.now() - s.builtAt > 24 * 3600 * 1000)) queueBuild(c.id); }); }, 3600 * 1000);
  }
  return { handle: handle, init: init };
})();

/* ─── HTTP server ─── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/radio')) { radio.handle(req, res, url, pathname); return; }

  if (pathname === '/api/download') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Use POST' }); return; }
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      const dlUrl = ((data && data.url) || '').trim();
      if (!isValidDownloadUrl(dlUrl)) { sendJSON(res, 400, { error: 'Please enter a valid YouTube or SoundCloud URL.' }); return; }
      const ownerKey = sanitizeProfileName(data && data.profile) || '__shared__';
      downloadAudio(dlUrl, ownerKey, (derr, result) => {
        if (derr) { sendJSON(res, 500, { error: derr.message }); return; }
        sendJSON(res, 200, result);
      });
    });
    return;
  }

  if (pathname === '/api/mixes/download') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Use POST' }); return; }
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      const dlUrl = ((data && data.url) || '').trim();
      if (!isMixcloudUrl(dlUrl)) { sendJSON(res, 400, { error: 'Please enter a valid Mixcloud URL.' }); return; }
      downloadMix(dlUrl, (derr, result) => {
        if (derr) { sendJSON(res, 500, { error: derr.message }); return; }
        sendJSON(res, 200, result);
      });
    });
    return;
  }

  if (pathname === '/api/mixcloud') {
    if (req.method !== 'GET') { sendJSON(res, 405, { error: 'Use GET' }); return; }
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) { sendJSON(res, 400, { error: 'Search query required.' }); return; }
    searchMixcloud(q, (err, results) => { sendJSON(res, 200, { results: results || [] }); });
    return;
  }

  if (pathname === '/api/mixes') {
    if (req.method === 'GET') {
      let items = [];
      try {
        ensureMixesDir();
        const files = fs.readdirSync(MIXES_DIR).filter((f) => AUDIO_EXT[extOf(f)]).sort((a, b) => a.localeCompare(b));
        items = files.map((f) => {
          const rel = path.join('.mixes', f);
          const absPath = path.join(MIXES_DIR, f);
          let stat = null; try { stat = fs.statSync(absPath); } catch {}
          const meta = stat ? getMetadata(rel, absPath, stat) : {};
          const encodedPath = rel.split(path.sep).map(encodeURIComponent).join('/');
          return { url: '/music/' + encodedPath, title: meta.title || prettify(rel), artist: meta.artist || '', duration: meta.duration || 0, added: stat ? stat.mtimeMs : 0, art: '/api/art/' + encodedPath + '?emb=1', path: rel, mix: true };
        });
      } catch {}
      saveMetaCache();
      sendJSON(res, 200, items);
      return;
    }
    if (req.method === 'DELETE') {
      readJsonBody(req, (err, data) => {
        if (err) { sendJSON(res, 400, { error: err.message }); return; }
        const p = (data && data.path) || '';
        const absPath = path.join(MUSIC_DIR, p);
        if (!p.startsWith('.mixes' + path.sep) || !absPath.startsWith(MIXES_DIR + path.sep)) { sendJSON(res, 400, { error: 'Invalid mix path.' }); return; }
        try { fs.unlinkSync(absPath); sendJSON(res, 200, { ok: true }); }
        catch (e) { sendJSON(res, 500, { error: e.message }); }
      });
      return;
    }
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/api/pathmap') {
    if (req.method !== 'GET') { sendJSON(res, 405, { error: 'Use GET' }); return; }
    sendJSON(res, 200, pathmap || {});
    return;
  }

  if (pathname === '/api/library/remove') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Use POST' }); return; }
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      const rel = (data && data.path) || '';
      if (!rel || typeof rel !== 'string') { sendJSON(res, 400, { error: 'path required.' }); return; }
      const requester = sanitizeProfileName(data && data.profile) || '__shared__';
      const absPath = path.join(MUSIC_DIR, rel);
      if (!absPath.startsWith(MUSIC_DIR + path.sep) && absPath !== MUSIC_DIR) { sendJSON(res, 403, { error: 'Invalid path.' }); return; }
      if (rel.startsWith('.mixes' + path.sep)) { sendJSON(res, 400, { error: 'Use the mix menu to remove mixes.' }); return; }
      if (library) {
        const track = library.tracks.find((t) => t.file === rel);
        if (!track) { sendJSON(res, 404, { error: 'Song not found.' }); return; }
        const owners = track.owners || [];
        if (owners.length > 1) {
          if (!owners.includes(requester)) { sendJSON(res, 403, { error: 'This song belongs to another profile.' }); return; }
          track.owners = owners.filter((o) => o !== requester);
          saveLibrary();
          sendJSON(res, 200, { ok: true, deleted: false });
          return;
        }
        library.tracks = library.tracks.filter((t) => t !== track);
        saveLibrary();
        try { fs.unlinkSync(absPath); } catch {}
        if (metaCache[rel]) { delete metaCache[rel]; metaCacheDirty = true; }
        let pmChanged = false;
        for (const k of Object.keys(pathmap)) { if (pathmap[k] === rel) { delete pathmap[k]; pmChanged = true; } }
        if (pmChanged) savePathmap();
        saveMetaCache();
        sendJSON(res, 200, { ok: true, deleted: true });
        return;
      }
      try { fs.unlinkSync(absPath); } catch (e) { sendJSON(res, 500, { error: e.message }); return; }
      if (metaCache[rel]) { delete metaCache[rel]; metaCacheDirty = true; saveMetaCache(); }
      sendJSON(res, 200, { ok: true, deleted: true });
    });
    return;
  }

  if (pathname === '/api/history') {
    if (req.method === 'GET') {
      const profile = url.searchParams.get('profile') || '__shared__';
      sendJSON(res, 200, historyData[profile] || []);
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req, (err, data) => {
        if (err) { sendJSON(res, 400, { error: err.message }); return; }
        const profile = sanitizeProfileName(data && data.profile) || '__shared__';
        const songPath = data && data.path;
        if (!songPath || typeof songPath !== 'string') { sendJSON(res, 400, { error: 'path required.' }); return; }
        addHistoryEntry(profile, songPath);
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/api/live/inbox') {
    const profile = url.searchParams.get('profile') || 'anon';
    const device = url.searchParams.get('device') || 'dev';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.write(': connected\n\n');
    if (!liveSockets.has(profile)) liveSockets.set(profile, new Map());
    liveSockets.get(profile).set(device, res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    sessions.forEach((s) => {
      pruneInvites(s);
      if (s.invited.some((iv) => iv.profile === profile)) sseWrite(res, { type: 'invite', sessionId: s.id, from: s.hostLabel });
    });
    req.on('close', () => {
      clearInterval(hb);
      const m = liveSockets.get(profile);
      if (m) { m.delete(device); if (!m.size) liveSockets.delete(profile); }
    });
    return;
  }

  if (pathname === '/api/session/create') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Use POST' }); return; }
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      const profile = (data && data.profile) || '__shared__';
      const label = (data && data.label) || profile;
      for (const s of sessions.values()) if (s.host === profile) { sendJSON(res, 200, { id: s.id }); return; }
      const id = crypto.randomBytes(4).toString('hex');
      sessions.set(id, { id, host: profile, hostLabel: label, guests: [], invited: [], state: { song: null, position: 0, playing: false, updatedAt: Date.now() }, createdAt: Date.now() });
      sendJSON(res, 200, { id });
    });
    return;
  }

  if (pathname.startsWith('/api/session/')) {
    const parts = pathname.slice('/api/session/'.length).split('/');
    const id = parts[0];
    const action = parts[1] || '';
    const s = sessions.get(id);
    if (req.method === 'GET' && action === 'state') {
      if (!s) { sendJSON(res, 404, { error: 'Session not found.' }); return; }
      pruneInvites(s);
      sendJSON(res, 200, { id: s.id, host: s.host, hostLabel: s.hostLabel, guests: s.guests, state: s.state });
      return;
    }
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Method not allowed' }); return; }
    readJsonBody(req, (err, data) => {
      if (err) { sendJSON(res, 400, { error: err.message }); return; }
      data = data || {};
      if (!s) { sendJSON(res, 404, { error: 'Session not found or already ended.' }); return; }
      const device = data.device || null;
      if (action === 'invite') {
        const target = data.target;
        if (!target) { sendJSON(res, 400, { error: 'target required.' }); return; }
        pruneInvites(s);
        if (target !== s.host && !s.guests.includes(target) && !s.invited.some((iv) => iv.profile === target)) s.invited.push({ profile: target, at: Date.now() });
        sendToProfiles([target], null, { type: 'invite', sessionId: s.id, from: s.hostLabel });
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (action === 'accept') {
        const p = data.profile;
        if (!p) { sendJSON(res, 400, { error: 'profile required.' }); return; }
        s.invited = s.invited.filter((iv) => iv.profile !== p);
        if (p !== s.host && !s.guests.includes(p)) s.guests.push(p);
        sendToProfiles(sessionMembers(s), device, { type: 'joined', profile: p, guests: s.guests });
        sendJSON(res, 200, { ok: true, state: s.state, hostLabel: s.hostLabel, guests: s.guests });
        return;
      }
      if (action === 'decline') {
        const p = data.profile;
        s.invited = s.invited.filter((iv) => iv.profile !== p);
        sendToProfiles([s.host], null, { type: 'declined', profile: p });
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (action === 'leave') {
        const p = data.profile;
        if (p === s.host) { endSession(id, 'host-ended'); sendJSON(res, 200, { ok: true }); return; }
        s.guests = s.guests.filter((g) => g !== p);
        sendToProfiles(sessionMembers(s), device, { type: 'left', profile: p, guests: s.guests });
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (action === 'end') { endSession(id, 'ended'); sendJSON(res, 200, { ok: true }); return; }
      if (action === 'event') {
        const ev = data.event || {};
        const from = data.profile;
        const now = Date.now();
        if (ev.type === 'play') { s.state.playing = true; if (typeof ev.position === 'number') s.state.position = ev.position; s.state.updatedAt = now; }
        else if (ev.type === 'pause') { s.state.playing = false; if (typeof ev.position === 'number') s.state.position = ev.position; s.state.updatedAt = now; }
        else if (ev.type === 'seek' || ev.type === 'tick') { if (typeof ev.position === 'number') s.state.position = ev.position; if (typeof ev.playing === 'boolean') s.state.playing = ev.playing; s.state.updatedAt = now; }
        else if (ev.type === 'song') { s.state.song = ev.song || null; if (typeof ev.position === 'number') s.state.position = ev.position; s.state.playing = ev.playing !== false; s.state.updatedAt = now; }
        ev.fromProfile = from;
        sendToProfiles(sessionMembers(s), device, Object.assign({ sessionId: id }, ev));
        sendJSON(res, 200, { ok: true });
        return;
      }
      sendJSON(res, 404, { error: 'Unknown session action.' });
    });
    return;
  }

  if (pathname === '/api/search') {
    if (req.method !== 'GET') { sendJSON(res, 405, { error: 'Use GET' }); return; }
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) { sendJSON(res, 400, { error: 'Search query required.' }); return; }
    searchAll(q, (err, results) => {
      if (err) { sendJSON(res, 500, { error: err.message }); return; }
      sendJSON(res, 200, { results });
    });
    return;
  }

  if (pathname === '/api/playlists' || pathname.startsWith('/api/playlists/')) { handlePlaylists(req, res, pathname); return; }

  if (pathname === '/api/songs') {
    let songs = [];
    if (library) {
      songs = library.tracks.map((t) => {
        const rel = t.file;
        const absPath = path.join(MUSIC_DIR, rel);
        let stat = null; try { stat = fs.statSync(absPath); } catch {}
        const meta = stat ? getMetadata(rel, absPath, stat) : {};
        const encodedPath = rel.split(path.sep).map(encodeURIComponent).join('/');
        return { url: '/music/' + encodedPath, title: meta.title || t.title || prettify(rel), artist: meta.artist || t.artist || '', album: meta.album || t.album || '', duration: meta.duration || t.duration || 0, added: t.added || (stat ? stat.mtimeMs : 0), art: '/api/art/' + encodedPath + '?v=7', lyrics: '/api/lyrics/' + encodedPath, path: rel, profiles: t.owners || [] };
      }).filter((s) => { try { return fs.existsSync(path.join(MUSIC_DIR, s.path)); } catch { return false; } });
    } else {
      songs = listSongs(MUSIC_DIR).sort((a, b) => a.localeCompare(b)).map((rel) => {
        const absPath = path.join(MUSIC_DIR, rel);
        let stat = null; try { stat = fs.statSync(absPath); } catch {}
        const meta = stat ? getMetadata(rel, absPath, stat) : {};
        const encodedPath = rel.split(path.sep).map(encodeURIComponent).join('/');
        const segments = rel.split(path.sep);
        const owner = segments.length > 1 ? segments[0] : '__shared__';
        return { url: '/music/' + encodedPath, title: meta.title || prettify(rel), artist: meta.artist || '', album: meta.album || '', duration: meta.duration || 0, added: stat ? stat.mtimeMs : 0, art: '/api/art/' + encodedPath + '?v=7', lyrics: '/api/lyrics/' + encodedPath, path: rel, profiles: [owner] };
      });
    }
    saveMetaCache();
    sendJSON(res, 200, songs);
    return;
  }

  if (pathname === '/api/profiles') {
    let names = new Set();
    let hasShared = false;
    try {
      const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
      entries.forEach((e) => {
        if (e.isDirectory() && !e.name.startsWith('.')) names.add(e.name);
        if (e.isFile() && AUDIO_EXT[extOf(e.name)]) hasShared = true;
      });
    } catch {}
    if (library) {
      library.tracks.forEach((t) => (t.owners || []).forEach((o) => {
        if (o === '__shared__' || o === 'shared') hasShared = true;
        else names.add(o);
      }));
    }
    sendJSON(res, 200, { profiles: [...names].sort((a, b) => a.localeCompare(b)), hasShared });
    return;
  }

  if (pathname.startsWith('/api/lyrics/')) {
    if (req.method !== 'GET') { sendJSON(res, 405, { error: 'Method not allowed' }); return; }
    const rel = pathname.slice('/api/lyrics/'.length);
    const refresh = url.searchParams.get('refresh') === '1';
    const absPath = path.join(MUSIC_DIR, rel);
    if (!absPath.startsWith(MUSIC_DIR + path.sep) && absPath !== MUSIC_DIR) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    let stat = null; try { stat = fs.statSync(absPath); } catch {}
    if (!stat) { sendJSON(res, 200, { source: 'none', synced: false, lines: [], plain: '' }); return; }
    ensureLyrics(rel, absPath, stat, refresh, (meta) => {
      saveMetaCache();
      if (meta.lyricsSource === 'none' || (!meta.plainLyrics && !meta.syncedLyrics)) sendJSON(res, 200, { source: 'none', synced: false, lines: [], plain: '' });
      else if (meta.syncedLyrics) sendJSON(res, 200, { source: meta.lyricsSource, synced: true, lines: parseLrc(meta.syncedLyrics), plain: meta.plainLyrics || '' });
      else sendJSON(res, 200, { source: meta.lyricsSource, synced: false, lines: [], plain: meta.plainLyrics || '' });
    });
    return;
  }

  if (pathname.startsWith('/api/art/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJSON(res, 405, { error: 'Method not allowed' }); return; }
    const rel = pathname.slice('/api/art/'.length);
    serveArt(res, rel, url.searchParams.get('refresh') === '1', url.searchParams.get('emb') === '1');
    return;
  }

  if (pathname.startsWith('/music/')) {
    let rel = pathname.slice('/music/'.length);
    let absPath = path.join(MUSIC_DIR, rel);
    if (!fs.existsSync(absPath) && pathmap[rel]) { rel = pathmap[rel]; absPath = path.join(MUSIC_DIR, rel); }
    if (!absPath.startsWith(MUSIC_DIR + path.sep) && absPath !== MUSIC_DIR) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    serveAudio(req, res, absPath);
    return;
  }

  let staticPath = pathname === '/' ? '/index.html' : pathname;
  const absStatic = path.join(PUBLIC_DIR, staticPath);
  if (!absStatic.startsWith(PUBLIC_DIR)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
  serveStatic(res, absStatic);
});

server.requestTimeout = 0;
server.timeout = 0;

ensureCacheDirs();
ensureMixesDir();
ensureStoreDirs();
loadMetaCache();
loadHistory();
runMigrationIfNeeded();
radio.init(function () { return library; });

server.listen(PORT, () => {
  console.log(`\n🎵 Aria is running`);
  console.log(`Serving music from: ${MUSIC_DIR}`);
  console.log(`Open on this machine: http://localhost:${PORT}`);
  console.log(`Open on your phone: http://<this-computer-ip>:${PORT}\n`);
});