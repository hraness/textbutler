import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import nextConfig, { frameSafePreviewHeaders } from '../next.config.ts';
import PreviewPage, { metadata } from '../app/preview/page.tsx';

test('server-renders an honest script-independent preview with no navigation', () => {
  const html = renderToStaticMarkup(<PreviewPage />);

  expect(html).toContain('A little help in your conversations');
  expect(html).toContain('Explicit messaging and agent setup required');
  expect(html).toContain('no windowed app download');
  expect(html).toContain('Synthetic example · no message sent');
  expect(html).not.toMatch(/<(?:a|button|form|script)\b/u);
  expect(metadata.robots).toEqual({ follow: false, index: false });
});

test('permits only Hraness to frame /preview while every other path stays denied', async () => {
  const rules = await nextConfig.headers?.();
  expect(rules).toBeDefined();

  const previewRule = rules?.find(({ source }) => source === '/preview');
  const deniedRule = rules?.find(({ source }) => source === '/((?!preview$).*)');

  expect(previewRule?.headers).toEqual([...frameSafePreviewHeaders]);
  expect(previewRule?.headers.some(({ key }) => key === 'X-Frame-Options')).toBeFalse();
  expect(previewRule?.headers).toContainEqual({
    key: 'X-Robots-Tag',
    value: 'noindex, nofollow',
  });
  expect(previewRule?.headers).toContainEqual({
    key: 'Content-Security-Policy',
    value: expect.stringContaining(
      'frame-ancestors https://hraness.com https://www.hraness.com',
    ),
  });
  expect(deniedRule?.headers).toContainEqual({ key: 'X-Frame-Options', value: 'DENY' });
  expect(deniedRule?.headers).toContainEqual({
    key: 'Content-Security-Policy',
    value: expect.stringContaining("frame-ancestors 'none'"),
  });
  expect(deniedRule?.headers).toContainEqual({
    key: 'Content-Security-Policy',
    value: expect.stringContaining(
      "img-src 'self' data: https://raw.githubusercontent.com https://skills.sh https://www.skills.sh",
    ),
  });
});
