'use strict';

// A webhook proves Page/Lead/Form/Ad, not the account chosen by our router.
// Keep the original receipt immutable. Only an explicit owner route may read a
// paid event after an account correction within the SAME unchanged enrollment,
// subject, Page and recipient. The caller supplies contexts from selected assets;
// the strict reader still validates the old generation and receipt expiry.
// The existing HTTP reader must verify the Ad's CURRENT account before contacts.
function readRoutedLeadReceipt({read,receiptRef,current,previousContexts,route}) {
  try { return read(receiptRef,current); } catch (error) {
    if(error?.code!=='scope_denied'||!route
      ||route.pageAssetRef!==`meta-facebook_page:${current.page}`
      ||route.adAccountAssetRef!==`meta-ad_account:${current.account}`
      ||!Number.isSafeInteger(current.recipientClinicId)||current.recipientClinicId<1
      ||route.recipientClinicId!==current.recipientClinicId)throw error;
    const contexts=previousContexts();
    if(!Array.isArray(contexts)||contexts.length>1000)throw error;
    for(const previous of contexts){
      if(!previous||previous.account===current.account
        ||['app','subject','tenant','connection','enrollment','page','recipientClinicId'].some(k=>previous[k]!==current[k]))continue;
      let result;
      try{result=read(receiptRef,previous);}catch(prior){if(prior?.code==='scope_denied')continue;throw prior;}
      if(!result?.event?.ad_id)throw error;
      return result;
    }
    throw error;
  }
}
module.exports={readRoutedLeadReceipt};
