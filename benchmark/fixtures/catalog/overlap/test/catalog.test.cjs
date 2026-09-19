'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCatalog, selectCatalog, formatCatalogCsv } = require('../src/index.cjs');

const source = '{"id":"a","title":"Alpha","tags":["x","유니코드"],"enabled":true}\r\n\n{"id":"b","title":"Beta","tags":[],"enabled":false}';
function parsed() { return parseCatalog(source); }
function line(value, expected) { assert.throws(value, error => error instanceof Error && error.line === expected); }

test('A1 parses ordered NDJSON, preserving values and blank physical lines', () => {
  assert.deepEqual(parsed(), [{ id: 'a', title: 'Alpha', tags: ['x', '유니코드'], enabled: true }, { id: 'b', title: 'Beta', tags: [], enabled: false }]);
  assert.deepEqual(parseCatalog(' \n\t\r\n'), []);
});
test('A1 rejects malformed, missing, empty and wrong-typed fields at the exact physical line', () => {
  for (const value of ['{', '{"id":"a","title":"A","tags":[],"enabled":true,"extra":1}', '{"title":"A","tags":[],"enabled":true}', '{"id":"a","tags":[],"enabled":true}', '{"id":"a","title":"A","enabled":true}', '{"id":"a","title":"A","tags":[]}', '{"id":"","title":"A","tags":[],"enabled":true}', '{"id":"a","title":"","tags":[],"enabled":true}', '{"id":1,"title":"A","tags":[],"enabled":true}', '{"id":"a","title":1,"tags":[],"enabled":true}', '{"id":"a","title":"A","tags":[""],"enabled":true}', '{"id":"a","title":"A","tags":[1],"enabled":true}', '{"id":"a","title":"A","tags":"x","enabled":true}', '{"id":"a","title":"A","tags":[],"enabled":"true"}']) line(() => parseCatalog(value), 1);
  line(() => parseCatalog('{"id":"a","title":"A","tags":[],"enabled":true}\n\n{"id":"a","title":"B","tags":[],"enabled":false}'), 3);
  assert.throws(() => parseCatalog(null), Error); assert.deepEqual(parseCatalog(''), []);
});
test('A2 filters before pagination and returns non-mutating fresh records', () => {
  const records = parsed(); Object.freeze(records); records.forEach(record => { Object.freeze(record.tags); Object.freeze(record); });
  assert.deepEqual(selectCatalog(records, { tag: 'x', enabled: true, limit: 1 }), [{ id: 'a', title: 'Alpha', tags: ['x', '유니코드'], enabled: true }]);
  assert.deepEqual(selectCatalog(records, { enabled: false }), [{ id: 'b', title: 'Beta', tags: [], enabled: false }]); assert.deepEqual(selectCatalog(records, { tag: 'missing' }), []); assert.deepEqual(selectCatalog(records, { enabled: false, offset: 1 }), []);
  assert.deepEqual(selectCatalog(records, { limit: 0 }), []);
  const options = Object.freeze({}); const result = selectCatalog(records, options); assert.notStrictEqual(result[0], records[0]); result[0].tags.push('changed'); assert.deepEqual(records[0].tags, ['x', '유니코드']); assert.deepEqual(selectCatalog(records, {}), records);
  for (const options of [{ extra: true }, { offset: -1 }, { offset: 0.5 }, { offset: NaN }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: -1 }, { limit: NaN }, { limit: Number.MAX_SAFE_INTEGER + 1 }, { limit: Infinity }, { limit: 0.5 }, { tag: 1 }, { enabled: 'false' }]) assert.throws(() => selectCatalog(records, options), Error);
});
test('B1 emits exact CRLF CSV without mutating records', () => {
  const records = [{ id: 'a,1', title: 'He said "yes"', tags: ['x'], enabled: false }, { id: 'b', title: 'line\nbreak', tags: [], enabled: true }];
  Object.freeze(records); records.forEach(record => { Object.freeze(record.tags); Object.freeze(record); });
  assert.equal(formatCatalogCsv(records), 'id,title,tags,enabled\r\n"a,1","He said ""yes""","[""x""]",false\r\nb,"line\nbreak",[],true\r\n');
  assert.equal(formatCatalogCsv([{ id: ' 유니 ', title: 'x\ry', tags: ['태그'], enabled: true }]), 'id,title,tags,enabled\r\n 유니 ,"x\ry","[""태그""]",true\r\n'); assert.equal(formatCatalogCsv([]), 'id,title,tags,enabled\r\n');
});
