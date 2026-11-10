'use strict';
// Provenance only. These operations do not decide intent or change thresholds.
const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g,' ').replace(/\s+([.,!?;:])/g,'$1').trim();
function matches(patientText,evidence) {
  const text=normalize(patientText),quote=normalize(evidence);
  if(!quote)return false;
  if(text.includes(quote))return true;
  // Structured output can contain several literal quotes on separate lines.
  // Require every fragment, in order, without rewriting, reusing or inventing
  // words. The model still receives the COMPLETE original patient batch.
  const fragments=String(evidence||'').split(/\r?\n/).map(normalize).filter(Boolean);
  if(fragments.length<2 || fragments.length>20)return false;
  let offset=0;
  for(const fragment of fragments){const at=text.indexOf(fragment,offset);if(at<0)return false;offset=at+fragment.length;}
  return true;
}
module.exports={normalize,matches};
