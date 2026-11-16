// "Serverless backend": the admin panel publishes configs and models by
// committing them to the GitHub repo through the REST contents API. The Pages
// workflow then redeploys, so every change is versioned, reviewable and
// revertible in git history. Needs a fine-grained token with
// "Contents: read and write" on this one repository; it is kept in this
// browser only (and only if "remember" is ticked).

const API = 'https://api.github.com';
const SETTINGS_KEY = 'lineworld.publish.v1';

export function loadPublishSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* ignore */ }
  try { s.token = s.remember ? s.token : sessionStorage.getItem(SETTINGS_KEY + '.token') || ''; } catch { /* ignore */ }
  return { repo: '', branch: 'main', profile: '', token: '', remember: false, ...s };
}

export function savePublishSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, token: s.remember ? s.token : '' }));
    sessionStorage.setItem(SETTINGS_KEY + '.token', s.token || '');
  } catch { /* private mode */ }
}

/** Best guess of owner/repo when served from <owner>.github.io/<repo>/ */
export function guessRepo(loc = location) {
  const m = /^([^.]+)\.github\.io$/i.exec(loc.hostname);
  const repo = loc.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `${m[1]}/${repo}` : '';
}

/** Repo-relative path of a profile's config. '' = the default public/config.json */
export function profilePath(profile) {
  if (!profile) return 'public/config.json';
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(profile)) throw new Error('Profile names: letters, digits, - and _ only');
  return `public/configs/${profile}.json`;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const textToB64 = (t) => b64(new TextEncoder().encode(t));
export const bytesToB64 = (buf) => b64(new Uint8Array(buf));

async function gh(settings, method, path, body) {
  if (!settings.token) throw new Error('No GitHub token set');
  if (!/^[\w.-]+\/[\w.-]+$/.test(settings.repo)) throw new Error('Repository must look like owner/name');
  const r = await fetch(`${API}/repos/${settings.repo}/contents/${path}${method === 'GET' ? `?ref=${encodeURIComponent(settings.branch)}` : ''}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${settings.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'GET' && r.status === 404) return null;
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${json.message || r.statusText}`);
  return json;
}

/** Create or update one file; returns the commit URL. */
export async function putFile(settings, path, contentB64, message) {
  const existing = await gh(settings, 'GET', path);
  const res = await gh(settings, 'PUT', path, {
    message, content: contentB64, branch: settings.branch, ...(existing?.sha ? { sha: existing.sha } : {}),
  });
  return res.commit?.html_url;
}

export async function readJson(settings, path) {
  const f = await gh(settings, 'GET', path);
  if (!f) return null;
  const bin = atob(f.content.replace(/\n/g, ''));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/** Publish a config to a profile and keep public/configs/index.json in sync. */
export async function publishConfig(settings, configObj, title) {
  const path = profilePath(settings.profile);
  const url = await putFile(settings, path, textToB64(JSON.stringify(configObj, null, 2) + '\n'),
    `admin: publish config${settings.profile ? ` (${settings.profile})` : ''}`);
  if (settings.profile) {
    const index = (await readJson(settings, 'public/configs/index.json')) || { profiles: [] };
    const entry = { id: settings.profile, title: title || settings.profile, updated: new Date().toISOString() };
    index.profiles = [...index.profiles.filter((p) => p.id !== settings.profile), entry].sort((a, b) => a.id.localeCompare(b.id));
    await putFile(settings, 'public/configs/index.json', textToB64(JSON.stringify(index, null, 2) + '\n'), `admin: index ${settings.profile}`);
  }
  return url;
}

/** Upload a .glb to public/models/; returns the URL the app should load it from. */
export async function publishModel(settings, file) {
  if (file.size > 50 * 1024 * 1024) throw new Error('Model is larger than 50 MB');
  const name = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  await putFile(settings, `public/models/${name}`, bytesToB64(await file.arrayBuffer()), `admin: upload model ${name}`);
  return `models/${name}`;
}
