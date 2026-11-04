'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {resolution,requestFor}=require('../../services/recoveredReplyNotifications.service');
const row={source_id:1,appointment_id:2,state_source_id:1,state_appointment_id:2,state_status:'review',manual_action_required:1,needs_response:0,possible_urgency:0};
test('only an evidenced human reply, completed owned review or manual appointment action resolves a recovered alert',()=>{
 assert.equal(resolution(row),null);
 assert.equal(resolution({...row,human_reply_id:3}).reason,'human_reply_already_sent');
 assert.equal(resolution({...row,appointment_action_id:4}).reason,'appointment_action_already_recorded');
 assert.equal(resolution({...row,state_status:'completed',manual_action_required:0}).reason,'review_already_completed');
 for(const change of [{needs_response:1},{possible_urgency:1}])assert.equal(resolution({...row,...change,appointment_action_id:4}),null);
 assert.equal(resolution({...row,state_status:'completed',manual_action_required:0,state_appointment_id:9}),null);
 assert.equal(resolution({...row,state_status:'completed',manual_action_required:0,state_source_id:0}),null);
});
test('reconciliation is restricted to internally generated recovered reply alerts with complete scope',()=>{
 const n={id:1,userId:4,clinicaId:3,event:'automation.persistent_alert',isRead:false,dedupeKey:'automation:recovered-reply:5:6:4',
 data:{source:'automations_v2',trigger_entity_type:'appointment',trigger_entity_id:2,quickChatConversationId:7,quickChatResponseMessageId:6}};
 assert.equal(requestFor(n).clinicId,3);
 for(const patch of [{isRead:true},{dedupeKey:'another-alert'},{event:'another-event'},{clinicaId:0},{data:{...n.data,quickChatResponseMessageId:null}},
 {data:{...n.data,source:'user'}},{data:{...n.data,trigger_entity_type:'patient'}}])assert.equal(requestFor({...n,...patch}),null);
});
