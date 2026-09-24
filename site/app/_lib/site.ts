import type { Metadata } from 'next';

export const SITE_NAME = 'Textbutler';
export const SITE_ORIGIN = 'https://textbutler.app';
export const SITE_TITLE = 'Textbutler | Your personal message butler for Mac';
export const SITE_DESCRIPTION =
  'A message butler for your Mac, in development. Your coding agent drafts and answers the iMessage, WhatsApp, and Beeper chats you choose, and you can pause it.';
// The one development-status statement. Pages render it where they state the
// status; README.md repeats it word for word and a site test keeps them equal.
export const SITE_STATUS_LABEL = 'In development';
export const SITE_STATUS =
  `${SITE_STATUS_LABEL}. Textbutler runs from source on a Mac; there is no app to download and no published Textbutler package. Without an AI account you can connect iMessage, WhatsApp, and Beeper through Ghostget, check your inbox, and send replies you write yourself. AI replies also need a local build of Textbutler and a Claude Code or Codex subscription connected through xcb. Automatic replies have worked end to end over iMessage in testing by the developer. Try them on your own account, especially over WhatsApp or Beeper, before you rely on them.`;
export const SOCIAL_IMAGE_ALT = 'The Textbutler mark and the words “Your personal message butler for Mac” on a light card.';
export const GITHUB_URL = 'https://github.com/hraness/textbutler';
export const ARCHITECTURE_URL = `${GITHUB_URL}/blob/main/docs/textbutler/architecture.md`;
export const GETTING_STARTED_URL = `${GITHUB_URL}/blob/main/docs/textbutler/getting-started.md`;
// The immutable legacy release coordinate; not a Textbutler app version.
export const SOFTWARE_VERSION = '0.8.21';
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
  const socialTitle = path === '/' ? title : `${title} | ${SITE_NAME}`;
  return {
    title: resolvedTitle,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      url,
      siteName: SITE_NAME,
      title: socialTitle,
      description,
      images: [{
        url: absoluteUrl('/opengraph-image'),
        width: 1200,
        height: 630,
        type: 'image/png',
        alt: SOCIAL_IMAGE_ALT,
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      images: [{
        url: absoluteUrl('/opengraph-image'),
        alt: SOCIAL_IMAGE_ALT,
      }],
    },
  };
}
