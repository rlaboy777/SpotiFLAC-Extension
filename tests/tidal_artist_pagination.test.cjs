const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime() {
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  vm.runInContext(fs.readFileSync(
    path.join(__dirname, '../sources/tidal-web/index.js'), 'utf8'
  ), context);
  return context;
}

const album = (id, artist = 123) => ({ id, title: `Album ${id}`, artist: { id: artist } });
function artistPage() {
  return { rows: [{ modules: [
    { type: 'ARTIST_HEADER', artist: { id: 123, name: 'Example Artist' } },
    { type: 'ALBUM_LIST', title: 'Albums', pagedList: {
      items: [album(1), album(2)], offset: 0, totalNumberOfItems: 6,
      dataApiPath: 'artists/123/albums',
    } },
    { type: 'ALBUM_LIST', title: 'Singles', pagedList: {
      items: [album(3)], totalNumberOfItems: 2,
      dataApiPath: 'artists/123/albums?filter=EPSANDSINGLES',
    } },
  ] }] };
}

test('artist overview does not eagerly request remaining release pages', () => {
  const context = runtime();
  let reads = 0;
  context.fetchArtistPage = () => { reads++; return artistPage(); };
  context.fetchArtistAlbumsPage = () => assert.fail('Eager pagination');
  const artist = context.getArtist('123');
  assert.equal(artist.albums.length, 3);
  assert.ok(artist.albums_next);
  assert.equal(context.getArtist('123'), artist);
  assert.equal(reads, 1);
});

test('each scroll fetches one page and moves between album and single modules', () => {
  const context = runtime();
  context.fetchArtistPage = artistPage;
  const calls = [];
  context.fetchArtistAlbumsPage = (path, offset, limit) => {
    calls.push({ path, offset, limit });
    return path.includes('EPSANDSINGLES')
      ? { items: [album(7)], totalNumberOfItems: 2 }
      : { items: [album(4), album(5), album(6), album(8)], totalNumberOfItems: 6 };
  };
  const overview = context.getArtist('123');
  const second = context.getArtist(overview.albums_next);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].offset, 2);
  assert.equal(calls[0].limit, 50);
  assert.equal(second.albums.length, 4);
  assert.ok(second.albums_next);
  const third = context.getArtist(second.albums_next);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].offset, 1);
  assert.equal(third.albums[0].album_type, 'single');
  assert.equal(third.albums_next, '');
});

test('continuation survives a fresh runtime without refetching the overview', () => {
  const first = runtime();
  first.fetchArtistPage = artistPage;
  const cursor = first.getArtist('123').albums_next;
  const restored = runtime();
  restored.fetchArtistPage = () => assert.fail('Overview requested again');
  restored.fetchArtistAlbumsPage = () => ({ items: [album(4)], totalNumberOfItems: 6 });
  const page = restored.getArtist(cursor);
  assert.equal(page.albums.length, 1);
  assert.notEqual(page.albums_next, cursor);
});

test('raw page length advances the cursor even if duplicate and unrelated releases are filtered', () => {
  const context = runtime();
  context.fetchArtistPage = artistPage;
  const cursor = context.getArtist('123').albums_next;
  const offsets = [];
  context.fetchArtistAlbumsPage = (_, offset) => {
    offsets.push(offset);
    return { items: [album(4), album(4), album(5, 999)], totalNumberOfItems: 100 };
  };
  const page = context.getArtist(cursor);
  assert.equal(page.albums.length, 1);
  context.getArtist(page.albums_next);
  assert.deepEqual(offsets, [2, 5]);
});

test('empty pages advance to the next module and failures remain retryable', () => {
  const context = runtime();
  context.fetchArtistPage = artistPage;
  const cursor = context.getArtist('123').albums_next;
  context.fetchArtistAlbumsPage = () => { throw new Error('Network unavailable'); };
  assert.equal(context.getArtist(cursor), null);
  context.fetchArtistAlbumsPage = () => ({ items: [] });
  const page = context.getArtist(cursor);
  assert.ok(page.albums_next);
  assert.notEqual(page.albums_next, cursor);
  assert.equal(context.getArtist(page.albums_next).albums_next, '');
});

test('artist with no additional releases does not return a continuation', () => {
  const context = runtime();
  context.fetchArtistPage = () => ({ rows: [{ modules: [
    { type: 'ARTIST_HEADER', artist: { id: 123, name: 'Example Artist' } },
  ] }] });
  assert.equal(context.getArtist('123').albums_next, '');
});

test('malformed continuation does not make a provider request', () => {
  const context = runtime();
  context.fetchArtistAlbumsPage = () => assert.fail('Invalid cursor requested');
  assert.equal(context.getArtist('artist-albums:invalid'), null);
});
