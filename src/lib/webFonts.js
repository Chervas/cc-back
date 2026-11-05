'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const SYSTEM = 'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
const FONTS = Object.freeze({
  montserrat: { family: 'Montserrat', license: 'montserrat-OFL.txt', faces: [
    ['montserrat-latin-variable.06b16db7a969.woff2', '100 900', '06b16db7a969135d48d38c49183be7fb88d4452e2a3011957c7851941f4e4879'],
  ] },
  lato: { family: 'Lato', license: 'lato-OFL.txt', faces: [
    ['lato-latin-400.918b7dc3e2e2.woff2', '400', '918b7dc3e2e2d015c16ce08b57bcb64d2253bafc1707658f361e72865498e537'],
    ['lato-latin-700.c447dd7677b4.woff2', '700', 'c447dd7677b419db7b21dbdfc6277c7816a913ffda76fd2e52702df538de0e49'],
  ] },
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fontStack(token) { return Object.hasOwn(FONTS, token) ? `"${FONTS[token].family}",${SYSTEM}` : SYSTEM; }
function compiledFonts(tokens) {
  const files = {}, manifest = {}, rules = [];
  const add = (filename, type, expectedHash) => {
    const body = fs.readFileSync(path.join(__dirname, '../assets/web-fonts', filename));
    const sha256 = digest(body);
    if (expectedHash && sha256 !== expectedHash) throw Object.assign(Error('web_font_integrity_invalid'), { code: 'web_font_integrity_invalid' });
    const key = 'assets/fonts/' + filename;
    // WebArtifact.files is a SQL JSON column. Use an explicit binary envelope
    // that survives JSON round-trips instead of Buffer.toJSON().
    files[key] = expectedHash ? { encoding: 'base64', data: body.toString('base64') } : body.toString('utf8');
    manifest[key] = { sha256, content_type: type, size_bytes: body.length };
  };
  for (const token of [...new Set([tokens.font_heading, tokens.font_body])].sort()) {
    const font = Object.hasOwn(FONTS, token) ? FONTS[token] : null; if (!font) continue;
    for (const [filename, weight, expectedHash] of font.faces) {
      add(filename, 'font/woff2', expectedHash);
      // The stylesheet lives under assets/; fonts stay on that same origin.
      rules.push(`@font-face{font-family:"${font.family}";font-style:normal;font-weight:${weight};font-display:swap;src:url("fonts/${filename}") format("woff2")}`);
    }
    add(font.license, 'text/plain; charset=utf-8');
  }
  return { css: rules.join('\n'), files, manifest };
}
module.exports = { fontStack, compiledFonts };
