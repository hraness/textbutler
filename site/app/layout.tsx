import type { Metadata, Viewport } from 'next';

import {
  absoluteUrl,
  GITHUB_URL,
  serializeJsonLd,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
} from './_lib/site';
import '@hraness/design-kit/fonts.css';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: 'Textbutler — Your personal message butler for Mac',
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME, url: SITE_ORIGIN }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: 'developer tools',
  keywords: ['Textbutler', 'Mac message assistant', 'personal message butler', 'coding agent', 'contact memory', 'Ghostget', 'iMessage', 'WhatsApp', 'Claude API'],
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
    title: 'Textbutler — Your personal message butler for Mac',
    description: SITE_DESCRIPTION,
    images: [
      {
        url: absoluteUrl('/og.png'),
        width: 1200,
        height: 630,
        type: 'image/png',
        alt: `${SITE_NAME} — your personal message butler for Mac.`,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Textbutler — Your personal message butler for Mac',
    description: SITE_DESCRIPTION,
    images: [{
      url: absoluteUrl('/og.png'),
      alt: `${SITE_NAME} — your personal message butler for Mac.`,
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
      creativeWorkStatus: 'In development; explicit messaging and agent setup required; CLI and menu companion',
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
      </body>
    </html>
  );
}
