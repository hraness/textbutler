import { expect, test } from 'bun:test';
import { assertBuildJoin, assertPresentation, assertServerExit, browserCases, browserEnvironment, browserMediaFeatures, browserOwner,
  deadline, finishBrowserCase, isPreviewPolicyBlock, isSyntheticBadge, routeTasks } from './browser-contract.mjs';

test('the native matrix covers four separate surfaces, both themes and touch', () => {
  const cases = browserCases();
  expect(cases).toHaveLength(16);
  expect(new Set(cases.map((item) => `${item.width}/${item.theme}${item.path}`)).size).toBe(16);
});

test('media fixtures isolate host transparency while preserving theme and reduced motion', () => {
  for (const theme of ['light', 'dark']) {
    const baseline = browserMediaFeatures(theme);
    expect(baseline).toEqual([
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'forced-colors', value: 'none' },
      { name: 'prefers-reduced-transparency', value: 'no-preference' },
    ]);
    expect(browserMediaFeatures(theme, 'reduce')).toEqual([
      ...baseline.slice(0, -1), { name: 'prefers-reduced-transparency', value: 'reduce' },
    ]);
  }
  expect(() => browserMediaFeatures('unknown')).toThrow();
  expect(() => browserMediaFeatures('light', 'unknown')).toThrow();
});

