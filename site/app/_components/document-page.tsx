import {
  absoluteUrl,
  type CanonicalPagePath,
  serializeJsonLd,
  SITE_NAME,
} from '../_lib/site';
import { SiteFooter, SiteHeader } from './site-chrome';

export function DocumentPage({
  eyebrow,
  title,
  summary,
  path,
  html,
  sourceUrl,
  dateModified,
  sourceOwnsHeading = false,
  legacyNote,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  path: CanonicalPagePath;
  html: string;
  sourceUrl: string;
  dateModified: string;
  sourceOwnsHeading?: boolean;
  legacyNote?: string;
}) {
  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description: summary,
    url: absoluteUrl(path),
    inLanguage: 'en-US',
    dateModified,
    author: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: absoluteUrl('/'),
    },
    isPartOf: {
      '@type': 'WebSite',
      '@id': `${absoluteUrl('/')}#website`,
    },
  };

  return (
    <>
      <SiteHeader />
      <main className="document-page" id="main-content" tabIndex={-1}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(articleJsonLd) }}
        />
        {sourceOwnsHeading ? (
          <div className="document-hero document-source-chrome">
            <p className="eyebrow">{eyebrow}</p>
            <a href={sourceUrl}>View on GitHub ↗</a>
          </div>
        ) : (
          <header className="document-hero">
            <p className="eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p>{summary}</p>
            <a href={sourceUrl}>View on GitHub ↗</a>
          </header>
        )}
        {legacyNote && <p className="legacy-note">{legacyNote}</p>}
        <article
          className="readme-prose document-prose"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </main>
      <SiteFooter path={path} />
    </>
  );
}
