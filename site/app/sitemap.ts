import type { MetadataRoute } from 'next';
import { createBlogSitemapPaths } from '@hraness/web-discovery';

import { articleDiscovery, BLOG_PATH, indexableBlogPosts } from './_lib/blog';
import { absoluteUrl } from './_lib/site';

// Indexable posts only; quarantined posts stay out of the sitemap.
function blogEntries(): MetadataRoute.Sitemap {
  const posts = indexableBlogPosts();
  if (posts.length === 0) return [];
  return createBlogSitemapPaths({ path: BLOG_PATH }, posts.map(articleDiscovery)).map(({ lastModified, path }) => ({
    url: absoluteUrl(path),
    ...(lastModified === undefined ? {} : { lastModified: new Date(lastModified) }),
    changeFrequency: 'monthly' as const,
    priority: path === BLOG_PATH ? 0.6 : 0.7,
  }));
}

export default function sitemap(): MetadataRoute.Sitemap {
  const rebrandDate = new Date('2026-09-11T00:00:00Z');
  return [
    { url: absoluteUrl('/'), lastModified: rebrandDate, changeFrequency: 'weekly', priority: 1 },
    { url: absoluteUrl('/sources'), lastModified: rebrandDate, changeFrequency: 'monthly', priority: 0.6 },
    { url: absoluteUrl('/docs'), lastModified: rebrandDate, changeFrequency: 'monthly', priority: 0.9 },
    { url: absoluteUrl('/methodology'), lastModified: rebrandDate, changeFrequency: 'monthly', priority: 0.6 },
    { url: absoluteUrl('/research'), lastModified: rebrandDate, changeFrequency: 'monthly', priority: 0.6 },
    { url: absoluteUrl('/about'), lastModified: rebrandDate, changeFrequency: 'monthly', priority: 0.7 },
    ...blogEntries(),
  ];
}
