const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(response) {
  const calls = [];
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    http: { get(url) { calls.push(url); return response; } },
    utils: { randomUserAgent() { return 'test'; } },
  });
  vm.runInContext(fs.readFileSync(
    path.join(__dirname, '../sources/apple-music/index.js'), 'utf8'
  ), context);
  context.apiGet = () => ({ data: [{ id: '123', attributes: { name: 'Artist' } }] });
  return { context, calls };
}

function event(id = 'ce.123', overrides = {}) {
  return {
    title: 'Example City',
    subtitle: 'Example Hall\u202f·\u202fTue, Oct 6\u202f·\u202f9 PM',
    artwork: { date: '2026-10-07T01:00:00Z', timeZone: 'America/New_York' },
    contentDescriptor: {
      kind: 'concert', identifiers: { storeAdamID: id },
      url: `https://music.apple.com/us/concerts/${id}`,
    },
    ...overrides,
  };
}

function page(items) {
  return `<script type="application/json" id="serialized-server-data">${JSON.stringify({
    data: [{ data: { sections: [{ itemKind: 'calendarEventLockup', items }] } }],
  })}</script>`;
}

test('public concert page yields generic venue, date, zone, and event links', () => {
  const { context, calls } = runtime({ statusCode: 200, body: page([event()]) });
  const artist = context.getArtist('123');
  assert.equal(artist.name, 'Artist');
  assert.equal(artist.concerts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(artist.concerts[0])), {
    id: 'ce.123', location: 'Example City', venue: 'Example Hall',
    start_at: '2026-10-07T01:00:00Z', time_zone: 'America/New_York',
    url: 'https://music.apple.com/us/concerts/ce.123',
  });
  assert.deepEqual(calls, ['https://music.apple.com/us/concerts/artist/123']);
  context.getArtist('123');
  assert.equal(calls.length, 1, 'artist cache also caches the optional concerts');
});

test('uses the configured storefront without requiring a user token', () => {
  const { context, calls } = runtime({ statusCode: 200, body: page([]) });
  vm.runInContext('state.storefront = "id"', context);
  context.getArtist('123');
  assert.equal(calls[0], 'https://music.apple.com/id/concerts/artist/123');
});

test('deduplicates and orders events, ignoring malformed and unrelated entries', () => {
  const { context } = runtime();
  const events = context.parseArtistConcerts(page([
    null, event(), event(), event('ce.early', { artwork: { date: '2026-10-01' } }),
    event('ce.bad', { artwork: { date: 'unknown' } }),
    event('ce.empty', { title: '' }), event('ce.disabled', { isDisabled: true }),
    event('ce.song', { contentDescriptor: { kind: 'song' } }),
  ]));
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'ce.early');
  assert.equal(events[0].time_zone, '');
});

test('untrusted event URLs are discarded and very large lists are bounded', () => {
  const { context } = runtime();
  const events = context.parseArtistConcerts(page(Array.from({ length: 600 }, (_, i) =>
    event(`ce.${i}`, { contentDescriptor: {
      kind: 'concert', identifiers: { storeAdamID: `ce.${i}` }, url: 'javascript:alert(1)',
    } })
  )));
  assert.equal(events.length, 500);
  assert.equal(events[0].url, '');
});

for (const response of [undefined, { error: 'offline' }, { statusCode: 404 },
  { statusCode: 200, body: '<html>no events</html>' },
  { statusCode: 200, body: '<script id="serialized-server-data">broken</script>' },
  { statusCode: 200, body: page([]) }]) {
  test(`optional concert failure preserves artist metadata: ${JSON.stringify(response)}`, () => {
    const { context } = runtime(response);
    const artist = context.getArtist('123');
    assert.equal(artist.name, 'Artist');
    assert.equal(artist.concerts.length, 0);
  });
}

test('album pagination never fetches concerts again', () => {
  const { context, calls } = runtime();
  context.apiGet = () => ({ data: [] });
  context.getArtist('123:albums:100');
  assert.equal(calls.length, 0);
});
