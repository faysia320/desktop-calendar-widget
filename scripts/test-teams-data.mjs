import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = readFileSync(new URL('../src/teamsData.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
compileFunction(output, ['require', 'module', 'exports'])(() => ({ invoke: () => { throw Error('Unexpected native call'); } }), module, module.exports);
const { TeamsData } = module.exports;
const channel = id => ({ id, teamId: 'team', channelId: id, name: id, url: '' });
const page = (time = 100, account = 'account-a', body = '') => ({ account_id: account, next: null, messages: [{ id: 'message', other_activity: time, body }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('deduplicates in-flight calls, reuses fresh pages and refreshes expired pages', async () => {
  let now = 0, calls = 0, release;
  const data = new TeamsData(async () => { calls++; await new Promise(r => { release = r; }); return page(); }, () => now);
  const one = data.fetch(channel('a')), two = data.fetch(channel('a'));
  await tick(); assert.equal(calls, 1); release(); await Promise.all([one, two]);
  await data.fetch(channel('a')); assert.equal(calls, 1);
  now = 46_000;
  const three = data.fetch(channel('a')); await tick(); assert.equal(calls, 2); release(); await three;
});

test('limits requests to two, rejects stale mutations and clears data across account reconnects', async () => {
  const releases = [];
  let running = 0, maximum = 0;
  const data = new TeamsData(async () => { running++; maximum = Math.max(maximum, running); await new Promise(r => releases.push(r)); running--; return page(); });
  const results = Promise.allSettled(['a', 'b', 'c'].map(id => data.fetch(channel(id))));
  await tick(); assert.equal(releases.length, 2);
  data.mutate(channel('a'), null);
  releases.shift()(); await tick(); assert.equal(releases.length, 2);
  data.reset(); releases.splice(0).forEach(r => r());
  const settled = await results;
  assert.equal(maximum, 2); assert(settled.every(result => result.status === 'rejected'));
  assert.equal(data.peek(channel('a')), undefined);
  assert.equal(data.peek(channel('b')), undefined);
});

test('persists read baselines, keeps new arrivals unread during older mark saves and separates accounts', async () => {
  const disk = {}; let current = page(), delayed, delay = false;
  const call = async (command, args) => {
    if (command === 'teams_load_read_marks') return { ...disk };
    if (command === 'teams_messages') return structuredClone(current);
    if (command === 'teams_mark_read') {
      if (delay) await new Promise(r => { delayed = r; });
      return disk[args.key] = Math.max(disk[args.key] ?? 0, args.timestamp);
    }
    throw Error(command);
  };
  const data = new TeamsData(call);
  await data.initialize(); await data.fetch(channel('a')); await tick();
  assert.equal(data.unread('a'), false);
  current = page(200); await data.fetch(channel('a'), null, null, true);
  assert.equal(data.unread('a'), true);
  delay = true;
  const mark = data.markRead('a', 'account-a', 200);
  current = page(300); await data.fetch(channel('a'), null, null, true);
  delayed(); await mark; delay = false;
  assert.equal(data.unread('a'), true);
  const reopened = new TeamsData(call); await reopened.initialize(); await reopened.fetch(channel('a'));
  assert.equal(reopened.unread('a'), true);
  await reopened.markRead('a', 'account-a', 300); assert.equal(reopened.unread('a'), false);
  current = page(400, 'account-b'); reopened.reset(); await reopened.fetch(channel('a')); await tick();
  assert.equal(reopened.unread('a'), false); assert.equal(Object.keys(disk).length, 2);
});

test('failed mark writes remain unread and corrupt metadata is never overwritten', async () => {
  let saves = 0;
  const data = new TeamsData(async command => {
    if (command === 'teams_load_read_marks') throw Error('corrupt');
    if (command === 'teams_mark_read') { saves++; return 200; }
    return page(200);
  });
  await data.initialize(); await data.fetch(channel('a')); await data.markRead('a', 'account-a', 200);
  assert.equal(saves, 0); assert.match(data.error, /corrupt/);
  const second = new TeamsData(async command => {
    if (command === 'teams_load_read_marks') return { '["account-a","a"]': 100 };
    if (command === 'teams_mark_read') throw Error('write failed');
    return page(200);
  });
  await second.initialize(); await second.fetch(channel('a')); await second.markRead('a', 'account-a', 200);
  assert.equal(second.unread('a'), true); assert.match(second.error, /write failed/);
});

test('429 applies Retry-After across channels, including manual refresh', async () => {
  let now = 0, calls = 0;
  const data = new TeamsData(async () => { calls++; throw 'Teams 요청이 많습니다. 120초 후 새로고침해 주세요.'; }, () => now);
  await assert.rejects(data.fetch(channel('a')));
  await assert.rejects(data.fetch(channel('b'), null, null, true)); assert.equal(calls, 1);
  now = 121_000; await assert.rejects(data.fetch(channel('b'))); assert.equal(calls, 2);
});

test('cache evicts least recently used pages under byte and page budgets', async () => {
  let big = false;
  const data = new TeamsData(async () => page(100, 'a', big ? 'x'.repeat(2_000_000) : ''));
  for (let i = 0; i < 101; i++) await data.fetch(channel(String(i)));
  assert.equal(data.peek(channel('0')), undefined); assert(data.peek(channel('1')));
  big = true;
  await data.fetch(channel('large-a')); await data.fetch(channel('large-b')); await data.fetch(channel('large-c'));
  assert.equal(data.peek(channel('large-a')), undefined); assert(data.peek(channel('large-c')));
});
