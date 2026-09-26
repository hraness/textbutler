import type { Metadata } from 'next';
import { RouteNotFoundPage } from '@hraness/design-kit/react';

import { SiteFooter, SiteHeader } from './_components/site-chrome';
import { blogPostBySlug } from './_lib/blog-posts';
import { GETTING_STARTED_URL, SITE_NAME } from './_lib/site';
import sitemap from './sitemap';

export const metadata: Metadata = {
  title: { absolute: 'Page not found | Textbutler' },
  robots: { index: false, follow: false },
};

const PAGE_LABELS: Readonly<Record<string, string>> = {
  '/': 'Home',
  '/about': 'About',
  '/blog': 'Blog',
  '/docs': 'Documentation',
  '/methodology': 'Methodology',
  '/research': 'Research and prior art',
  '/sources': 'Legacy history sources',
};

// Route labels are capped at 48 characters; long post titles end in an ellipsis.
function routeLabel(title: string): string {
  if (title.length <= 48) return title;
  const cut = title.slice(0, 47);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// "Did you mean" compares a missing address with the pages the sitemap publishes.
const knownPages = sitemap().map(({ url }) => {
  const href = new URL(url).pathname;
  const label = PAGE_LABELS[href] ?? blogPostBySlug(href.replace(/^\/blog\//u, ''))?.title ?? href;
  return { href, label: routeLabel(label) };
});

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1}>
        <RouteNotFoundPage
          agentIndexHref="/llms.txt"
          canvasAs="div"
          next={[
            { href: '/', label: 'What Textbutler does', description: 'Runs on your Mac and replies in the chats you choose as a marked assistant.' },
            { href: '/docs', label: 'Documentation', description: 'Set up on your Mac and connect iMessage, WhatsApp, or Beeper.' },
            { href: '/about', label: 'About', description: 'Why each contact gets its own context and control stays on your Mac.' },
          ]}
          primaryAction={{ href: GETTING_STARTED_URL, label: 'Set up on your Mac' }}
          routes={knownPages}
          siteName={SITE_NAME}
        />
      </main>
      <SiteFooter />
    </>
  );
}
