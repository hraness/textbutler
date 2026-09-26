import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import Home from '../app/page.tsx';
import About from '../app/about/page.tsx';
import Preview from '../app/preview/page.tsx';
import { GET as getDiscoveryText } from '../app/llms.txt/route.ts';
import { checkMarketingSnapshot } from '../styles/vendor/hraness-marketing/check.mjs';
import { GETTING_STARTED_URL, GITHUB_URL, SITE_STATUS, SITE_STATUS_LABEL, SOFTWARE_VERSION } from '../app/_lib/site.ts';

const siteRoot = resolve(import.meta.dir, '..');

const HERO_VOCABULARY_TO_AVOID = [
  'bounded',
  'exact',
  'authority',
  'custody',
  'immutable',
  'inspectable',
  'canonical',
  'projection',
  'receipt',
] as const;

// Delivery vocabulary from AGENTS.md and the XCB receipt. Pages say what the
// reader gets instead; the one status statement lives in SITE_STATUS.
const PAGE_VOCABULARY_TO_AVOID = [
  'admission',
  'admitted',
  'qualification',
  'qualified',
  'custody',
  'composition',
  'source pilot',
  'source daemon',
  'compiled runtime',
  'receipt',
] as const;

// The shared Related block is portfolio copy owned outside this repository.
function textBeforeRelated(html: string): string {
  const related = html.indexOf('data-hraness-marketing="related"');
  return (related === -1 ? html : html.slice(0, related)).replace(/<[^>]+>/gu, ' ').toLowerCase();
}

test('renders Textbutler with the shared grammar and one development status', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html.match(/<h1\b/gu)).toHaveLength(1);
  expect(/<h1[^>]*>([^<]+)<\/h1>/u.exec(html)?.[1]).toBe('Your AI butler replies in the chats you choose.');
  for (const role of ['header', 'hero', 'proof-frame', 'section', 'flow', 'trust', 'questions', 'cta', 'footer']) {
    expect(html).toContain(`data-hraness-marketing="${role}"`);
  }
  expect(html).toContain('hraness-marketing-header__brand');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  expect(header).toContain('aria-label="Textbutler home"');
  expect(header).toContain('hraness-foil-mark');
  expect(header).toContain('src="/marks/message-like-me.svg"');
  expect(header).not.toContain('src="/icon.png"');
  expect(html).toContain('data-foil=""');
  expect(html).toContain('Textbutler');
  expect(html).toContain('How replies stay off');
  expect(html.split(SITE_STATUS)).toHaveLength(2);
  expect(html).toContain('New installations start paused');
  expect(html).toContain('iMessage and WhatsApp');
  expect(html).toContain('Claude Code or Codex, through your own subscription and xcb');
  expect(html).toContain('billed separately from a Claude Code subscription');
  expect(html).toContain('Vercel AI Gateway');
  expect(html).toContain('no AI account');
  expect(html).toContain('Running from source never writes AI replies.');
  expect(html).toContain('no tools of its own');
  expect(html).toContain('MIT-licensed');
  expect(html).toContain('test delivery and rich actions on your own account');
  expect(html).toContain('no app to download');
  expect(html).toContain(`Message Like Me v${SOFTWARE_VERSION}`);
  expect(html).toContain('It does not install Textbutler or enable automatic replies.');
  expect(html).toContain('No. textbutler.app is informational');
  expect(html).toContain('"@type":"FAQPage"');
  expect(html).not.toMatch(/<(?:form|input|textarea)\b/u);
  expect(html).not.toContain('bun add --global');
  expect(html).not.toContain('Install v');
});

test('keeps the hero outcome-led and free of contract vocabulary', () => {
  const html = renderToStaticMarkup(<Home />);
  const hero = /<header[^>]*data-hraness-marketing="hero"[\s\S]*?<div\b[^>]*class="[^"]*\bhraness-marketing-hero__frame\b[^"]*"[^>]*>/u.exec(html);
  expect(hero).not.toBeNull();
  const heroCopy = (hero?.[0] ?? '').replace(/<[^>]+>/gu, ' ').toLowerCase();
  const heading = /<h1[^>]*>([^<]+)<\/h1>/u.exec(html)?.[1] ?? '';
  expect(heading.split(/\s+/u).length).toBeLessThanOrEqual(10);
  expect(heroCopy).toContain('your');
  const boundary = /<p\b[^>]*class="[^"]*\bhraness-marketing-hero__boundary\b[^"]*"[^>]*>([^<]+)<\/p>/u.exec(hero?.[0] ?? '')?.[1] ?? '';
  expect(boundary).toStartWith(`${SITE_STATUS_LABEL} · macOS`);
  for (const app of ['iMessage', 'WhatsApp', 'Beeper']) expect(boundary).toContain(app);
  expect(boundary).not.toContain(SOFTWARE_VERSION);
  for (const word of HERO_VOCABULARY_TO_AVOID) expect(heroCopy).not.toMatch(new RegExp(`\\b${word}\\b`, 'u'));
});

test('keeps delivery vocabulary off the product pages', async () => {
  const discovery = await getDiscoveryText().text();
  const pages = {
    home: textBeforeRelated(renderToStaticMarkup(<Home />)),
    about: textBeforeRelated(renderToStaticMarkup(<About />)),
    preview: textBeforeRelated(renderToStaticMarkup(<Preview />)),
    discovery: discovery.slice(0, discovery.indexOf('## Legacy Message Like Me history tools')).toLowerCase(),
  };
  for (const [name, copy] of Object.entries(pages)) {
    expect(copy.length, name).toBeGreaterThan(0);
    for (const word of PAGE_VOCABULARY_TO_AVOID) expect(copy, `${name}: ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`, 'u'));
  }
});

