'use strict';
const calendar = require('./availability-calendar');
const TERMINAL = new Set(['completed','cancelled','archived','failed']);
const minute = value => /^\d{2}:\d{2}$/.test(String(value)) ? Number(value.slice(0,2))*60+Number(value.slice(3,5)) : null;
const clock = value => `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;

function intervals(hours, weekday) {
  const allowed=hours.allowed_weekdays||hours.weekdays||hours.days;
  if(Array.isArray(allowed)&&allowed.length&&!allowed.map(Number).includes(weekday))return [];
  const perDay=hours.intervals_by_weekday||hours.intervalsByWeekday;
  const keyed=perDay?.[weekday];
  const source=Array.isArray(keyed)&&keyed.length ? keyed : hours.start_time&&hours.end_time ? [hours] : [];
  const ranges=source.map(r=>[minute(r.start_time||r.start),minute(r.end_time||r.end)])
    .filter(([a,b])=>a!==null&&b!==null&&a>=0&&b<=1440&&b>a).sort((a,b)=>a[0]-b[0]);
  // Overlapping windows must not double-count capacity.
  return ranges.reduce((out,r)=>{const last=out[out.length-1];if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else out.push([...r]);return out;},[]);
}
function countSlots(ranges, delay, batch, start=0) {
  let next=start,count=0;
  for(const [from,to] of ranges){next=Math.max(next,from);if(next>=to)continue;const n=Math.ceil((to-next)/delay);count+=n*batch;next+=(n*delay);}
  return count;
}
function deliveryPlan(dispatch={}, {now=new Date(),pending=Infinity,status='sending'}={}) {
  const governance=dispatch.delivery_governance||{}, hours=dispatch.business_hours||{};
  const batch=Math.max(1,Number(governance.effective_batch_size||dispatch.batch_size||1));
  const delay=Number(governance.effective_delay_ms||dispatch.delay_ms)/60000;
  if(!Number.isFinite(delay)||delay<=0)return null;
  const byWeekday=Array.from({length:7},(_,i)=>{const ranges=intervals(hours,i+1);return {weekday:i+1,capacity:countSlots(ranges,delay,batch),windows:ranges.map(([a,b])=>`${clock(a)}–${clock(b)}`)};});
  const capacities=byWeekday.filter(d=>d.capacity>0).map(d=>d.capacity);
  if(!capacities.length)return null;
  const timezone=hours.timezone||'Europe/Madrid',today=calendar.formatDateLocal(now,timezone);
  const weekday=(new Date(today+'T12:00:00Z').getUTCDay()+6)%7+1;
  const parts=calendar.formatPartsInTimeZone(now,timezone);
  let start=parts.hour*60+parts.minute+(parts.second||0)/60;
  const nextAt=dispatch.next_allowed_at&&new Date(dispatch.next_allowed_at);
  if(nextAt&&Number.isFinite(+nextAt)&&nextAt>now){
    if(calendar.formatDateLocal(nextAt,timezone)!==today)start=Infinity;
    else{const p=calendar.formatPartsInTimeZone(nextAt,timezone);start=p.hour*60+p.minute+(p.second||0)/60;}
  }
  const live=['queued','sending','scheduled','waiting','waiting_next_batch'].includes(status);
  const todayPlanned=live?Math.min(Math.max(0,Number(pending)||0),countSlots(intervals(hours,weekday),delay,batch,start)):0;
  let plannedDay=today,plannedForDay=todayPlanned;
  if(live&&!plannedForDay&&Number(pending)>0){
    const base=nextAt&&Number.isFinite(+nextAt)&&nextAt>now?nextAt:now;
    const baseDay=calendar.formatDateLocal(base,timezone);
    for(let offset=0;offset<=7;offset++){
      const date=new Date(baseDay+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+offset);const day=date.toISOString().slice(0,10);
      const wd=(date.getUTCDay()+6)%7+1,part=offset===0?calendar.formatPartsInTimeZone(base,timezone):null;
      const count=Math.min(Number(pending),countSlots(intervals(hours,wd),delay,batch,part?part.hour*60+part.minute:0));
      if(count>0){plannedDay=day;plannedForDay=count;break;}
    }
  }
  return {min_per_day:Math.min(...capacities),max_per_day:Math.max(...capacities),planned_today:todayPlanned,planned_day:plannedDay,planned_for_day:plannedForDay,
    batch_size:batch,delay_minutes:delay,by_weekday:byWeekday,timezone,estimate:true};
}
function queueAttention(dispatch={}, status='') {
  const reason=String(dispatch.paused_reason||dispatch.last_error||'');
  const paused=status==='paused'||status.startsWith('paused_')||['held_meta','waiting_template_approval','waiting_approval','pause_requested','blocked'].includes(status);
  if(TERMINAL.has(status)||!paused)return null;
  const source=reason==='paused_by_user'?'user':/by_meta|meta_|template_quality_assessment/.test(reason)||status==='held_meta'?'meta'
    : /routing|config|template_not_approved|phone|connection|account|payment|billing/.test(reason)?'configuration':'platform';
  const admin=dispatch.requires_admin_review===true&&dispatch.admin_resolution?.decision!=='authorized';
  return {source,reason,requires_admin_review:admin,automatic:dispatch.resume_automatically===true||status==='held_meta',
    observed_opt_out_rate:/opt_out/.test(reason)&&Number.isFinite(Number(dispatch.quality_snapshot?.opt_out_rate))?Number(dispatch.quality_snapshot.opt_out_rate):null,
    max_opt_out_rate:dispatch.max_opt_out_rate!=null?Number(dispatch.max_opt_out_rate):null,
    sample_sent:Number(dispatch.quality_snapshot?.sent)||null};
}
function liveQueue(row,{group=false}={}) {
  if(TERMINAL.has(row.status))return false;
  if(row.status_group==='active')return !group||!!row.started;
  return Number(row.pending)>0;
}
module.exports={deliveryPlan,queueAttention,liveQueue,intervals,countSlots};
