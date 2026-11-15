import test from 'node:test';
import assert from 'node:assert/strict';
import {activityView,headcountOf} from '../lib/domain/calendar.ts';

const item=(description,quantity,unit='位',quoteId='q')=>({quoteId,description,quantity,unit});
test('headcount uses the insurance line, else the per-person shift lines',()=>{
 assert.equal(headcountOf([item('10/1 08:00-17:00',20),item('10/2 08:00-17:00',30),item('餐費',50),item('保險費 勞保',50),item('督導',2,'天')]),50);
 assert.equal(headcountOf([item('活動PT',6),item('進場PT',4),item('餐費',10),item('人頭費',10),item('貨運',1,'式')]),10);
 assert.equal(headcountOf([item('主持人',2,'天'),item('道具',1,'式')]),null);assert.equal(headcountOf([]),null);
});
test('activities are listed upcoming first with state, 14-day window and headcount',()=>{
 const c=o=>({id:'c',number:'A901',title:'示範',clientId:'k',stage:'成交',lost:false,...o});
 const cases=[c({id:'past',activityStart:'2026-11-01',activityEnd:'2026-11-02'}),c({id:'now',activityStart:'2026-11-15',activityEnd:'2026-11-17'}),c({id:'soon',activityStart:'2026-11-20'}),c({id:'far',activityStart:'2027-03-22',activityEnd:'2027-03-31'}),c({id:'none'}),c({id:'lost',lost:true,activityStart:'2026-11-18'})];
 const latest=[{caseIds:['soon'],net:1000,quotes:[{id:'q',caseId:'soon'}]}];
 const v=activityView(cases,latest,[item('11/20 PT',9),item('保費',12)],'2026-11-16');
 assert.deepEqual(v.rows.map(r=>r.caseId),['now','soon','far','past']);
 assert.deepEqual(v.rows.map(r=>r.state),['進行中','即將開始','即將開始','已結束']);
 assert.deepEqual(v.rows.map(r=>r.soon),[true,true,false,false]);
 assert.equal(v.rows[1].headcount,12);assert.equal(v.rows[1].daysUntil,4);assert.equal(v.rows[0].days,3);assert.equal(v.rows[2].days,10);
 assert.deepEqual(v.totals.soon,{count:2,headcount:12,unknown:1});assert.equal(v.totals.month.count,3);assert.equal(v.totals.upcoming.count,3);assert.equal(v.undated,1);
});
