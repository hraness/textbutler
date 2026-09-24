import {
  articleProvenanceFromAdmission,
  isArticleIndexable,
  type ArticleAdmission,
  type ArticleAuthor,
  type ArticleIndexItem,
  type ArticleProvenanceRecord,
} from '@hraness/design-kit';
import { relatedFor, type PortfolioRelatedItem } from '@hraness/design-kit/portfolio';
import {
  createAtomFeed,
  type ArticleDiscovery,
  type ArticleParty,
  type FeedEntry,
  type SearchSite,
} from '@hraness/web-discovery';

import { blogPostBodies } from '../blog/posts.generated';
import { blogAdmission } from './blog-admissions';
import {
  BLOG_DESCRIPTION,
  BLOG_FEED_PATH,
  BLOG_PATH,
  BLOG_POSTS,
  BLOG_TITLE,
  blogPostPath,
  isoTimestamp,
  type BlogPost,
} from './blog-posts';
import { SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN, SITE_TITLE, SOCIAL_IMAGE_ALT } from './site';

export * from './blog-posts';

export const BLOG_SITE: SearchSite = {
  name: SITE_NAME,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  origin: SITE_ORIGIN as `https://${string}`,
  language: 'en-US',
  locale: 'en_US',
};

// Every post carries the organization byline; see ARTICLE_COPY.md in @hraness/design-kit.
export const BLOG_AUTHOR: ArticleAuthor = { kind: 'organization', name: 'Hraness', href: 'https://hraness.com' };
const BLOG_PARTY: ArticleParty = { kind: 'Organization', name: 'Hraness' };

export function admissionFor(post: BlogPost): ArticleAdmission {
  const admission = blogAdmission(blogPostPath(post));
  if (admission === undefined) throw new Error(`No admission record for ${blogPostPath(post)}`);
  return admission;
}

export function isIndexablePost(post: BlogPost): boolean {
  return isArticleIndexable(admissionFor(post));
}

/** Posts that may appear in the blog index, sitemap, feed, and llms.txt, newest first. */
export function indexableBlogPosts(): readonly BlogPost[] {
  return [...BLOG_POSTS.filter(isIndexablePost)].sort((left, right) => (
    left.published === right.published ? 0 : left.published < right.published ? 1 : -1
  ));
}

export function provenanceFor(post: BlogPost): ArticleProvenanceRecord {
  return articleProvenanceFromAdmission(admissionFor(post));
}

export function bodyFor(post: BlogPost) {
  const body = blogPostBodies[post.slug];
  if (body === undefined) throw new Error(`No rendered body for ${post.slug}; run bun run sync:readme`);
  return body;
}

export function articleDiscovery(post: BlogPost): ArticleDiscovery {
  return {
    type: 'BlogPosting',
    canonicalPath: blogPostPath(post),
    blogPath: BLOG_PATH,
    title: post.title,
    description: post.dek,
    image: {
      path: '/og.png',
      alt: SOCIAL_IMAGE_ALT,
      contentType: 'image/png',
      width: 1200,
      height: 630,
    },
    publishedTime: isoTimestamp(post.published),
    ...(post.updated === undefined ? {} : { modifiedTime: isoTimestamp(post.updated) }),
    authors: [BLOG_PARTY],
    publisher: BLOG_PARTY,
    keywords: post.tags,
    section: post.eyebrow,
    isAccessibleForFree: true,
  };
}

export function blogIndexItems(): readonly ArticleIndexItem[] {
  return indexableBlogPosts().map((post) => ({
    href: blogPostPath(post),
    title: post.title,
    dek: post.dek,
    eyebrow: post.eyebrow,
    published: post.published,
    ...(post.updated === undefined ? {} : { updated: post.updated }),
  }));
}

/** Related products for a post, only along the registered relations it covers. */
export function relatedProductsFor(post: BlogPost): readonly PortfolioRelatedItem[] {
  const relationIds = new Set(post.relationIds);
  return relatedFor('message-like-me').filter((item) => relationIds.has(item.relationId)).slice(0, 3);
}

export function blogAtomFeed(): string {
  const posts = indexableBlogPosts();
  const entries: FeedEntry[] = posts.map((post) => ({
    path: blogPostPath(post),
    title: post.title,
    summary: post.dek,
    contentHtml: bodyFor(post).html,
    publishedTime: isoTimestamp(post.published),
    ...(post.updated === undefined ? {} : { modifiedTime: isoTimestamp(post.updated) }),
    categories: post.tags,
    authors: [BLOG_PARTY],
  }));
  return createAtomFeed(
    BLOG_SITE,
    {
      title: BLOG_TITLE,
      description: BLOG_DESCRIPTION,
      homePath: BLOG_PATH,
      path: BLOG_FEED_PATH,
      authors: [BLOG_PARTY],
      // A feed with no entries needs an explicit updated time.
      ...(entries.length === 0 ? { updated: '2026-09-24T00:00:00.000Z' } : {}),
    },
    entries,
  );
}
