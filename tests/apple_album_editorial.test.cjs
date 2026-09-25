const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const notes of [
  { standard: '<p>A <i>new</i> direction &amp; sound.</p>', short: 'A new direction.' },
  { short: 'A short album introduction.' },
  undefined,
]) {
  test(`album editorial notes survive catalog and URL exports (${notes ? Object.keys(notes) : 'none'})`, () => {
    const context = vm.createContext({
      registerExtension() {},
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    vm.runInContext(fs.readFileSync(
      path.join(__dirname, '../sources/apple-music/index.js'), 'utf8'
    ), context);
    context.apiGet = () => ({ data: [{
      id: 'album-1', attributes: { name: 'Example Album', editorialNotes: notes },
      relationships: { tracks: { data: [] } },
    }] });
    const direct = context.getAlbum('album-1');
    const linked = context.handleURL('https://music.apple.com/us/album/example/12345');
    for (const album of [direct, linked.album]) {
      assert.deepEqual(JSON.parse(JSON.stringify(album.editorial_notes)), notes || null);
    }
  });
}
