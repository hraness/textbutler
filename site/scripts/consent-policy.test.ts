import { expect, test } from 'bun:test';
import nextConfig from '../next.config';

test('ordinary pages permit only the footer consent endpoint beyond their own origin', async () => {
  const rules = await nextConfig.headers?.();
  const policy = rules?.find(rule => rule.source === '/((?!preview$).*)')?.headers
    .find(header => header.key === 'Content-Security-Policy')?.value;
  const directives = policy?.split(';').map(value => value.trim());
  expect(directives?.find(value => value.startsWith('connect-src ')))
    .toBe("connect-src 'self' https://account.hraness.com/api/consent/region");
  expect(directives).toContain("form-action 'none'");
  expect(directives).toContain("script-src 'self' 'unsafe-inline'");
  const preview = rules?.find(rule => rule.source === '/preview')?.headers
    .find(header => header.key === 'Content-Security-Policy')?.value;
  expect(preview?.split(';').map(value => value.trim())).toContain("default-src 'none'");
  expect(preview?.split(';').map(value => value.trim())).toContain("script-src 'none'");
  expect(preview).not.toContain('connect-src');
  expect(preview).not.toContain('account.hraness.com');
});
