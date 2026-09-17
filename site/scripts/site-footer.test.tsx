import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hranessAttribution } from '@hraness/site-footer';

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

const SITE_FOOTER_PIN = 'github:hraness/site-footer#v0.13.0';

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

test('exports the organization attribution copy the footer renders', () => {
  expect(hranessAttribution.title).toBe('Built by Hraness');
  expect(hranessAttribution.subtitle).toBe(
    'Hraness is an advanced software research organization dedicated to advancing the frontier of machine intelligence.',
  );
});

test('renders one shared Hraness footer with organization attribution on every public page', async () => {
  expect(publicPages.slice(0, CANONICAL_PAGE_PATHS.length).map(({ name }) => name))
    .toEqual([...CANONICAL_PAGE_PATHS]);

  for (const page of publicPages) {
    const html = renderToStaticMarkup(await page.render());

    expect(html.match(/id="hraness-site-footer"/gu), page.name).toHaveLength(1);
    expect(html, page.name).toContain('data-mailing-list="none"');
    expect(html.match(/data-slot="hraness-attribution"/gu), page.name).toHaveLength(1);
    expect(html, page.name).toContain(`>${hranessAttribution.title}</p>`);
    expect(html, page.name).toContain(`>${hranessAttribution.subtitle}</p>`);
    const attribution = /<div\b[^>]*data-slot="hraness-attribution"[^>]*>([\s\S]*?)<\/div>/u.exec(html);
    expect(attribution?.[0], page.name).toContain('lang="en"');
    expect(attribution?.[1], page.name).not.toContain('<a');
    expect(html.match(/<footer\b/gu), page.name).toHaveLength(1);

    for (const credit of PERSONAL_MAKER_CREDIT) {
      expect(html, `${page.name} must not carry "${credit}"`).not.toContain(credit);
    }
  }
});

test('keeps the frame-safe preview free of the site footer', () => {
  const html = renderToStaticMarkup(<Preview />);

  expect(html).not.toContain('id="hraness-site-footer"');
  expect(html).not.toContain('data-slot="hraness-attribution"');
  for (const credit of PERSONAL_MAKER_CREDIT) expect(html).not.toContain(credit);
});
