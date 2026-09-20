'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Telegram command integrity', () => {
  let db;
  let getSetting;
  let webhookPOST;
  let originalFetch;
  let originalChatId;
  let sent;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-telegram-command-');
    db = env.db;
    env.setSetting('telegram_bot_token', 'test-token');
    ({ getSetting } = env.requireLib('db.ts'));
    originalFetch = global.fetch;
    originalChatId = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_CHAT_ID;
    sent = [];
    global.fetch = async (url, init = {}) => {
      if (String(url).includes('/sendMessage')) sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const webhookPath = require.resolve('../../src/app/api/telegram/webhook/route.ts');
    delete require.cache[webhookPath];
    ({ POST: webhookPOST } = require(webhookPath));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChatId;
  });

  async function sendText(text, chatId = 12345, updateId) {
    return webhookPOST(new Request('http://lifeos.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: updateId, message: { chat: { id: chatId }, text } }),
    }));
  }

  it('binds the first private /start contact without a competing getUpdates call', async () => {
    const response = await sendText('/start');
    assert.equal(response.status, 200);
    assert.equal(getSetting('telegram_chat_id'), '12345');
    assert.match(sent.at(-1)?.text || '', /Guardian/i);
  });

  it('runs direct create commands deterministically', async () => {
    await sendText('/start');
    await sendText('/addtask Write transport regression tests');
    await sendText('/addgoal Make Telegram reliable');

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE title = ?').get('Write transport regression tests').count, 1);
    assert.deepEqual(
      db.prepare('SELECT title, type FROM goals WHERE title = ?').get('Make Telegram reliable'),
      { title: 'Make Telegram reliable', type: 'general' },
    );
  });

  it('deduplicates a retried mutating Telegram update', async () => {
    await sendText('/start');
    await sendText('/addtask Retry-safe task', 12345, 7001);
    const duplicate = await sendText('/addtask Retry-safe task', 12345, 7001);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title = 'Retry-safe task'").get().count, 1);
  });

  it('runs direct delete, weekly, pause, and resume commands without the LLM', async () => {
    await sendText('/start');
    db.prepare("INSERT INTO tasks (title, status) VALUES ('Temporary Telegram task', 'todo')").run();
    db.prepare("INSERT INTO goals (title, type) VALUES ('Temporary Telegram goal', 'general')").run();
    db.prepare("INSERT INTO habits (name, frequency) VALUES ('Temporary Telegram habit', 'daily')").run();

    await sendText('/deletetask Temporary Telegram task');
    await sendText('/deletegoal Temporary Telegram goal');
    await sendText('/deletehabit Temporary Telegram habit');
    await sendText('/weekly');
    await sendText('/pause');
    assert.equal(getSetting('coaching_paused'), 'true');
    await sendText('/resume');
    assert.equal(getSetting('coaching_paused'), 'false');

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title = 'Temporary Telegram task'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM goals WHERE title = 'Temporary Telegram goal'").get().count, 0);
    assert.equal(db.prepare("SELECT archived FROM habits WHERE name = 'Temporary Telegram habit'").get().archived, 1);
    assert.ok(sent.some(message => /Weekly/i.test(message.text || '')));
  });

  it('publishes every supported command with an explicit time scope when relevant', () => {
    let catalog = null;
    try { catalog = require('../../src/lib/telegram-command-catalog.ts'); } catch { /* RED until catalog exists */ }
    assert.ok(Array.isArray(catalog?.TELEGRAM_COMMANDS));
    const commands = new Map(catalog.TELEGRAM_COMMANDS.map(item => [item.command, item.description]));
    for (const name of ['start', 'menu', 'status', 'tasks', 'habits', 'goals', 'plan', 'weekly', 'standup', 'morning', 'journal', 'review', 'report', 'session', 'endsession', 'addtask', 'deletetask', 'addgoal', 'deletegoal', 'addhabit', 'deletehabit', 'pause', 'resume', 'help']) {
      assert.ok(commands.has(name), `missing /${name}`);
    }
    for (const name of ['status', 'tasks', 'habits', 'plan', 'weekly', 'standup', 'morning', 'journal', 'review', 'report', 'session']) {
      assert.match(commands.get(name), /live|today|tomorrow|current week|now/i, `/${name} lacks time scope`);
    }
  });
});
