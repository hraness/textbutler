import type { Metadata } from 'next';

export const SITE_NAME = 'Textbutler';
export const SITE_ORIGIN = 'https://textbutler.app';
export const SITE_DESCRIPTION =
  'A local message assistant for Mac. Draft replies in a guided inbox, review every word, and connect iMessage, WhatsApp and Beeper. Source pilot; AI replies remain unavailable.';
export const GITHUB_URL = 'https://github.com/hraness/textbutler';
export const ARCHITECTURE_URL = `${GITHUB_URL}/blob/main/docs/textbutler/architecture.md`;
export const GETTING_STARTED_URL = `${GITHUB_URL}/blob/main/docs/textbutler/getting-started.md`;
// The immutable legacy release coordinate; not a Textbutler app version.
export const SOFTWARE_VERSION = '0.8.18';
export const RELEASE_URL = `${GITHUB_URL}/releases/tag/v${SOFTWARE_VERSION}`;

export const CANONICAL_PAGE_PATHS = [
  '/',
  '/about',
  '/sources',
  '/docs',
  '/methodology',
  '/research',
] as const;

export type CanonicalPagePath = (typeof CANONICAL_PAGE_PATHS)[number];
export type SitePath = `/${string}`;

export function absoluteUrl(path: SitePath = '/'): string {
  if (path === '/') return SITE_ORIGIN;
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</gu, '\\u003c');
}

export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: CanonicalPagePath;
}): Metadata {
  const url = absoluteUrl(path);
  const resolvedTitle = path === '/' ? { absolute: title } : title;
  return {
    title: resolvedTitle,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      url,
      siteName: SITE_NAME,
      title,
      description,
      images: [{
        url: absoluteUrl('/opengraph-image'),
        width: 1200,
        height: 630,
        type: 'image/png',
        alt: `${SITE_NAME} — your personal message butler for Mac.`,
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [{
        url: absoluteUrl('/opengraph-image'),
        alt: `${SITE_NAME} — your personal message butler for Mac.`,
      }],
    },
  };
}
