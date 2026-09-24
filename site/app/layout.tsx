import type { Metadata, Viewport } from 'next';

import {
  absoluteUrl,
  GITHUB_URL,
  serializeJsonLd,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_STATUS_LABEL,
  SITE_TITLE,
  SOCIAL_IMAGE_ALT,
} from './_lib/site';
import { FoilController } from './_components/foil-controller';
import '@hraness/design-kit/fonts.css';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME, url: SITE_ORIGIN }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: 'developer tools',
  keywords: ['Textbutler', 'Mac message assistant', 'personal message butler', 'coding agent', 'contact memory', 'Ghostget', 'iMessage', 'WhatsApp'],
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icon.png', type: 'image/png' }],
    shortcut: '/icon.png',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: absoluteUrl('/opengraph-image'),
        width: 1200,
        height: 630,
        type: 'image/png',
        alt: SOCIAL_IMAGE_ALT,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [{
      url: absoluteUrl('/opengraph-image'),
      alt: SOCIAL_IMAGE_ALT,
    }],
  },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f7f4' },
    { media: '(prefers-color-scheme: dark)', color: '#12100f' },
  ],
};

const websiteId = `${absoluteUrl('/')}#website`;
const applicationId = `${absoluteUrl('/')}#application`;
const organizationId = 'https://hraness.com/#organization';
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': organizationId,
      name: 'Hraness',
      url: 'https://hraness.com',
    },
    {
      '@type': 'WebSite',
      '@id': websiteId,
      name: SITE_NAME,
      url: absoluteUrl('/'),
      description: SITE_DESCRIPTION,
      inLanguage: 'en-US',
      publisher: { '@id': organizationId },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': applicationId,
      name: SITE_NAME,
      url: absoluteUrl('/'),
      description: SITE_DESCRIPTION,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS',
      sameAs: GITHUB_URL,
      author: { '@id': organizationId },
      featureList: [
        'macOS menu-bar companion and local daemon controls',
        'Contact-specific guidance and editable memory',
        'Configurable visible assistant disclosure',
        'Smart and keyword-only response controls',
        'Global pause and active contact limits',
      ],
      isPartOf: { '@id': websiteId },
    },
    {
      '@type': 'SoftwareSourceCode',
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      codeRepository: GITHUB_URL,
      creativeWorkStatus: SITE_STATUS_LABEL,
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Bun 1.3.14 or newer on macOS',
      license: 'https://opensource.org/license/mit',
      author: { '@id': organizationId },
      targetProduct: { '@id': applicationId },
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html data-hraness-theme="paper" lang="en">
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        />
        {children}
        <FoilController />
      </body>
    </html>
  );
}
