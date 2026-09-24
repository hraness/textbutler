import assert from 'node:assert/strict';

export function browserCases() {
  return [1440, 390].flatMap((width) => ['light', 'dark'].flatMap((theme) =>
    ['/', '/docs', '/sources', '/preview'].map((path) => ({ width, theme, path }))));
}

// Pin the synthetic presentation state instead of inheriting host accessibility
// preferences. The browser gate separately exercises the reduced fallback.
export function browserMediaFeatures(theme, transparency = 'no-preference') {
  assert.ok(['light', 'dark'].includes(theme));
  assert.ok(['no-preference', 'reduce'].includes(transparency));
  return [
    { name: 'prefers-color-scheme', value: theme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'forced-colors', value: 'none' },
    { name: 'prefers-reduced-transparency', value: transparency },
  ];
}

// The source-owned README badge is external; this offline gate substitutes only
// its exact image request, never a document, API, script, or another asset.
export function isSyntheticBadge(request) {
  return request.url === 'https://skills.sh/b/hraness/message-like-me'
    && request.method === 'GET' && request.resourceType === 'image';
}

export function isPreviewPolicyBlock(request, { path, origin, verifiedCsp, authoredAssets }) {
  if (path !== '/preview' || !verifiedCsp || !request.mainFrame || request.method !== 'GET' || request.error !== 'csp'
    || !authoredAssets.includes(request.url)) return false;
  const url = new URL(request.url);
  if (url.origin !== origin || url.search || url.hash) return false;
  return (request.resourceType === 'script' && (/^\/_next\/static\/chunks\/[\w./-]+\.js$/u.test(url.pathname) || url.pathname === '/theme-bootstrap.js'))
    || (['manifest', 'other'].includes(request.resourceType) && url.pathname === '/manifest.webmanifest');
}

export function assertBuildJoin(before, after, exitCode) {
  assert.equal(before.status, '', 'The browser build must start from a clean source.');
  assert.equal(exitCode, 0, 'The same-invocation browser build failed.');
  assert.deepEqual(after, before, 'Browser build inputs changed while compiling.');
}

export function assertServerExit(exit) {
  assert.equal(exit.stopRequested, true, 'Next exited before owned teardown.');
  assert.equal(exit.forced, false, 'Next required forced termination.');
  // Next 16.2.6 awaits its SIGTERM cleanup, then explicitly exits with 143.
  assert.ok(([0, 143].includes(exit.code) && exit.signal === null) || (exit.code === null && exit.signal === 'SIGTERM'),
    `Unexpected Next exit: ${exit.code}/${exit.signal}`);
}

