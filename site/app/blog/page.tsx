import type { Metadata } from 'next';
import { ArticleIndex } from '@hraness/design-kit/react/server';
import { blogJsonLd, NOINDEX_ROBOTS, serializeJsonLd } from '@hraness/web-discovery';

import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import {
  articleDiscovery,
  BLOG_DESCRIPTION,
  BLOG_FEED_PATH,
  BLOG_PATH,
  BLOG_SITE,
  BLOG_TITLE,
  blogIndexItems,
  indexableBlogPosts,
} from '../_lib/blog';
import { absoluteUrl, SITE_NAME, SOCIAL_IMAGE_ALT } from '../_lib/site';

const hasPosts = indexableBlogPosts().length > 0;

export const metadata: Metadata = {
  title: 'Blog',
  description: BLOG_DESCRIPTION,
  alternates: {
    canonical: absoluteUrl(BLOG_PATH),
    types: { 'application/atom+xml': [{ url: BLOG_FEED_PATH, title: BLOG_TITLE }] },
  },
  // The index stays out of search results until it lists a post.
  ...(hasPosts ? {} : { robots: NOINDEX_ROBOTS }),
  openGraph: {
    type: 'website',
    url: absoluteUrl(BLOG_PATH),
    siteName: SITE_NAME,
    title: `Blog | ${SITE_NAME}`,
    description: BLOG_DESCRIPTION,
    images: [{ url: absoluteUrl('/og.png'), width: 1200, height: 630, type: 'image/png', alt: SOCIAL_IMAGE_ALT }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `Blog | ${SITE_NAME}`,
    description: BLOG_DESCRIPTION,
    images: [{ url: absoluteUrl('/og.png'), alt: SOCIAL_IMAGE_ALT }],
  },
};

export default function BlogIndexPage() {
  const posts = indexableBlogPosts();
  const jsonLd = blogJsonLd(
    BLOG_SITE,
    { path: BLOG_PATH, name: BLOG_TITLE, description: BLOG_DESCRIPTION, publisher: { kind: 'Organization', name: 'Hraness' } },
    posts.map(articleDiscovery),
  );
  return (
    <>
      <SiteHeader />
      <main className="blog-page" id="main-content" tabIndex={-1}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
        <ArticleIndex
          heading="Blog"
          headingId="blog-title"
          headingLevel={1}
          items={blogIndexItems()}
          summary={BLOG_DESCRIPTION}
        />
        <p className="blog-feed-link"><a href={BLOG_FEED_PATH}>Subscribe with the Atom feed</a></p>
      </main>
      <SiteFooter />
    </>
  );
}
