'use strict';

const marker='data-nutrition-responsive-tables';
const tableStyles=`<style ${marker}>
  @media screen {
    .page, .card { min-width: 0; }
    .nutrition-table-scroll { display: block; min-width: 0; max-width: 100%; width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; -webkit-overflow-scrolling: touch; }
    .nutrition-table-scroll:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; border-radius: 3px; }
  }
  @media print { .nutrition-table-scroll { overflow: visible; max-width: none; } }
</style>`;
const attribute=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/** Applies only to newly rendered, trusted report markup. Never rewrite a stored
 * final snapshot. Tables remain semantic and retain every original cell. */
function responsiveNutritionReportHtml(html) {
  if(typeof html!=='string'||html.includes(marker)||!/<table\b/i.test(html))return html;
  const wrapped=html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi,table=>{
    const headers=[...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match=>match[1].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean);
    const title=headers.length?'Tabla del informe: '+headers.join(', '):'Tabla del informe';
    return `<div class="nutrition-table-scroll" role="region" tabindex="0" aria-label="${attribute(title)}">${table}</div>`;
  });
  return wrapped.includes('</head>')?wrapped.replace('</head>',tableStyles+'\n</head>'):tableStyles+wrapped;
}

module.exports={responsiveNutritionReportHtml};
