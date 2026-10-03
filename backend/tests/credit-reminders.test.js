import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDIT_REMINDER_GAP_MS,
  buildCreditReminder,
  creditReminderIsDue
} from '../credit-reminders.js';

const day = (n) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));

describe('3-day customer credit SMS reminders', () => {
  it('is not due the day after the shop lent the goods', () => {
    assert.equal(creditReminderIsDue({
      lentAt: day(3),
      lastReminderAt: null,
      matched: false,
      now: day(4)
    }), false);
  });

  it('is due after three days if the customer has not paid', () => {
    assert.equal(creditReminderIsDue({
      lentAt: day(1),
      lastReminderAt: null,
      matched: false,
      now: day(4)
    }), true);
  });

  it('stops once the debt is marked paid', () => {
    assert.equal(creditReminderIsDue({
      lentAt: day(1),
      lastReminderAt: null,
      matched: true,
      now: day(8)
    }), false);
  });

  it('does not nag again until another three days pass', () => {
    assert.equal(creditReminderIsDue({
      lentAt: day(1),
      lastReminderAt: day(4),
      matched: false,
      now: day(5)
    }), false);
    assert.equal(creditReminderIsDue({
      lentAt: day(1),
      lastReminderAt: day(4),
      matched: false,
      now: new Date(day(4).getTime() + CREDIT_REMINDER_GAP_MS)
    }), true);
  });

  it('writes English and Kiswahili copy for the customer and the shop', () => {
    const customerEn = buildCreditReminder({
      shopName: 'Kibera Fresh',
      item: 'Sugar',
      amount: 50,
      language: 'en',
      toCustomer: true
    });
    assert.match(customerEn, /Kibera Fresh/);
    assert.match(customerEn, /Sugar/);
    assert.match(customerEn, /KSh 50/);
    assert.match(customerEn, /restock/);

    const customerSw = buildCreditReminder({
      shopName: 'Kibera Fresh',
      item: 'Sukari',
      amount: 50,
      language: 'sw',
      toCustomer: true
    });
    assert.match(customerSw, /kwa deni/);
    assert.match(customerSw, /stock/);

    const shopEn = buildCreditReminder({
      shopName: 'Kibera Fresh',
      item: 'Sugar',
      amount: 50,
      customerName: 'Mama',
      language: 'en',
      toCustomer: false
    });
    assert.match(shopEn, /Mama still owes/);
  });
});