test('browser children receive no inherited credentials or personal home', () => {
  const env = browserEnvironment({ PATH: '/bin', HOME: '/personal', PROVIDER_TOKEN: 'synthetic',
    ANTHROPIC_API_KEY: 'synthetic', NODE_OPTIONS: '--max-old-space-size=2048', UV_THREADPOOL_SIZE: '3' }, '/fixture');
  expect(env).toEqual({ PATH: '/bin', HOME: '/fixture', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--max-old-space-size=2048', UV_THREADPOOL_SIZE: '3' });
});

test('only the exact external README image receives a recorded synthetic fixture', () => {
  const valid = { url: 'https://skills.sh/b/hraness/message-like-me', method: 'GET', resourceType: 'image' };
  expect(isSyntheticBadge(valid)).toBe(true);
  for (const change of [{ method: 'POST' }, { method: 'HEAD' }, { resourceType: 'document' },
    { resourceType: 'fetch' }, { url: valid.url + '?other=1' }, { url: valid.url + '/other' },
    { url: valid.url.replace('skills.sh', 'example.com') }]) {
    expect(isSyntheticBadge({ ...valid, ...change })).toBe(false);
  }
});

test('only preview script and manifest blocks from the verified restrictive CSP are expected', () => {
  const origin = 'http://127.0.0.1:3210';
  const policy = { path: '/preview', origin, verifiedCsp: true,
    authoredAssets: [origin + '/_next/static/chunks/app/page-123.js', origin + '/manifest.webmanifest', origin + '/theme-bootstrap.js'] };
  const valid = { url: policy.authoredAssets[0]!, method: 'GET', resourceType: 'script', error: 'csp', mainFrame: true };
  expect(isPreviewPolicyBlock(valid, policy)).toBe(true);
  expect(isPreviewPolicyBlock({ ...valid, url: origin + '/theme-bootstrap.js' }, policy)).toBe(true);
  expect(isPreviewPolicyBlock({ ...valid, resourceType: 'manifest', url: policy.origin + '/manifest.webmanifest' }, policy)).toBe(true);
  expect(isPreviewPolicyBlock({ ...valid, resourceType: 'other', url: policy.origin + '/manifest.webmanifest' }, policy)).toBe(true);
  for (const change of [{ method: 'POST' }, { error: 'net::ERR_ABORTED' }, { error: 'net::ERR_FAILED' }, { mainFrame: false },
    { resourceType: 'stylesheet' }, { resourceType: 'fetch' }, { resourceType: 'document' }, { resourceType: 'other' },
    { url: valid.url + '?other=1' }, { url: origin + '/_next/static/chunks/unknown.js' },
    { url: policy.origin + '/script.js' }, { url: 'https://example.com/_next/static/chunks/a.js' },
    { resourceType: 'image', url: policy.origin + '/icon.png' }]) {
    expect(isPreviewPolicyBlock({ ...valid, ...change }, policy)).toBe(false);
  }
  expect(isPreviewPolicyBlock(valid, { ...policy, verifiedCsp: false })).toBe(false);
  expect(isPreviewPolicyBlock(valid, { ...policy, path: '/' })).toBe(false);
});

test('a successful browser build must join the exact clean source and lockfile', () => {
  const source = { head: 'a', tree: 'b', status: '', lock: 'c', manifest: 'd' };
  expect(() => assertBuildJoin(source, { ...source }, 0)).not.toThrow();
  for (const change of [{ head: 'old' }, { tree: 'old' }, { status: ' M app/page.tsx' }, { lock: 'old' }, { manifest: 'old' }]) {
    expect(() => assertBuildJoin(source, { ...source, ...change }, 0)).toThrow();
  }
  expect(() => assertBuildJoin(source, source, 1)).toThrow();
  expect(() => assertBuildJoin({ ...source, status: 'dirty' }, { ...source, status: 'dirty' }, 0)).toThrow();
});

test('server cleanup rejects spontaneous, failing and forced exits', () => {
  const valid = { code: 0, signal: null, stopRequested: true, forced: false };
  expect(() => assertServerExit(valid)).not.toThrow();
  expect(() => assertServerExit({ ...valid, code: 143 })).not.toThrow();
  expect(() => assertServerExit({ ...valid, code: null, signal: 'SIGTERM' })).not.toThrow();
  for (const change of [{ stopRequested: false }, { stopRequested: false, code: 143 }, { code: 1 }, { forced: true }, { code: null, signal: 'SIGKILL' }]) {
    expect(() => assertServerExit({ ...valid, ...change })).toThrow();
  }
});

test('late route failures are joined after close and cannot mark a case passed', async () => {
  const failures: string[] = [];
  const tasks = routeTasks(failures);
  let reject!: (reason: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  void tasks.run(() => pending);
  const events: string[] = [];
  await expect(finishBrowserCase({ primary: undefined, settle: async () => { events.push('settle'); },
    close: async () => { events.push('close'); reject(new Error('late failure')); },
    drain: () => tasks.drain(), check: () => {
      events.push('check');
      if (failures.length) throw new Error(failures.join('\n'));
    } })).rejects.toThrow('late failure');
  expect(tasks.size).toBe(0);
  expect(events).toEqual(['settle', 'close', 'check']);
});

test('case failure preserves primary, settlement, teardown and late errors together', async () => {
  const fail = (message: string) => async () => { throw new Error(message); };
  try {
    await finishBrowserCase({ primary: new Error('primary'), settle: fail('settlement'), close: fail('cleanup'),
      drain: fail('route drain'), check: fail('late request') });
    throw new Error('Expected case rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(5);
    expect((error as Error).message).toBe('primary\nsettlement\ncleanup\nroute drain\nlate request');
  }
});

test('the owner joins a late acquisition during interruption and closes once', async () => {
  const events: string[] = [];
  let resolve!: (value: object) => void;
  const pending = new Promise<object>((done) => { resolve = done; });
  const owner = browserOwner({ launch: () => pending, close: async () => { events.push('browser'); },
    stopServer: async () => { events.push('server'); } });
  const started = owner.start();
  const stopped = owner.stop();
  resolve({});
  await expect(started).rejects.toThrow('interrupted');
  await stopped;
  await owner.stop();
  expect(events).toEqual(['browser', 'server']);
  await expect(owner.start()).rejects.toThrow('interrupted');
});

test('failed browser cleanup still closes the server and stays failed', async () => {
  let closed = false;
  const owner = browserOwner({ launch: async () => ({}), close: async () => { throw new Error('close failed'); },
    stopServer: async () => { closed = true; } });
  await owner.start();
  await expect(owner.stop()).rejects.toThrow('close failed');
  expect(closed).toBe(true);
  await expect(owner.stop()).rejects.toThrow('close failed');
});

test('browser waits have a bounded deadline', async () => {
  await expect(deadline(new Promise(() => {}), 'fixture', 1)).rejects.toThrow('fixture exceeded 1ms');
});

test('presentation admission rejects missing atoms, fallback fonts, collection and preset leaks', () => {
  const sample = { width: 1440, theme: 'light', path: '/' };
  const valid = { paper: 'paper', background: 'rgb(251, 241, 199)', bodyFont: '"Nebula Sans", sans-serif', coarse: false, overflow: 0,
    forms: 8, appearanceControls: [...['catppuccin','gruvbox','rose-pine','tokyo-night','paper'].map(value => ({name:'fixture-palette',value,legend:'Theme'})), ...['light','dark','system'].map(value => ({name:'fixture-mode',value,legend:'Appearance'}))], headers: 1, footers: 1, askAi: 1, preset: 'editorial', material: 'lantern', headerBackdrop: 'blur(20px) saturate(1.1)',
    layers: ['components.hraness-ui.priority1', 'components.hraness-design-kit.priority1'],
    fontWeights: ['400', '500', '600', '700'], renderedFonts: [{ isCustomFont: true, glyphCount: 9, postScriptName: 'InstrumentSerif-Regular' }],
    headingSize: 88, headingLeading: 89.76, headingTracking: -2.2, headingWeight: '400', headerMinHeight: '52px',
    headerWidth: 1216, gutter: '32px', heroPadding: ['112px', '128px'],
    sections: Array.from({ length: 9 }, () => ({ font: '"Instrument Serif", serif', weight: '400', size: 56, leading: 60.48, tracking: -1.12 })),
    summarySize: 20, summaryLeading: 33, workspaceInk: 'rgb(28, 25, 23)', bodyInk: 'rgb(28, 25, 23)',
    workspaceBackground: 'rgb(255, 253, 249)', frameBackground: 'rgb(255, 253, 249)',
    actionHeights: [42, 42, 42, 42, 42], actionRadii: ['12px'], fieldBackground: 'url("/grain.svg"), repeating-conic-gradient(from 45deg, red, transparent), radial-gradient(red, blue), linear-gradient(red, blue)', fieldBackgroundSize: '64px 64px, 24px 24px, 100% 100%, 100% 100%' };
  expect(() => assertPresentation(valid, sample)).not.toThrow();
  for (const path of ['/docs', '/sources', '/preview']) {
    const preview = path === '/preview';
    const document = { ...valid, preset: null, renderedFonts: [{ isCustomFont: true, glyphCount: 9, postScriptName: 'NebulaSans-Medium' }],
      forms: preview ? 0 : 8, appearanceControls: preview ? [] : valid.appearanceControls, headers: preview ? 0 : 1, footers: preview ? 0 : 1, askAi: preview ? 0 : 1 };
    expect(() => assertPresentation(document, { ...sample, path })).not.toThrow();
    expect(() => assertPresentation({ ...document, material: null }, { ...sample, path })).toThrow();
  }
  for (const change of [{ layers: [] }, { renderedFonts: [] }, { fontWeights: [] }, { forms: 9 }, { appearanceControls: [] }, { appearanceControls: valid.appearanceControls.map((control, index) => index === 0 ? {...control, value: 'email'} : control) },
    { appearanceControls: valid.appearanceControls.map((control, index) => index === 0 ? {...control, name: 'contact'} : control) },
    { appearanceControls: valid.appearanceControls.map((control, index) => index === 0 ? {...control, legend: 'Private data'} : control) },
    { material: null }, { headerBackdrop: 'none' }, { fieldBackgroundSize: 'auto' }, { fieldBackground: 'linear-gradient(red, blue)' },
    { preset: null }, { headingSize: 68 }, { headerMinHeight: '56px' }, { actionRadii: ['10px'] }, { actionRadii: ['4px'] },
    { sections: [] }, { workspaceInk: 'rgb(248, 247, 244)' }, { summaryLeading: 24.65 },
    { heroPadding: ['112px', '72px'] }, { gutter: '20px' }, { headerWidth: 1120 }]) {
    expect(() => assertPresentation({ ...valid, ...change }, sample)).toThrow();
  }
});
