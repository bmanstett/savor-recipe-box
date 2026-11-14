import assert from 'node:assert/strict';
import { createShareInbox } from '../lib/share-inbox.ts';

const APP = 'https://bmanstett.github.io/savor-recipe-box/';
const first = 'https://cooking.nytimes.com/recipes/123-example?smid=share';
const second = 'https://www.instagram.com/reel/example/?igsh=a%2Bb';
const saved = new Map<string, string>();
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
  removeItem: (key: string) => { saved.delete(key); },
};
const inbox = createShareInbox(storage, APP);
assert.equal(inbox.enqueue(first), 'added');
assert.equal(inbox.enqueue(first), 'duplicate');
assert.equal(inbox.enqueue(second), 'added');
assert.deepEqual(inbox.urls, [first, second], 'a second share waits without replacing the current link');
inbox.urls.shift();
assert.deepEqual(inbox.urls, [first, second], 'rendering the inbox cannot mutate it');
assert.deepEqual(createShareInbox(storage, APP).urls, [first, second], 'links survive a tab refresh until review completes');
inbox.complete(first);
assert.deepEqual(inbox.urls, [second]);
assert.deepEqual(createShareInbox(storage, APP).urls, [second], 'finishing one review keeps the next share');
inbox.complete(second);
assert.equal(saved.size, 0);
assert.deepEqual(createShareInbox(storage, APP).urls, []);

for (const url of ['javascript:alert(1)', 'https://127.0.0.1/private', 'https://user:password@example.com/', APP, `${APP}#share?url=${encodeURIComponent(first)}`]) {
  assert.equal(inbox.enqueue(url), 'invalid');
}
assert.deepEqual(inbox.urls, []);
for (let index = 0; index < 20; index++) assert.equal(inbox.enqueue(`https://recipes.example.com/${index}`), 'added');
assert.equal(inbox.enqueue('https://recipes.example.com/overflow'), 'full');
assert.equal(inbox.urls.length, 20);
assert.equal(inbox.urls[0], 'https://recipes.example.com/0', 'a full inbox never discards an earlier recipe');

for (const stored of ['not JSON', '{"url":"secret"}', 'x'.repeat(160_001)]) {
  const malformed = createShareInbox({ ...storage, getItem: () => stored }, APP);
  assert.deepEqual(malformed.urls, []);
  assert.equal(malformed.enqueue(first), 'added');
}
const tampered = createShareInbox({ ...storage, getItem: () => JSON.stringify([first, first, 'https://localhost/private', {}, second]) }, APP);
assert.deepEqual(tampered.urls, [first, second]);
const unavailable = {
  getItem: () => { throw new Error('storage denied'); },
  setItem: () => { throw new Error('quota exceeded'); },
  removeItem: () => { throw new Error('storage denied'); },
};
for (const backend of [null, unavailable]) {
  const memory = createShareInbox(backend, APP);
  assert.equal(memory.enqueue(first), 'added');
  assert.deepEqual(memory.urls, [first]);
  memory.complete(first);
  assert.deepEqual(memory.urls, []);
}
console.log('Shared recipe inbox tests passed: persistence, order, duplicate delivery, capacity, recovery, and denied storage.');
