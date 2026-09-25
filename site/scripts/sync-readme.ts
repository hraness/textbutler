import { resolve } from 'node:path';
import { renderReadmeHtml } from './readme-html.ts';
import { renderBlogPostHtml } from './blog-html.ts';
import { BLOG_POSTS } from '../app/_lib/blog-posts.ts';

const siteRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(siteRoot, '..');
export function siteDocumentSource(sourcePath: string, source: string): string {
  if (sourcePath === '') throw new Error('Site document source path must not be empty');
  return source;
}

const documents = [
  {
    source: 'README.md',
    output: 'app/readme.generated.ts',
    exportName: 'readmeHtml',
  },
  {
    source: 'docs/methodology.md',
    output: 'app/methodology.generated.ts',
    exportName: 'methodologyHtml',
  },
  {
    source: 'docs/research.md',
    output: 'app/research.generated.ts',
    exportName: 'researchHtml',
  },
] as const;

if (import.meta.main) {
  for (const document of documents) {
    const source = await Bun.file(resolve(repositoryRoot, document.source)).text();
    const html = renderReadmeHtml(siteDocumentSource(document.source, source));
    await Bun.write(
      resolve(siteRoot, document.output),
      `// Generated from ../${document.source} by scripts/sync-readme.ts.\nexport const ${document.exportName} = ${JSON.stringify(html)};\n`,
    );
  }
  const releaseData = JSON.parse(await Bun.file(resolve(repositoryRoot, 'package.json')).text()) as unknown;
  const rendered: Record<string, ReturnType<typeof renderBlogPostHtml>> = {};
  for (const post of BLOG_POSTS) {
    const source = await Bun.file(resolve(siteRoot, 'content/blog', `${post.slug}.md`)).text();
    rendered[post.slug] = renderBlogPostHtml(source, releaseData);
  }
  await Bun.write(
    resolve(siteRoot, 'app/blog/posts.generated.ts'),
    `// Generated from content/blog/*.md by scripts/sync-readme.ts.\nexport const blogPostBodies: Readonly<Record<string, Readonly<{ html: string; headings: readonly Readonly<{ id: string; label: string }>[] }>>> = ${JSON.stringify(rendered, null, 2)};\n`,
  );
}
