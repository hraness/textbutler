import type { ArticleIsoDate } from '@hraness/design-kit';

// Post metadata for textbutler.app/blog. Bodies live in content/blog/<slug>.md
// and render into app/blog/posts.generated.ts through `bun run sync:readme`.
// Whether a post is listed or indexed comes from its record in blog-admissions.ts.

export const BLOG_PATH = '/blog' as const;
export const BLOG_FEED_PATH = '/blog/feed.xml' as const;
export const BLOG_TITLE = 'Textbutler blog';
export const BLOG_DESCRIPTION =
  'Posts about how Textbutler works: what it drafts, what it sends only with your approval, and the tools it runs on.';

export type BlogPost = Readonly<{
  slug: string;
  title: string;
  dek: string;
  eyebrow: string;
  published: ArticleIsoDate;
  updated?: ArticleIsoDate;
  tags: readonly string[];
  // Registered portfolio relations this post is about; they pick the related products shown.
  relationIds: readonly string[];
}>;

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: 'introducing-textbutler',
    title: 'Introducing Textbutler',
    dek: 'Textbutler drafts replies as a clearly marked assistant for the Mac chats you pick, and by default each draft waits until you read and approve it.',
    eyebrow: 'Release',
    published: '2026-09-24',
    tags: ['textbutler', 'messaging', 'drafts', 'local-first', 'macos', 'xcb', 'algal'],
    relationIds: [
      'contract:wrench:message-like-me:exports-private-bundles',
      'contract:message-like-me:peopleblade:shared-bundle-format',
    ],
  },
  {
    slug: 'how-textbutler-uses-xcb',
    title: 'How Textbutler uses xcb to draft on your own subscription',
    dek: 'Textbutler drafts replies through xcb on the Claude Code, Codex, or Devin subscription you already pay for.',
    eyebrow: 'Integration',
    published: '2026-09-24',
    tags: ['textbutler', 'xcb', 'subscriptions', 'drafts', 'claude-code', 'codex'],
    relationIds: [],
  },
  {
    slug: 'how-textbutler-uses-algal',
    title: 'How Textbutler uses ALGAL to improve replies per contact',
    dek: 'A Textbutler habitat replaces a contact\'s reply plan only after a blinded ALGAL replay scores the new plan no lower on any case and higher on average.',
    eyebrow: 'Integration',
    published: '2026-09-24',
    tags: ['textbutler', 'algal', 'habitats', 'drafts', 'messaging', 'local-first'],
    relationIds: [],
  },
  {
    slug: 'how-textbutler-uses-ghostget',
    title: 'How Textbutler uses Ghostget to import your message history',
    dek: 'Textbutler imports your Beeper and WhatsApp history from a private folder that Ghostget writes in Textbutler\'s own format.',
    eyebrow: 'Integration',
    published: '2026-09-24',
    tags: ['textbutler', 'ghostget', 'beeper', 'whatsapp', 'message-history', 'local-first'],
    relationIds: ['contract:wrench:message-like-me:exports-private-bundles'],
  },
];

export type BlogPostPath = `/blog/${string}`;

export function blogPostPath(post: Pick<BlogPost, 'slug'>): BlogPostPath {
  return `/blog/${post.slug}`;
}

export function blogPostBySlug(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function isoTimestamp(date: ArticleIsoDate): string {
  return `${date}T00:00:00.000Z`;
}
