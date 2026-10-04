import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWeeklyReportTick, readSchedulerConfig } from '../scheduler.js';

describe('scheduler config', () => {
  it('defaults to Sunday 20:00 till slips and 6-hourly credit reminders', () => {
    const config = readSchedulerConfig({});
    assert.equal(config.reportCron, '0 20 * * 0');
    assert.equal(config.creditCron, '0 */6 * * *');
    assert.equal(config.demoShop, null);
    assert.equal(config.demoRepeat, false);
  });

  it('turns a job off with "off"', () => {
    const config = readSchedulerConfig({ REPORT_SMS_CRON: 'off', CREDIT_REMINDER_CRON: 'OFF' });
    assert.equal(config.reportCron, null);
    assert.equal(config.creditCron, null);
  });

  it('only allows repeat sends when fenced to one demo shop', () => {
    assert.equal(readSchedulerConfig({ SMS_DEMO_REPEAT: '1' }).demoRepeat, false);
    const demo = readSchedulerConfig({ SMS_DEMO_SHOP: 'mama-njeri', SMS_DEMO_REPEAT: '1', REPORT_SMS_CRON: '*/2 * * * *' });
    assert.equal(demo.demoRepeat, true);
    assert.equal(demo.reportCron, '*/2 * * * *');
    assert.equal(demo.demoMaxSends, 3);
  });
});

describe('weekly till-slip tick', () => {
  it('runs every shop on the normal weekly schedule', async () => {
    const calls = [];
    const tick = createWeeklyReportTick(readSchedulerConfig({}), { runJob: async (opts) => { calls.push(opts); return { sent: 2 }; } });
    await tick();
    assert.deepEqual(calls, [undefined]);
  });

  it('in demo mode targets only the demo shop and sends even with no sales', async () => {
    const calls = [];
    const findShops = () => [{ id: 'mama-njeri' }];
    const config = readSchedulerConfig({ SMS_DEMO_SHOP: 'mama-njeri' });
    const tick = createWeeklyReportTick(config, { findShops, runJob: async (opts) => { calls.push(opts); return { sent: 1 }; } });
    await tick();
    assert.equal(calls[0].listBusinesses, findShops);
    assert.equal(calls[0].allowEmpty, true);
    assert.equal(calls[0].trigger, 'schedule'); // once a week unless repeat is on
  });

  it('stops repeating after the demo send limit to protect the balance', async () => {
    let runs = 0;
    const config = readSchedulerConfig({ SMS_DEMO_SHOP: 'mama-njeri', SMS_DEMO_REPEAT: '1', SMS_DEMO_MAX_SENDS: '2' });
    const tick = createWeeklyReportTick(config, {
      findShops: () => [],
      runJob: async (opts) => { runs += 1; assert.equal(opts.trigger, 'manual'); return { sent: 1 }; }
    });
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(runs, 2);
  });
});
