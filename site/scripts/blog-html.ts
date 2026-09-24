import { SITE_STATUS, SITE_STATUS_LABEL } from '../app/_lib/site.ts';
import { renderReadmeHtml } from './readme-html.ts';

export type BlogPostBody = Readonly<{
  html: string;
  headings: readonly Readonly<{ id: string; label: string }>[];
}>;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

// Versions and the status come from release data, never from post text.
export function blogReleaseValues(rootPackage: unknown): Readonly<Record<string, string>> {
  const manifest = record(rootPackage, 'Root package.json');
  const packageManager = manifest.packageManager;
  const bun = typeof packageManager === 'string' ? /^bun@(\d+\.\d+\.\d+)$/u.exec(packageManager)?.[1] : undefined;
  if (bun === undefined) throw new Error('Root package.json must pin packageManager bun@X.Y.Z');
  const dependencies = record(manifest.devDependencies, 'Root package.json devDependencies');
  const agentmixerSpec = dependencies['@hraness/agentmixer'];
  const agentmixer = typeof agentmixerSpec === 'string'
    ? /\/releases\/download\/v(\d+\.\d+\.\d+)\//u.exec(agentmixerSpec)?.[1]
    : undefined;
  if (agentmixer === undefined) throw new Error('Root package.json must pin @hraness/agentmixer to a release');
  return {
    SITE_STATUS,
    SITE_STATUS_LABEL,
    BUN_VERSION: bun,
    AGENTMIXER_VERSION: agentmixer,
  };
}

export function resolveBlogTokens(source: string, values: Readonly<Record<string, string>>): string {
  return source.replace(/\{\{([A-Z_]+)\}\}/gu, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Unknown blog token {{${name}}}`);
    return value;
  });
}

function headingLabel(html: string): string {
  return html
    .replace(/<[^>]+>/gu, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function renderBlogPostHtml(source: string, rootPackage: unknown): BlogPostBody {
  const markdown = resolveBlogTokens(source, blogReleaseValues(rootPackage));
  const html = renderReadmeHtml(markdown);
  if (/<h1\b/u.test(html)) throw new Error('Blog post bodies start below the title; use ## headings');
  const headings = Array.from(
    html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/gu),
    ([, id, body]) => ({ id: id ?? '', label: headingLabel(body ?? '') }),
  );
  return { html, headings };
}