test('shows synthetic contact context and disclosure without claiming transport support', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain('Illustration only.');
  expect(html).toContain('The contact, messages, and reply are made up, and nothing was sent.');
  expect(html).toContain('🤖{ Where are you headed, and for how long? }');
  expect(html).not.toContain('Happy to help');
  expect(html).toContain('MEMORY.md');
  expect(html).toContain('AGENTS.md');
  expect(html).toContain('App Clips, mini apps, and Linq aren’t supported.');
  expect(html).toContain('System Integrity Protection disabled');
  expect(html).toContain('Textbutler never changes that setting.');
  expect(html).toContain('under its own data policies');
});

test('binds Design Kit v0.15.0 to the portable Paper palette', async () => {
  const [layout, css, manifestSource, paper] = await Promise.all([
    readFile(resolve(siteRoot, 'app/layout.tsx'), 'utf8'),
    readFile(resolve(siteRoot, 'app/globals.css'), 'utf8'),
    readFile(resolve(siteRoot, 'package.json'), 'utf8'),
    readFile(resolve(siteRoot, 'styles/vendor/hraness-paper/paper-theme.css'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource) as {
    dependencies?: Record<string, string>;
  };

  expect(manifest.dependencies?.['@hraness/design-kit'])
    .toBe('github:hraness/design-kit#v0.18.1');
  expect(manifest.dependencies?.['@hraness/ui'])
    .toBe('github:hraness/ui#v0.5.19');
  expect(css).toContain("@import '@hraness/design-kit/styles.css';");
  expect(layout).toContain("colorScheme: 'light dark'");
  expect(layout).toContain('data-hraness-theme="paper"');
  expect(css).toContain("@import '../styles/vendor/hraness-paper/paper-theme.css';");
  expect(paper).toContain('color-scheme: light dark;');
  expect(paper).toContain('--hraness-site-accent: var(--primary);');
  expect(paper).toContain('--hraness-site-accent-ink: var(--primary-foreground);');
  expect(css).toContain(':where(.hraness-marketing-page, .hraness-marketing-header) {');
  expect(css).toContain('.textbutler-marketing .hraness-marketing-hero {');
  expect(css).toContain('.mlm-marketing-trust .hraness-marketing-trust-grid {');
  expect(css).not.toContain('--acid');
  expect(css).not.toMatch(/transition:/u);
});


test('admits the released finite marketing snapshot and scopes it to the landing', async () => {
  const snapshot = await checkMarketingSnapshot();
  expect(snapshot.source.commit).toBe('d38d13c07d7956d02ddfbca8d32aa2066d88fbd3');
  expect(snapshot.files['product-marketing-preset.css'].sha256).toBe('ab78b17a454385c190e36172ea660aa396cd08e7ef371e249b91342ec411044d');
  const html = renderToStaticMarkup(<Home />);
  // React hoists the product icon's preload ahead of the document root.
  expect(html.replace(/^(?:<link\b[^>]*>\s*)+/u, ''))
    .toStartWith('<div class="textbutler-marketing" data-hraness-marketing-preset="editorial" data-hraness-material="lantern">');
  expect(html).toContain('<div class="hraness-material-wall">');
  expect(renderToStaticMarkup(<About />)).not.toContain('data-hraness-marketing-preset');
  expect(renderToStaticMarkup(<Preview />)).not.toContain('data-hraness-marketing-preset');
  expect(renderToStaticMarkup(<About />)).not.toContain('hraness-material');
  expect(renderToStaticMarkup(<Preview />)).not.toContain('hraness-material');
  expect(html).toContain('hraness-material-chrome');
  expect(html).toContain('hraness-material-pane');
});

test('keeps machine-readable setup and conditional subscription admission consistent with the landing', async () => {
  const discovery = await getDiscoveryText().text();
  expect(discovery).toContain('New installations start paused and new contacts start disabled.');
  expect(discovery).toContain('only from the local install that bun run textbutler:install builds');
  expect(discovery).toContain('both contact permission profiles match the last reviewed version');
  expect(discovery).toContain('Running from source never writes AI replies.');
  expect(discovery).toContain('the account must pass providers check');
  expect(discovery).toContain('no app to download and no published Textbutler package');
  expect(discovery).toContain('Vercel AI Gateway');
  expect(discovery).toContain('App Clips, mini apps, and Linq integration are not supported.');
  expect(discovery).toContain('Test inference and delivery on your own account');
});

test('offers guided source setup without implying a released AI engine or menu send approval', async () => {
  const home = renderToStaticMarkup(<Home />);
  const about = renderToStaticMarkup(<About />);
  const discovery = await getDiscoveryText().text();
  for (const content of [home, about, discovery]) {
    expect(content).toContain(GETTING_STARTED_URL);
    expect(content).toContain(SITE_STATUS);
    expect(content).toContain('bun run textbutler:install');
    expect(content).toMatch(/last reviewed version/u);
    expect(content).toMatch(/running from source never writes AI replies/iu);
    expect(content).toMatch(/Claude API route (?:isn’t|is not) available in any build of this repository/u);
    expect(content).toContain('https://github.com/hraness/xcb');
    expect(content).toContain('prebuilt');
    expect(content).not.toContain('Claude API is available after setup');
    expect(content).not.toContain(`${GITHUB_URL}/tree/main/apps/macos`);
  }
  expect(home).toContain('Start guided setup');
  expect(home).toContain(`${GITHUB_URL}/blob/main/docs/textbutler/native-subscription.md`);
  expect(home).toContain('Clearing all three sends plain text');
  expect(discovery).toContain('replies show DRAFT');
  expect(discovery).toContain('replies send DRAFT DIGEST');
  expect(discovery).toContain('A menu preview cannot send a draft.');
});
