const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/amazon/index.js'), 'utf8');
const spotifyID = '0123456789abcdefghijkl';
const deezerURL = 'https://www.deezer.com/track/123';
const spotifyURL = `https://open.spotify.com/track/${spotifyID}`;
const amazonURL = 'https://music.amazon.com/albums/B000000001?trackAsin=B000000002';
const webURL = url => `https://song.link/${encodeURIComponent(url)}`;

function page(url = amazonURL, show = true) {
  const data = { props: { pageProps: { pageData: { sections: [
    { links: [{ platform: 'amazonMusic', url, show }] },
  ] } } } };
  return `<script nonce="fixture" type="application/json" id = '__NEXT_DATA__'>${JSON.stringify(data)}</script>`;
}

function runtime(respond, overrides = {}) {
  const calls = [], signedCalls = [];
  let extension;
  const context = vm.createContext({
    URL, URLSearchParams,
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { isDownloadCancelled: () => false, randomUserAgent: () => 'FixtureBrowser/152', ...overrides },
    session: { signedFetch(...args) { signedCalls.push(args); throw new Error('resolver must not use a signed session'); } },
    fetch(url, options) { calls.push({ url, options }); return respond(url, options); },
  });
  vm.runInContext(source, context);
  return { context, extension, calls, signedCalls };
}

test('Deezer matching uses one web page, preserves trackAsin and needs no signed session', () => {
  const app = runtime(() => ({ ok: true, text: () => page() }));
  const result = app.extension.checkAvailability('USAAA2600001', 'Signal', 'Artist', {
    deezer_id: '123', spotify_id: spotifyID,
  });
  assert.equal(result.available, true);
  assert.equal(result.track_id, 'B000000002');
  assert.deepEqual(app.calls.map(call => call.url), [webURL(deezerURL)]);
  assert.equal(app.calls[0].options.headers.Accept, 'text/html,application/xhtml+xml');
  assert.equal(app.calls[0].options.headers['User-Agent'], 'FixtureBrowser/152');
  assert.deepEqual(app.signedCalls, []);
});

for (const response of [
  { ok: false, status: 401 },
  { ok: true, text: () => '<script id="__NEXT_DATA__">invalid</script>' },
  { ok: true, text: () => page(amazonURL, false) },
  { ok: true, text: () => page('https://music.amazon.com.evil.test/tracks/B000000002') },
  { ok: true, text: () => page('https://music.amazon.com/albums/B000000001') },
]) {
  test(`Spotify web fallback after unusable Deezer response ${response.status || response.text()}`, () => {
    const app = runtime(url => url === webURL(deezerURL) ? response : { ok: true, text: () => page() });
    assert.equal(app.context.resolveAmazonURL('USAAA2600001', spotifyID, '123'), amazonURL);
    assert.deepEqual(app.calls.map(call => call.url), [webURL(deezerURL), webURL(spotifyURL)]);
    assert.deepEqual(app.signedCalls, []);
  });
}

test('ISRC-only matching resolves Deezer once, then uses its web page', () => {
  const lookup = 'https://api.deezer.com/track/isrc:USAAA2600001';
  const app = runtime(url => url === lookup
    ? { ok: true, json: () => ({ id: 123 }) }
    : { ok: true, text: () => page() });
  assert.equal(app.context.resolveAmazonURL('USAAA2600001', null, null), amazonURL);
  assert.deepEqual(app.calls.map(call => call.url), [lookup, webURL(deezerURL)]);
  assert.deepEqual(app.signedCalls, []);
});

for (const id of [0, '', 'invalid/path']) {
  test(`invalid Deezer ISRC result ${JSON.stringify(id)} retains Songstats fallback`, () => {
    const lookup = 'https://api.deezer.com/track/isrc:USAAA2600001';
    const songstats = 'https://songstats.com/USAAA2600001?ref=ISRCFinder';
    const app = runtime(url => url === lookup
      ? { ok: true, json: () => ({ id }) }
      : { ok: true, text: () => `<script type="application/ld+json">${JSON.stringify({ sameAs: [amazonURL] })}</script>` });
    assert.equal(app.context.resolveAmazonURL('USAAA2600001', '987', null), amazonURL);
    assert.deepEqual(app.calls.map(call => call.url), [lookup, songstats]);
    assert.deepEqual(app.signedCalls, []);
  });
}

test('empty resolver results retain exact Amazon catalog search', () => {
  const app = runtime(() => ({ ok: true, text: () => page(amazonURL, false) }));
  app.context.resolveAmazonTrackBySearch = (title, artist, duration) => {
    assert.deepEqual([title, artist, duration], ['Signal', 'Artist', 180000]);
    return 'B000000002';
  };
  const result = app.extension.checkAvailability('', 'Signal', 'Artist', {
    spotify_id: spotifyID, duration_ms: 180000,
  });
  assert.equal(result.track_id, 'B000000002');
  assert.deepEqual(app.calls.map(call => call.url), [webURL(spotifyURL)]);
});

for (const afterFirstPage of [false, true]) {
  test(`cancellation ${afterFirstPage ? 'between pages' : 'before matching'} stops network requests`, () => {
    let cancelled = !afterFirstPage;
    const app = runtime(() => {
      cancelled = true;
      return { ok: false, status: 503 };
    }, { isDownloadCancelled: () => cancelled });
    assert.throws(() => app.context.resolveAmazonURL('', spotifyID, '123'), error => error.code === 'CANCELLED');
    assert.equal(app.calls.length, afterFirstPage ? 1 : 0);
  });
}

test('exhausted resolution budget prevents matching requests', () => {
  const app = runtime(() => assert.fail('unexpected request'), { getResolutionRemainingMs: () => 0 });
  assert.throws(() => app.context.resolveAmazonURL('', spotifyID, '123'), error => error.code === 'RESOLUTION_TIMEOUT');
  assert.equal(app.calls.length, 0);
});

test('older hosts use Chrome 152 fallback user agents', () => {
  const app = runtime(() => assert.fail('unexpected request'), { randomUserAgent: undefined });
  assert.ok(app.context.USER_AGENTS.every(ua => ua.includes('Chrome/152.0.0.0')));
  assert.ok(app.context.getRandomUA().includes('Chrome/152.0.0.0'));
});
