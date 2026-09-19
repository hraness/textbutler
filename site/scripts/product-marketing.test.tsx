import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import Home from '../app/page.tsx';
import About from '../app/about/page.tsx';
import Preview from '../app/preview/page.tsx';
import { GET as getDiscoveryText } from '../app/llms.txt/route.ts';
import { checkMarketingSnapshot } from '../styles/vendor/hraness-marketing/check.mjs';
import { GETTING_STARTED_URL, GITHUB_URL, SOFTWARE_VERSION } from '../app/_lib/site.ts';

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

test('renders Textbutler with the shared grammar and honest development status', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html.match(/<h1\b/gu)).toHaveLength(1);
  expect(html).toContain('>A little help in your conversations</h1>');
  for (const role of ['header', 'hero', 'proof-frame', 'section', 'flow', 'trust', 'questions', 'cta', 'footer']) {
    expect(html).toContain(`data-hraness-marketing="${role}"`);
  }
  expect(html).toContain('hraness-marketing-header__brand');
  expect(html).toContain('data-foil=""');
  expect(html).toContain('Textbutler');
  expect(html).toContain('See what’s ready');
  expect(html).toContain('New installations start paused');
  expect(html).toContain('iMessage and WhatsApp');
  expect(html).toContain('Claude Code and Codex remain unavailable');
  expect(html).toContain('It is billed separately from a Claude Code subscription');
  expect(html).toContain('no AI account');
  expect(html).toContain('The source CLI has no qualified AI reply engine');
  expect(html).toContain('Live delivery and rich actions still need verification on your account.');
  expect(html).toContain('No windowed app download is provided');
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
  expect(heading.split(/\s+/u).length).toBeLessThanOrEqual(8);
  expect(heading).not.toMatch(/\.$/u);
  expect(heroCopy).toContain('your');
  const boundary = /<p\b[^>]*class="[^"]*\bhraness-marketing-hero__boundary\b[^"]*"[^>]*>([^<]+)<\/p>/u.exec(hero?.[0] ?? '')?.[1] ?? '';
  expect(boundary).toBe('Source pilot · macOS · iMessage + WhatsApp + Beeper');
  expect(boundary).not.toContain(SOFTWARE_VERSION);
  for (const word of HERO_VOCABULARY_TO_AVOID) expect(heroCopy).not.toMatch(new RegExp(`\\b${word}\\b`, 'u'));
});

test('shows synthetic contact context and disclosure without claiming transport support', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain('Synthetic illustration of the intended experience.');
  expect(html).toContain('No real messages, live agent run, or sent reply is shown.');
  expect(html).toContain('🤖{ Happy to help. Where are you headed, and for how long? }');
  expect(html).toContain('MEMORY.md');
  expect(html).toContain('AGENTS.md');
  expect(html).toContain('App Clips and mini apps remain unavailable.');
  expect(html).toContain('No Linq integration is included.');
  expect(html).toContain('System Integrity Protection disabled');
  expect(html).toContain('Textbutler never changes that setting.');
  expect(html).toContain('under its own data policies');
});

test('binds Design Kit v0.10.0 to the portable Paper palette', async () => {
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
    .toBe('github:hraness/design-kit#v0.10.0');
  expect(manifest.dependencies?.['@hraness/ui'])
    .toBe('github:hraness/ui#v0.5.13');
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
  expect(snapshot.source.commit).toBe('0e089bc18f9a0409f0e74b1fb7192f468956e386');
  expect(snapshot.files['product-marketing-preset.css'].sha256).toBe('221fd555f9c9c15e26fc8d7d8ad3a536e3dfb138df699b449adb9c45919e66cb');
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

test('keeps machine-readable setup and unavailable choices consistent with the landing', async () => {
  const discovery = await getDiscoveryText().text();
  expect(discovery).toContain('New installations start paused and new contacts start disabled.');
  expect(discovery).toContain('native Claude Code and Codex remain unavailable');
  expect(discovery).toContain('Textbutler CLI and menu companion source is available; there is no published Textbutler package or windowed app download.');
  expect(discovery).toContain('App Clips, mini apps, and Linq integration remain unavailable.');
  expect(discovery).toContain('Live delivery still needs verification on the selected account.');
});

test('offers guided source setup without implying a released AI engine or menu send approval', async () => {
  const home = renderToStaticMarkup(<Home />);
  const about = renderToStaticMarkup(<About />);
  const discovery = await getDiscoveryText().text();
  for (const content of [home, about, discovery]) {
    expect(content).toContain(GETTING_STARTED_URL);
    expect(content).toContain('compiled runtime');
    expect(content).toContain('prebuilt');
    expect(content).not.toContain('Claude API is available after setup');
    expect(content).not.toContain(`${GITHUB_URL}/tree/main/apps/macos`);
  }
  expect(home).toContain('Start guided setup');
  expect(home).toContain(`${GITHUB_URL}/blob/main/packages/textbutler/src/menubar.ts`);
  expect(home).toContain('Clearing all three sends plain text');
  expect(discovery).toContain('replies show DRAFT');
  expect(discovery).toContain('replies send DRAFT DIGEST');
  expect(discovery).toContain('A menu preview cannot send a draft.');
});
