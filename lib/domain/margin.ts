import {money,type Row} from './analytics.ts';

/**
 * AC 費（服務費）= 報價小計 × 服務費率，視為該報價的毛利。
 * 報價未稅 = 小計 ×（1＋費率）－未稅折扣，所以 AC 費 =（未稅＋折扣）× 費率 ÷（1＋費率）。
 * 沒填服務費率或未稅金額時回傳 null（待補），不當成 0。
 */
export function acFee(quote:Row):number|null{
 const raw=money(quote.feeRate),net=money(quote.net);
 if(raw===null||net===null)return null;
 const rate=raw>1?raw/100:raw;
 return Math.round((net+(money(quote.discountNet)??0))*rate/(1+rate));
}
/** Sum for the quotes that count for one case; null when there are none or any is missing its rate. */
export function acFeeOf(quotes:Row[]):number|null{
 if(!quotes.length)return null;
 const fees=quotes.map(acFee);
 return fees.some(f=>f===null)?null:fees.reduce<number>((t,f)=>t+f!,0);
}
