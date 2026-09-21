const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const artwork = {
  dictionary: { url: 'https://example.test/art/{w}x{h}{c}.{f}' },
  cropStyle: 'sr',
};
function item(kind, id, extra = {}) {
  return {
    title: 'Example music', artwork,
    contentDescriptor: {
      kind, identifiers: { storeAdamID: id },
      url: `https://music.apple.com/us/album/example/123?i=${id}`,
    },
    ...extra,
  };
}
function page(sections) {
  return `<script type="application/json" id="serialized-server-data">${JSON.stringify({
    data: [{ data: { sections } }],
  })}</script>`;
}
function runtime(body) {
  const calls = [];
  let registered;
  const context = vm.createContext({
    registerExtension(value) { registered = value; },
    log: { info() {}, debug() {}, warn() {} },
    storage: { get() {}, set() {} },
    utils: { randomUserAgent() { return 'test'; } },
    http: { get(url) { calls.push(url); return { statusCode: 200, body }; } },
  });
  vm.runInContext(fs.readFileSync(
    path.join(__dirname, '../sources/apple-music/index.js'), 'utf8'
  ), context);
  return { context, calls, registered };
}

test('public New feed keeps hero first and maps supported music without extra requests', () => {
  const body = page([
    { id: 'hero', itemKind: 'flowcaseLockup', items: [item('playlist', 'pl.example', {
      heading: 'UPDATED PLAYLIST', subtitle: 'Curator', description: 'Editorial description',
      coverArtwork: { dictionary: { url: 'https://example.test/cover/{w}x{h}{c}.{f}' } },
    })] },
    { id: 'songs', header: { item: { titleLink: { title: 'New songs' } } }, items: [
      item('song', '456', { artistName: 'Artist' }), item('song', '456'),
      item('station', 'radio'), item('music-video', 'video'), null,
    ] },
    { id: 'albums', items: [item('album', '123', {
      title: undefined, titleLinks: [{ title: 'Album title' }],
      subtitleLinks: [{ title: 'Artist one' }, { title: 'Artist two' }],
    })] },
  ]);
  const { registered, calls } = runtime(body);
  const result = registered.getHomeFeed();
  assert.equal(result.success, true);
  assert.equal(result.sections.length, 3);
  assert.equal(result.sections[0].layout, 'featured');
  const hero = result.sections[0].items[0];
  assert.equal(hero.id, 'pl.example');
  assert.equal(hero.cover_url, 'https://example.test/cover/600x600sr.jpg');
  assert.equal(hero.featured_cover_url, 'https://example.test/art/960x640sr.jpg');
  assert.equal(hero.heading, 'UPDATED PLAYLIST');
  assert.equal(result.sections[1].items.length, 1);
  assert.equal(result.sections[1].items[0].type, 'track');
  assert.equal(result.sections[1].items[0].album_id, '123');
  assert.equal(result.sections[2].items[0].name, 'Album title');
  assert.equal(result.sections[2].items[0].artists, 'Artist one, Artist two');
  registered.getHomeFeed();
  assert.deepEqual(calls, ['https://music.apple.com/us/new']);
});

test('storefront changes fetch an independent feed without authentication', () => {
  const { registered, calls } = runtime(page([{ items: [item('album', '123')] }]));
  registered.initialize({ storefront: 'id' });
  assert.equal(registered.getHomeFeed().success, true);
  registered.initialize({ storefront: 'gb' });
  registered.getHomeFeed();
  assert.deepEqual(calls, ['https://music.apple.com/id/new', 'https://music.apple.com/gb/new']);
});

test('explicit flags reach songs, albums and matching heroes without treating unknown as clean', () => {
  const { registered } = runtime(page([
    { itemKind: 'flowcaseLockup', items: [item('album', '123'), item('playlist', 'pl.unknown')] },
    { items: [
      item('album', '123', { showExplicitBadge: true }),
      item('song', 'explicit', { showExplicitBadge: true }),
      item('song', 'clean', { showExplicitBadge: false }),
    ] },
  ]));
  const sections = registered.getHomeFeed().sections;
  assert.equal(sections[0].items[0].explicit, true);
  assert.equal(sections[0].items[1].explicit, null);
  assert.equal(sections[1].items[1].explicit, true);
  assert.equal(sections[1].items[2].explicit, false);
});

for (const body of ['<html>Unavailable</html>', page([]),
  '<script id="serialized-server-data">invalid</script>']) {
  test(`invalid feed returns a recoverable error: ${body.slice(0, 30)}`, () => {
    const { registered, calls } = runtime(body);
    assert.equal(registered.getHomeFeed().success, false);
    assert.equal(registered.getHomeFeed().success, false);
    assert.equal(calls.length, 2, 'errors must not poison the cache');
  });
}
