'use strict';
function createIssuerHttp(options){
 const business=require('./meta-marketing-business-http').createMetaMarketingBusinessHttp(options),agency=require('./meta-marketing-agency-http').createMetaMarketingAgencyHttp(options);
 const owner=input=>require('./meta-marketing-agency-contract').isBinding(input.binding)?agency:business;
 return {inspect:input=>owner(input).inspect(input),verifyPages:input=>owner(input).verifyPages?owner(input).verifyPages(input):Promise.resolve(true),withManagedToken:(input,work)=>owner(input).withManagedToken(input,work)};
}
module.exports={createIssuerHttp};