export function routeTasks(errors) {
  const pending = new Set();
  return {
    get size() { return pending.size; },
    run(operation) {
      const task = Promise.resolve().then(operation).catch((error) => {
        errors.push(`Route handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => pending.delete(task));
      pending.add(task);
      return task;
    },
    drain() {
      return deadline((async () => {
        while (pending.size > 0) await Promise.all([...pending]);
      })(), 'Route handler settlement');
    },
  };
}

// Every phase runs even after a primary failure. In particular, teardown cannot
// erase an earlier assertion, and no case passes before late events are joined.
export async function finishBrowserCase({ primary, settle, close, drain, check }) {
  const errors = primary ? [primary] : [];
  for (const action of [settle, close, drain, check]) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors,
    errors.map((error) => error instanceof Error ? error.message : String(error)).join('\n'));
}

/** @returns {Record<string, string>} */
export function browserEnvironment(source, home) {
  const keys = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS',
    'CIRCLE_NODE_TOTAL', 'GOMAXPROCS', 'RAYON_NUM_THREADS', 'UV_THREADPOOL_SIZE', 'VIPS_CONCURRENCY'];
  return { ...Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
    HOME: home, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
}

export function deadline(promise, label, milliseconds = 10_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

// Stop closes even a browser acquired after interruption, then always joins Next.
export function browserOwner({ launch, close, stopServer }) {
  let stopped = false;
  let launching;
  let stopping;
  return {
    async start() {
      assert.equal(stopped, false, 'Browser acquisition was interrupted.');
      launching ??= Promise.resolve().then(launch);
      const browser = await launching;
      if (stopped) {
        await stopping;
        throw new Error('Browser acquisition was interrupted.');
      }
      return browser;
    },
    stop() {
      stopped = true;
      stopping ??= (async () => {
        try {
          const browser = await launching?.catch(() => undefined);
          if (browser) await close(browser);
        } finally { await stopServer(); }
      })();
      return stopping;
    },
  };
}

export function assertPresentation(value, sample) {
  assert.equal(value.paper, 'paper');
  assert.equal(value.background, sample.theme === 'light' ? 'rgb(251, 241, 199)' : 'rgb(40, 40, 40)');
  assert.match(value.bodyFont, /Nebula Sans/u);
  assert.equal(value.coarse, sample.width < 500);
  assert.ok(value.overflow <= 1, `Horizontal overflow: ${value.overflow}px`);
  const controls = value.appearanceControls;
  assert.ok(Array.isArray(controls));
  assert.equal(value.forms, controls.length, 'Only finite appearance radios may be present; no data collection fields.');
  assert.equal(controls.length, sample.path === '/preview' ? 0 : 8);
  if (controls.length) {
    const palettes = controls.filter(control => control.legend === 'Theme');
    const modes = controls.filter(control => control.legend === 'Appearance');
    assert.deepEqual(palettes.map(control => control.value).sort(), ['catppuccin', 'gruvbox', 'paper', 'rose-pine', 'tokyo-night']);
    assert.deepEqual(modes.map(control => control.value).sort(), ['dark', 'light', 'system']);
    assert.ok(palettes.every(control => control.name === palettes[0].name));
    assert.ok(modes.every(control => control.name === modes[0].name));
    assert.match(palettes[0].name, /^.+-palette$/u);
    assert.equal(modes[0].name, palettes[0].name.replace(/-palette$/u, '-mode'));
  }
  assert.equal(value.footers, sample.path === '/preview' ? 0 : 1);
  assert.equal(value.headers, sample.path === '/preview' ? 0 : 1);
  assert.equal(value.askAi, sample.path === '/preview' ? 0 : 1);
  for (const family of ['hraness-ui', 'hraness-design-kit']) {
    assert.ok(value.layers.some((name) => name.startsWith(`components.${family}.priority`)), `${family} compiled layers missing.`);
  }
  for (const weight of ['400', '500', '600', '700']) assert.ok(value.fontWeights.includes(weight), `Nebula Sans ${weight} missing.`);
  assert.equal(value.preset, sample.path === '/' ? 'editorial' : null);
  assert.equal(value.material, 'lantern');
  const expectedFont = sample.path === '/' ? /InstrumentSerif/iu : /Nebula/iu;
  assert.ok(value.renderedFonts.some((font) => font.isCustomFont && font.glyphCount > 0
    && expectedFont.test(font.postScriptName || font.familyName)), 'The heading rendered with a fallback font.');
  if (sample.path === '/') {
    const h1Size = Math.min(88, Math.max(48, 33.6 + sample.width * 0.042));
    assert.ok(Math.abs(value.headingSize - h1Size) < 0.1, `Editorial H1 size: ${value.headingSize}px`);
    assert.ok(Math.abs(value.headingLeading - h1Size * 1.02) < 0.1, `Editorial H1 leading: ${value.headingLeading}px`);
    assert.ok(Math.abs(value.headingTracking + h1Size * 0.025) < 0.01);
    assert.equal(value.headingWeight, '400');
    assert.equal(value.headerMinHeight, '52px');
    assert.equal(value.headerWidth, Math.min(1216, sample.width));
    assert.equal(value.gutter, sample.width < 761 ? '20px' : '32px');
    assert.deepEqual(value.heroPadding, sample.width < 761 ? ['56px', '72px'] : [String(Math.min(112, Math.max(64, sample.width * .08))) + 'px', String(Math.min(128, Math.max(72, sample.width * .09))) + 'px']);
    const h2Size = Math.min(56, Math.max(34, 23.2 + sample.width * 0.026));
    assert.equal(value.sections.length, 9);
    for (const section of value.sections) {
      assert.match(section.font, /Instrument Serif/u);
      assert.equal(section.weight, '400');
      assert.ok(Math.abs(section.size - h2Size) < 0.1, `Editorial H2 size: ${section.size}px`);
      assert.ok(Math.abs(section.leading - h2Size * 1.08) < 0.1);
      assert.ok(Math.abs(section.tracking + h2Size * 0.02) < 0.01);
    }
    assert.equal(value.summarySize, sample.width < 761 ? 16 : Math.min(20, Math.max(17, 16 + sample.width * .0035)));
    assert.ok(Math.abs(value.summaryLeading - value.summarySize * 1.65) < 0.1);
    assert.equal(value.workspaceInk, value.bodyInk, 'The Paper file tree must not inherit inverse-surface ink.');
    assert.notEqual(value.workspaceBackground, 'rgba(0, 0, 0, 0)');
    assert.notEqual(value.frameBackground, 'rgba(0, 0, 0, 0)');
    assert.ok(value.actionHeights.length >= 5, 'The header, hero and closing actions must all remain styled.');
    assert.ok(value.actionHeights.every((height) => height >= (sample.width < 500 ? 44 : 42)));
    assert.ok(value.actionRadii.every((radius) => radius === '12px'), 'Material controls retain their shared 12px radius.');
    assert.equal(value.headerBackdrop, 'blur(20px) saturate(1.1)');
    assert.equal((value.fieldBackground.match(/gradient\(/gu) ?? []).length, 3);
    assert.equal((value.fieldBackground.match(/url\(/gu) ?? []).length, 1);
    assert.ok(value.fieldBackground.includes('repeating-conic-gradient(from 45deg,'), 'The Gruvbox field uses the shared weave.');
    assert.ok(!value.fieldBackground.includes('repeating-linear-gradient('));
    assert.equal(value.fieldBackgroundSize, '64px 64px, 24px 24px, 100% 100%, 100% 100%');
  }
}
