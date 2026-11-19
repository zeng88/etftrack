import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDashboard } from '../src/db.ts';

test('dashboard reconstructs recent turnover and previous 20-day average from activity', async () => {
  const db = { prepare(sql) {
    const q = { bind(...args) { this.args = args; return this; },
      async first() { if (sql.includes('MAX(trade_date)')) return {d:'20261118'}; return null; },
      async all() {
        if (sql.includes('FROM daily_snapshots s JOIN etfs')) return {results:[{code:'510300',tcode:'sh510300',name:'ETF',index_name:'沪深300',group_name:'core',huijin_yi:null,payload_json:JSON.stringify({date:'20261118',amount_yi:12,day_progress:1}),source_ts:'x',source:'x'}]};
        if (sql.includes('FROM daily_activity') && sql.includes('ROW_NUMBER')) return {results:[
          {code:'510300',trade_date:'20261118',amount_yi:12,volume_lots:10,history_rank:1,average_rank:null},
          {code:'510300',trade_date:'20261117',amount_yi:20,volume_lots:9,history_rank:2,average_rank:1},
          {code:'510300',trade_date:'20261116',amount_yi:40,volume_lots:8,history_rank:3,average_rank:2},
        ]};
        return {results:[]};
      }}; return q;
  }};
  const data = await loadDashboard(db);
  assert.equal(data.etfs[0].avg20_yi,30);
  assert.deepEqual(data.etfs[0].hist.map(x=>x.date),['20261116','20261117','20261118']);
  assert.equal(data.summary.avg20_yi,30);
});
