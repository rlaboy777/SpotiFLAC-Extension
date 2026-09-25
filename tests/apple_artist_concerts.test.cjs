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
    detail_id: 'ce.123',
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

function detailPage(id = 'ce.123', ticket = 'https://example.com/tickets/1') {
  return `<script id="serialized-server-data">${JSON.stringify({ data: [{ data: {
    shareUrl: `https://music.apple.com/us/concerts/${id}`,
    sections: [
      { id, itemKind: 'concertDetailHeaderLockup', items: [{
        titleLink: { title: 'Example Artist' },
        artwork: { dictionary: { url: 'https://example.com/{w}x{h}.{f}' } },
        accessoryCalendarArtwork: { date: '2026-10-07T01:00:00Z', timeZone: 'America/New_York' },
      }] },
      { itemKind: 'concertDetailButtonSection', items: [{ leadingButton: {
        link: { segue: { $kind: 'openExternalURLAction', url: ticket } },
      } }] },
      { itemKind: 'concertDetailList', items: [{ attributedFooterText: 'Powered by Example Events', items: [
        { segue: { $kind: 'addToCalendarAction', startDate: '2026-10-07T01:00:00Z',
          endDate: '2026-10-07T04:00:00Z', eventName: 'Example Tour',
          locationName: 'Example Hall', address: '123 Example Street' } },
        { symbolArtwork: { name: 'mappin.and.ellipse' },
          segue: { $kind: 'openExternalURLAction', url: 'https://example.com/map' } },
      ] }] },
      { itemKind: 'concertDetailReleaseLockup', items: [{
        title: 'Example Tour Set List', artwork: { dictionary: { url: 'https://example.com/list/{w}x{h}.{f}' } },
        contentDescriptor: { kind: 'playlist', identifiers: { storeAdamID: 'pl.example' } },
      }] },
    ],
  } }] })}</script>`;
}

test('concert detail yields native-page metadata, real ticket links, and a set list', () => {
  const { context, calls } = runtime({ statusCode: 200, body: detailPage() });
  const detail = context.getConcert('ce.123');
  assert.equal(detail.artist_name, 'Example Artist');
  assert.equal(detail.cover_url, 'https://example.com/900x900.jpg');
  assert.equal(detail.ticket_url, 'https://example.com/tickets/1');
  assert.equal(detail.address, '123 Example Street');
  assert.equal(detail.end_at, '2026-10-07T04:00:00Z');
  assert.equal(detail.map_url, 'https://example.com/map');
  assert.equal(detail.set_list.id, 'pl.example');
  assert.equal(detail.set_list.cover_url, 'https://example.com/list/500x500.jpg');
  context.getConcert('ce.123');
  assert.deepEqual(calls, ['https://music.apple.com/us/concerts/ce.123']);
});

test('invalid concert IDs, mismatched headers, and unsafe links are rejected', () => {
  const { context, calls } = runtime({ statusCode: 200, body: detailPage() });
  assert.equal(context.getConcert('../artist/123'), null);
  assert.equal(calls.length, 0);
  assert.equal(context.parseConcertDetail(detailPage(), 'ce.other'), null);
  assert.equal(context.parseConcertDetail('<html></html>', 'ce.123'), null);
  assert.equal(context.parseConcertDetail(detailPage('ce.123', 'javascript:alert(1)'), 'ce.123').ticket_url, '');
});
