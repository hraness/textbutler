import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  ArticleRelatedProducts,
  ArticleSources,
  MarketingArticle,
} from '@hraness/design-kit/react/server';
import {
  articleJsonLd,
  createArticleMetadata,
  NOINDEX_ROBOTS,
  serializeJsonLd,
} from '@hraness/web-discovery';

import { SiteFooter, SiteHeader } from '../../_components/site-chrome';
import {
  admissionFor,
  articleDiscovery,
  BLOG_AUTHOR,
  BLOG_FEED_PATH,
  BLOG_POSTS,
  BLOG_SITE,
  BLOG_TITLE,
  blogPostBySlug,
  blogPostPath,
  bodyFor,
  isIndexablePost,
  provenanceFor,
  relatedProductsFor,
} from '../../_lib/blog';

type Params = Readonly<{ slug: string }>;

// Only the posts in BLOG_POSTS exist; every other /blog/<slug> is a 404.
export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Readonly<{ params: Promise<Params> }>): Promise<Metadata> {
  const post = blogPostBySlug((await params).slug);
  if (post === undefined) return {};
  const metadata = createArticleMetadata(BLOG_SITE, articleDiscovery(post));
  return {
    ...metadata,
    // A quarantined post stays readable but out of search indexes.
    robots: isIndexablePost(post) ? metadata.robots : NOINDEX_ROBOTS,
    alternates: {
      ...metadata.alternates,
      types: { 'application/atom+xml': [{ url: BLOG_FEED_PATH, title: BLOG_TITLE }] },
    },
  };
}

export default async function BlogPostPage({ params }: Readonly<{ params: Promise<Params> }>) {
  const post = blogPostBySlug((await params).slug);
  if (post === undefined) notFound();
  const body = bodyFor(post);
  const admission = admissionFor(post);
  const related = relatedProductsFor(post);
  const toc = body.headings.length >= 4
    ? body.headings.slice(0, 8).map((heading) => ({ href: `#${heading.id}` as const, label: heading.label }))
    : undefined;

  return (
    <>
      <SiteHeader />
      <main className="blog-page" id="main-content" tabIndex={-1}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(articleJsonLd(BLOG_SITE, articleDiscovery(post))) }}
        />
        <MarketingArticle
          author={BLOG_AUTHOR}
          dek={post.dek}
          eyebrow={post.eyebrow}
          heading={post.title}
          provenance={provenanceFor(post)}
          published={post.published}
          {...(post.updated === undefined ? {} : { updated: post.updated })}
          {...(toc === undefined ? {} : { toc })}
          after={(
            <>
              <ArticleSources
                sources={admission.sources.map((source) => ({
                  title: source.title,
                  href: source.url,
                  publisher: 'GitHub',
                  checkedOn: source.checkedOn,
                }))}
              />
              {related.length === 0 ? null : (
                <ArticleRelatedProducts
                  heading="Related products"
                  items={related.map((item) => ({
                    name: item.name,
                    href: item.href,
                    role: item.role,
                    relationship: item.relationship,
                  }))}
                />
              )}
            </>
          )}
        >
          <div dangerouslySetInnerHTML={{ __html: body.html }} />
        </MarketingArticle>
      </main>
      <SiteFooter path={blogPostPath(post)} />
    </>
  );
}
