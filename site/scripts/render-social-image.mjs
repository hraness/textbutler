// Original Textbutler typography asset. Glyphs come from the pinned shared font.
import { readFile, writeFile } from 'node:fs/promises';
import fontkit from 'next/dist/compiled/@next/font/dist/fontkit/index.js';
import sharp from 'sharp';

const font = fontkit.default(await readFile(new URL('../node_modules/@hraness/design-kit/src/fonts/nebula-sans/NebulaSans-Medium.woff2', import.meta.url)));
function lettering(value, x, y, size, fill = '#221f1d') {
  const run = font.layout(value);
  let advance = 0;
  const paths = run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const path = `<path transform="translate(${advance + position.xOffset} ${position.yOffset})" d="${glyph.path.toSVG()}"/>`;
    advance += position.xAdvance;
    return path;
  }).join('');
  return `<g fill="${fill}" transform="translate(${x} ${y}) scale(${size / font.unitsPerEm} ${-size / font.unitsPerEm})">${paths}</g>`;
}
const iconBytes = await readFile(new URL('../app/icon.png', import.meta.url));
const icon = `<image x="80" y="60" width="64" height="64" href="data:image/png;base64,${iconBytes.toString('base64')}"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><title>Textbutler — A little help in your conversations. In development for Mac.</title><rect width="1200" height="630" fill="#f8f7f4"/>${icon}${lettering('Textbutler', 162, 107, 38)}${lettering('A little help in', 80, 275, 72)}${lettering('your conversations', 80, 360, 72)}${lettering('Your coding agent. A folder for each contact.', 83, 426, 29, '#5c554f')}<path d="M80 505H1120" stroke="#d9d4cd"/>${lettering('textbutler.app', 80, 560, 26)}${lettering('In development for Mac', 830, 560, 23, '#5c554f')}</svg>`;
await writeFile(new URL('../public/og.svg', import.meta.url), svg);
await sharp(Buffer.from(svg)).png().toFile(new URL('../public/og.png', import.meta.url).pathname);
