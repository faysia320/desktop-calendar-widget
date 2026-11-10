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

test('reaction member lookups deduplicate, expire, back off and reset with accounts', async () => {
  let now = 0, calls = 0, fail = false;
  const data = new TeamsData(async command => {
    assert.equal(command, 'teams_members'); calls++;
    if (fail) throw Error('permission');
    return [{ userId: 'user', displayName: '김민수', email: '' }];
  }, () => now);
  const a = channel('a');
  const results = await Promise.all([data.members(a, 'me'), data.members(a, 'me')]);
  assert.equal(calls, 1); assert.equal(results[0][0].displayName, '김민수');
  await data.members(a, 'another-account'); assert.equal(calls, 2);
  now = 301_000; await data.members(a, 'me'); assert.equal(calls, 3);
  data.reset(); fail = true;
  await assert.rejects(data.members(a, 'me'));
  await assert.rejects(data.members(a, 'me')); assert.equal(calls, 4);
  now += 31_000; fail = false; await data.members(a, 'me'); assert.equal(calls, 5);
});

test('mention badge follows widget read marks; only fresh channel heads observe notifications', async () => {
  const marks = { '["account-a","a"]': 100 };
  let observations = 0, fail = false;
  const current = page(300);
  current.messages[0].mentions_me = [{ id: 'reply', time: 200 }];
  const data = new TeamsData(async (command, args) => {
    if (command === 'teams_load_read_marks') return { ...marks };
    if (command === 'teams_mark_read') return marks[args.key] = args.timestamp;
    if (command === 'teams_messages') return structuredClone(current);
    if (command === 'teams_observe_mentions') { observations++; if (fail) throw Error('notification failed'); }
  });
  await data.initialize(); await data.fetch(channel('a'));
  assert.equal(data.mentioned('a'), true); assert.equal(observations, 1);
  await data.fetch(channel('a')); await data.fetch(channel('a'), 'parent'); await data.fetch(channel('a'), null, 'next');
  assert.equal(observations, 1);
  await data.markRead('a', 'account-a', 200);
  assert.equal(data.mentioned('a'), false); assert.equal(data.unread('a'), true);
  fail = true; await data.fetch(channel('a'), null, null, true);
  assert.match(data.notificationError, /notification failed/); assert(data.peek(channel('a')));
  fail = false; await data.fetch(channel('a'), null, null, true);
  assert.equal(data.notificationError, '');
  data.reset(); assert.equal(data.mentioned('a'), false);
});

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
  assert.equal(reopened.unread('a'), false);
  const keys = Object.keys(disk);
  assert.equal(keys.filter(key => !key.includes('builtin:activity')).length, 2);
  assert.equal(keys.length, 4);
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

test('chats baseline unread state and send only others\' latest messages as notices', async () => {
  const marks = {}, notices = [];
  let chats = [
    { id: 'c1', name: '상대', chat_type: 'oneOnOne', url: 'https://teams.microsoft.com/l/chat/c1', updated: 100,
      last: { id: 'm1', time: 100, author: '상대', body: '<p>안녕 &amp; <img alt="x"></p>', body_type: 'html', mine: false } },
    { id: 'c2', name: '내 글', chat_type: 'group', url: 'https://teams.microsoft.com/l/chat/c2', updated: 90,
      last: { id: 'm2', time: 90, author: '나', body: 'hi', body_type: 'text', mine: true } },
  ];
  const data = new TeamsData(async (command, args) => {
    if (command === 'teams_load_read_marks') return {};
    if (command === 'teams_mark_read') return marks[args.key] = args.timestamp;
    if (command === 'teams_chats') return { chats: structuredClone(chats), account_id: 'me' };
    if (command === 'teams_observe_chats') { notices.push(args.chats); return; }
    throw Error(command);
  });
  await data.initialize(); await data.refreshChats(); await tick();
  assert.deepEqual(notices[0].map(notice => notice.id), ['m1']);
  assert.equal(notices[0][0].text, '안녕 & [이미지]');
  assert.equal(data.chatsUnread(), false);
  chats[0] = { ...chats[0], last: { ...chats[0].last, id: 'm3', time: 300 } };
  await data.refreshChats();
  assert.equal(data.unread('chat:c1'), true); assert.equal(data.chatsUnread(), true);
  await data.markRead('chat:c1', 'me', 300);
  assert.equal(data.chatsUnread(), false);
});

test('background scans notify mentions without caching pages or unread state', async () => {
  let observed = 0;
  const current = page(300);
  current.messages[0].mentions_me = [];
  const data = new TeamsData(async command => {
    if (command === 'teams_load_read_marks') return {};
    if (command === 'teams_observe_mentions') { observed++; return; }
    if (command === 'teams_messages') return structuredClone(current);
    throw Error(command);
  });
  await data.initialize();
  await data.fetch(channel('scan'), null, null, false, true);
  assert.equal(observed, 1); assert.equal(data.peek(channel('scan')), undefined); assert.equal(data.unread('scan'), false);
  await data.fetch({ ...channel('chat:x'), chatId: 'x' });
  assert.equal(observed, 1);
});

test('activity feed rebuilds from fresh pages, baselines once and counts newer items', async () => {
  const marks = {};
  const act = (kind, id, time, parent = null) => ({ kind, time, actors: [{ id: 'u', name: '동료' }], emojis: [], message_id: id, parent_id: parent, body: '', body_type: 'text', web_url: null });
  let current = { account_id: 'me', next: null, messages: [{ id: 'root', other_activity: 0, activities: [act('reply', 'r1', 100, 'root')] }] };
  let now = 1_000;
  const data = new TeamsData(async (command, args) => {
    if (command === 'teams_load_read_marks') return {};
    if (command === 'teams_mark_read') return marks[args.key] = args.timestamp;
    if (command === 'teams_messages') return structuredClone(current);
    if (command === 'teams_observe_mentions') return;
    throw Error(command);
  }, () => now);
  await data.initialize(); await data.fetch(channel('a'), null, null, false, true); await tick();
  assert.equal(data.activities().length, 1); assert.equal(data.activityUnread(), 0);
  current.messages[0].activities = [act('reaction', 'root', 2_000)];
  now = 3_000; await data.fetch(channel('a'), null, null, true, true);
  assert.deepEqual(data.activities().map(item => item.kind), ['reaction']);
  assert.equal(data.activityUnread(), 1);
  await data.markRead('builtin:activity', 'me', 2_000); assert.equal(data.activityUnread(), 0);
  data.reset(); assert.equal(data.activities().length, 0);
});
