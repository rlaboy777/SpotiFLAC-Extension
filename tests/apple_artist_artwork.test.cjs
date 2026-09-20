const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(attributes) {
  const calls = [];
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  vm.runInContext(fs.readFileSync(
    path.join(__dirname, '../sources/apple-music/index.js'), 'utf8'
  ), context);
  context.apiGet = (request) => {
    calls.push(request);
    return { data: [{ id: 'artist-1', attributes }] };
  };
  return { context, calls };
}

const portrait = { url: 'https://example.test/portrait/{w}x{h}.jpg' };
const square = {
  video: 'https://example.test/square.m3u8',
  previewFrame: { url: 'https://example.test/scenery/{w}x{h}.jpg', width: 3840, height: 3840 },
};
const wide = {
  video: 'https://example.test/wide.m3u8',
  previewFrame: { url: 'https://example.test/wide/{w}x{h}.jpg', width: 3840, height: 2160 },
};

test('artist endpoint requests motion and static editorial artwork', () => {
  const { context, calls } = runtime({ name: 'Artist', artwork: portrait });
  const result = context.getArtist('artist-1');
  assert.match(calls[0], /extend=editorialVideo,editorialArtwork/);
  assert.equal(result.header_video, '');
  assert.equal(result.header_image, 'https://example.test/portrait/3000x3000.jpg');
});

test('square artist motion is returned instead of a frozen scenery preview', () => {
  const { context } = runtime({
    name: 'Artist', artwork: portrait,
    editorialVideo: { motionArtistSquare1x1: square, motionArtistFullscreen16x9: wide },
  });
  const result = context.getArtist('artist-1');
  assert.equal(result.header_video, square.video);
  assert.match(result.header_image, /portrait/);
  assert.equal(result.image_url, result.header_image);
});

for (const key of ['motionArtistFullscreen16x9', 'motionArtistWide16x9']) {
  test(`artist motion falls back to ${key}`, () => {
    const { context } = runtime({ artwork: portrait, editorialVideo: { [key]: wide } });
    assert.equal(context.getArtist('artist-1').header_video, wide.video);
  });
}

test('static editorial portrait wins without turning a logo into cover art', () => {
  const { context } = runtime({
    artwork: portrait,
    editorialArtwork: {
      vipSquare: { url: 'https://example.test/editorial/{w}x{h}.jpg' },
      musicContentColorLogoTrimmed: { url: 'https://example.test/logo/{w}x{h}.png' },
    },
  });
  const result = context.getArtist('artist-1');
  assert.match(result.header_image, /editorial/);
  assert.match(result.image_url, /portrait/);
  assert.equal(result.header_video, '');
});

test('video preview is a last resort when no portrait exists', () => {
  const { context } = runtime({ editorialVideo: { motionArtistWide16x9: wide } });
  const result = context.getArtist('artist-1');
  assert.equal(result.header_image, 'https://example.test/wide/1080x608.jpg');
  assert.equal(result.header_video, wide.video);
});

test('artist without artwork remains a valid artist', () => {
  const { context } = runtime({ name: 'Artist' });
  const result = context.getArtist('artist-1');
  assert.equal(result.header_image, '');
  assert.equal(result.header_video, '');
  assert.equal(result.header_logo, '');
  assert.equal(result.name, 'Artist');
});

test('artist logo preserves its aspect ratio and transparent PNG rendition', () => {
  const { context } = runtime({
    artwork: portrait,
    editorialArtwork: {
      musicContentColorLogoTrimmed: {
        url: 'https://example.test/logo/{w}x{h}bb.jpg', width: 2400, height: 600,
      },
    },
  });
  const result = context.getArtist('artist-1');
  assert.equal(result.header_logo, 'https://example.test/logo/1200x300bb.png');
  assert.match(result.header_image, /portrait/);
});

test('invalid logo dimensions fall back to the artist name', () => {
  const { context } = runtime({
    editorialArtwork: {
      musicContentColorLogoTrimmed: {
        url: 'https://example.test/logo/{w}x{h}bb.jpg', width: 0, height: 600,
      },
    },
  });
  assert.equal(context.getArtist('artist-1').header_logo, '');
});

test('artist change preserves portrait-only album motion selection', () => {
  const { context } = runtime({});
  const videos = { motionArtistSquare1x1: square, motionArtistWide16x9: wide };
  assert.equal(context.motionArtworkVideoURL(videos), '');
  videos.motionDetailTall = { video: 'https://example.test/tall.m3u8' };
  assert.equal(context.motionArtworkVideoURL(videos), videos.motionDetailTall.video);
});

test('large artist catalog returns its first page without draining pagination', () => {
  const { context } = runtime({});
  const calls = [];
  context.apiGet = (request) => {
    calls.push(request);
    assert.match(request, /^artists\/123\?/);
    assert.match(request, /limit\[albums\]=100/);
    return { data: [{ id: '123', attributes: { name: 'Composer' }, relationships: {
      albums: { data: [{ id: 'a', attributes: { name: 'Album' } }],
        next: '/v1/catalog/us/artists/123/albums?offset=100' },
    } }] };
  };
  const artist = context.getArtist('123');
  assert.equal(calls.length, 1);
  assert.equal(artist.albums.length, 1);
  assert.equal(artist.albums_next, '123:albums:100');
});

test('continuation loads exactly one album page and preserves the artist ID', () => {
  const { context } = runtime({});
  const calls = [];
  context.apiGet = (request) => {
    calls.push(request);
    return { data: [{ id: 'b', attributes: { name: 'Next album' } }],
      next: '/v1/catalog/us/artists/123/albums?offset=200' };
  };
  const artist = context.getArtist('123:albums:100');
  assert.deepEqual(calls, ['artists/123/albums?limit=100&offset=100']);
  assert.equal(artist.id, '123');
  assert.equal(artist.albums[0].artist_id, '123');
  assert.equal(artist.albums[0].name, 'Next album');
  assert.equal(artist.albums_next, '123:albums:200');
});

test('empty pages and non-advancing cursors terminate artist pagination', () => {
  for (const data of [[], [{ id: 'a' }]]) {
    const { context } = runtime({});
    context.apiGet = () => ({ data, next: '/v1/catalog/us/artists/123/albums?offset=100' });
    assert.equal(context.getArtist('123:albums:100').albums_next, '');
  }
});

test('artist top songs do not fetch every track of their albums', () => {
  const { context } = runtime({});
  let hydrateTracks;
  context.hydrateAlbumsForSongs = (_, includeTracks) => {
    hydrateTracks = includeTracks;
    return {};
  };
  context.apiGet = () => ({ data: [{ id: '123', attributes: {},
    views: { 'top-songs': { data: [] } } }] });
  context.getArtist('123');
  assert.equal(hydrateTracks, false);
});
