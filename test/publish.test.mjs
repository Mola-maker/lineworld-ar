import test from 'node:test';
import assert from 'node:assert/strict';
import { publishConfig, publishModel, guessRepo, profilePath, textToB64 } from '../src/publish.js';

function mockGitHub() {
  const files = new Map([['public/configs/index.json', { sha: 'i1', content: textToB64(JSON.stringify({ profiles: [{ id: 'old', title: 'Old' }] })) }]]);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '');
    calls.push(`${opts.method} ${path}`);
    assert.equal(opts.headers.Authorization, 'Bearer t0k');
    if (opts.method === 'GET') {
      const f = files.get(path);
      return f ? new Response(JSON.stringify(f)) : new Response('{}', { status: 404 });
    }
    const body = JSON.parse(opts.body);
    if (files.has(path)) assert.equal(body.sha, files.get(path).sha, 'update must send sha');
    files.set(path, { sha: 'new', content: body.content });
    return new Response(JSON.stringify({ commit: { html_url: 'https://github.com/x/y/commit/1' } }));
  };
  return { files, calls };
}

const settings = { repo: 'owner/repo', branch: 'main', token: 't0k', profile: 'spring' };
const decode = (b64) => JSON.parse(Buffer.from(b64, 'base64').toString());

test('publishConfig writes the profile and updates the index', async () => {
  const { files, calls } = mockGitHub();
  await publishConfig(settings, { ui: { title: '春' } }, 'Spring');
  assert.deepEqual(decode(files.get('public/configs/spring.json').content), { ui: { title: '春' } });
  const idx = decode(files.get('public/configs/index.json').content);
  assert.deepEqual(idx.profiles.map((p) => p.id), ['old', 'spring']);
  assert.ok(calls.includes('PUT public/configs/spring.json'));
});

test('default profile goes to public/config.json; model upload', async () => {
  const { files } = mockGitHub();
  await publishConfig({ ...settings, profile: '' }, { a: 1 });
  assert.ok(files.has('public/config.json'));
  const url = await publishModel(settings, { name: 'Prince V2.glb', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  assert.equal(url, 'models/prince-v2.glb');
  assert.equal(Buffer.from(files.get('public/models/prince-v2.glb').content, 'base64').length, 4);
});

test('validation and helpers', async () => {
  assert.throws(() => profilePath('../evil'));
  await assert.rejects(publishConfig({ ...settings, token: '' }, {}), /token/);
  assert.equal(guessRepo({ hostname: 'mola-maker.github.io', pathname: '/lineworld-ar/' }), 'mola-maker/lineworld-ar');
  assert.equal(guessRepo({ hostname: 'localhost', pathname: '/' }), '');
});
