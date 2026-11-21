import test from 'node:test';
import assert from 'node:assert/strict';
import {periodYears} from '../lib/domain/analytics.ts';

test('period picker offers every data year plus this year and next, newest first', () => {
  const data = {quotes: [{date: '3/19/2023'}, {date: ''}, {date: '2024-05-01'}], invoices: [{date: '2025-01-02'}, {date: null}]};
  assert.deepEqual(periodYears(data, '2026-11-21'), [2027, 2026, 2025, 2024, 2023]);
});

test('period picker still offers this year and next before data loads', () => {
  assert.deepEqual(periodYears(undefined, '2026-11-21'), [2027, 2026]);
});

test('quarter picker boundaries: the first month of each quarter lands in that quarter', async () => {
  const {makePeriod} = await import('../lib/domain/analytics.ts');
  for (const [anchor, label] of [['2025-03-01','2025 年 Q1'],['2025-04-01','2025 年 Q2'],['2025-09-01','2025 年 Q3'],['2025-10-01','2025 年 Q4']]) {
    assert.equal(makePeriod('quarter', anchor, '2026-11-21').label, label);
  }
  assert.deepEqual([makePeriod('quarter','2025-10-01','2026-11-21').start, makePeriod('quarter','2025-10-01','2026-11-21').end], ['2025-10-01','2025-12-31']);
});
