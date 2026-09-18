import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HRANESS_HOME_URL } from '@hraness/site-footer';

import AboutPage from '../app/about/page.tsx';
import DocsPage from '../app/docs/page.tsx';
import MethodologyPage from '../app/methodology/page.tsx';
import NotFound from '../app/not-found.tsx';
import Home from '../app/page.tsx';
import Preview from '../app/preview/page.tsx';
import ResearchPage from '../app/research/page.tsx';
import SourcesPage from '../app/sources/page.tsx';
import { CANONICAL_PAGE_PATHS } from '../app/_lib/site.ts';

const siteRoot = resolve(import.meta.dir, '..');

const SITE_FOOTER_PIN = 'github:hraness/site-footer#v0.15.0';

const publicPages: readonly Readonly<{
  name: string;
  render: () => ReactNode | Promise<ReactNode>;
}>[] = [
  { name: '/', render: Home },
  { name: '/about', render: AboutPage },
  { name: '/sources', render: SourcesPage },
  { name: '/docs', render: DocsPage },
  { name: '/methodology', render: MethodologyPage },
  { name: '/research', render: ResearchPage },
  { name: 'not-found', render: NotFound },
];

const PERSONAL_MAKER_CREDIT = [
  'Ben Guo',
  'Built by Ben',
  'hraness-marketing-maker',
  'maker-title',
  'Who made it?',
] as const;

test('pins the shared site footer release and imports its stylesheet once', async () => {
  const [manifestSource, css] = await Promise.all([
    readFile(resolve(siteRoot, 'package.json'), 'utf8'),
    readFile(resolve(siteRoot, 'app/globals.css'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource) as {
    dependencies?: Record<string, string>;
  };

  expect(manifest.dependencies?.['@hraness/site-footer']).toBe(SITE_FOOTER_PIN);
  expect(css.match(/@import '@hraness\/site-footer\/styles\.css';/gu)).toHaveLength(1);
});

test('binds the canonical Hraness home the shared footer attributes to', () => {
  expect(HRANESS_HOME_URL).toBe('https://hraness.com/');
});

test('renders the in-flow content footer and one shared Hraness footer on every public page', async () => {
  expect(publicPages.slice(0, CANONICAL_PAGE_PATHS.length).map(({ name }) => name))
    .toEqual([...CANONICAL_PAGE_PATHS]);

  for (const page of publicPages) {
    const html = renderToStaticMarkup(await page.render());

    // The product content footer sits after the page content and before the
    // shared network footer, which stays mounted as the page's last landmark.
    expect(html.match(/data-hraness-marketing="footer"/gu), page.name).toHaveLength(1);
    expect(html.match(/<footer\b/gu), page.name).toHaveLength(2);
    expect(html.indexOf('data-hraness-marketing="footer"'), page.name)
      .toBeLessThan(html.indexOf('id="hraness-site-footer"'));
    expect(html, page.name).toContain('<footer aria-label="Textbutler"');
    expect(html, page.name).toContain('<img alt="" height="20" src="/icon.png" width="20"/>');
    expect(html, page.name).toContain('hraness-marketing-footer__name');
    expect(html, page.name).toContain('Built for Mac · MIT source · in development');
    expect(html, page.name).toContain('aria-label="Footer navigation"');
    expect(html, page.name).toContain('href="/about"');
    expect(html, page.name).toContain('href="/sources"');
    expect(html, page.name).not.toContain('product-brand-mark');

    expect(html.match(/id="hraness-site-footer"/gu), page.name).toHaveLength(1);
    expect(html, page.name).toContain('data-mailing-list="none"');
    const attribution = /<a\b[^>]*aria-label="Hraness home"[^>]*>([\s\S]*?)<\/a>/u.exec(html);
    expect(attribution?.[0], page.name).toContain(`href="${HRANESS_HOME_URL}"`);
    expect(attribution?.[0], page.name).toContain('lang="en"');
    expect(attribution?.[1], page.name).toContain('by Hraness');

    for (const credit of PERSONAL_MAKER_CREDIT) {
      expect(html, `${page.name} must not carry "${credit}"`).not.toContain(credit);
    }
  }
});

test('keeps the frame-safe preview free of the site footer', () => {
  const html = renderToStaticMarkup(<Preview />);

  expect(html).not.toContain('id="hraness-site-footer"');
  expect(html).not.toContain('hraness-marketing-footer');
  for (const credit of PERSONAL_MAKER_CREDIT) expect(html).not.toContain(credit);
});
