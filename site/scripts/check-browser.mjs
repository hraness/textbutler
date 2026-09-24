import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { assertBuildJoin, assertPresentation, assertServerExit, browserCases, browserEnvironment, browserMediaFeatures, browserOwner,
  deadline, finishBrowserCase, isPreviewPolicyBlock, isSyntheticBadge, routeTasks } from './browser-contract.mjs';

// This gate serves only the built informational website. It never runs the CLI,
// Mac application, messaging providers, account checks, or personal-data readers.

// Reviewed design-kit source d38d13c07d7956d02ddfbca8d32aa2066d88fbd3 assets,
// checked independently of the current build.
async function assertWallAssets(context, background, origin) {
  const expected = [
    ['grain', 152319, 'b40c33a0e382c8e9d0518b4720321b5c262a929c28d40a190a902d07acd06553'],
  ];
  const urls = [...background.matchAll(/url\("([^"]+)"\)/gu)].map(match => new URL(match[1], origin));
  assert.equal(urls.length, expected.length);
  const result = [];
  for (const [index, url] of urls.entries()) {
    const [name, size, sha256] = expected[index];
    assert.equal(url.origin, origin); assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.match(url.pathname, new RegExp(`^/_next/static/media/${name}\\.[a-f0-9]+\\.svg$`, 'u'));
    const response = await context.request.get(url.href, { timeout: 5000, maxRedirects: 0 });
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    assert.equal(bytes.length, size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
    result.push({ name, path: url.pathname, bytes: size, sha256 });
  }
  return result;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const executablePath = process.env.TEXTBUTLER_BROWSER_EXECUTABLE;
const node = process.env.TEXTBUTLER_NODE_EXECUTABLE;
assert.ok(executablePath?.startsWith('/'), 'Set TEXTBUTLER_BROWSER_EXECUTABLE to an installed Chromium executable.');
assert.ok(node?.startsWith('/'), 'Set TEXTBUTLER_NODE_EXECUTABLE to an installed Node 24 executable.');
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const present = await access(join(root, name)).then(() => true, () => false);
  assert.equal(present, false, `This verification checkout must not contain ${name}; preserve private environment files.`);
}
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
assert.equal(git('status', '--porcelain=v1'), '', 'Commit the converged browser candidate first.');
const directory = join(root, '.browser-artifacts', new Date().toISOString().replaceAll(':', '-'));
const home = join(directory, 'runtime-home');
const profile = join(directory, 'chromium-profile');
await mkdir(home, { recursive: true, mode: 0o700 });
const env = browserEnvironment(process.env, home);
const badgeFixture = await readFile(join(root, 'scripts/fixtures/skills-badge.svg'));
const nodeVersion = execFileSync(node, ['--version'], { env, encoding: 'utf8' }).trim();
assert.match(nodeVersion, /^v24\./u);
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const sourceInputs = async () => ({ head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  status: git('status', '--porcelain=v1'), lock: await digest(join(root, 'bun.lock')),
  manifest: await digest(join(root, 'package.json')) });
const beforeBuild = await sourceInputs();
assert.equal(beforeBuild.head, head);
assert.equal(beforeBuild.tree, tree);
const report = { head, tree, dirty: false, nodeVersion, bunVersion: process.versions.bun,
  browserSha256: await digest(executablePath), lockfileSha256: beforeBuild.lock,
  profile, cases: [], passed: false, cleanup: { build: false, browser: false, server: false } };
const next = join(root, 'node_modules/next/dist/bin/next');
let build;
let server;
function spawnOwned(args) {
  const child = spawn(node, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const owned = { child, stopRequested: false, forced: false, error: undefined, exit: undefined, closed: undefined };
  owned.closed = new Promise((resolve) => {
    child.once('error', (error) => { owned.error = error; });
    child.once('close', (code, signal) => {
      owned.exit = { code, signal, stopRequested: owned.stopRequested, forced: owned.forced };
      resolve(owned.exit);
    });
  });
  return owned;
}
async function stopChild(owned, name) {
  if (!owned) return;
  const alive = () => owned.child.exitCode === null && owned.child.signalCode === null && !owned.exit;
  if (alive()) {
    owned.stopRequested = true;
    if (!owned.child.kill('SIGTERM')) owned.stopRequested = false;
  }
  const force = setTimeout(() => {
    if (alive()) { owned.forced = true; owned.child.kill('SIGKILL'); }
  }, 5_000);
  try {
    await deadline(owned.closed, `${name} cleanup`);
    if (owned.error) throw owned.error;
    if (name === 'server') assertServerExit(owned.exit);
    report.cleanup[name] = true;
  } finally { clearTimeout(force); }
}
const owner = browserOwner({
  launch: () => chromium.launchPersistentContext(profile, { executablePath, env, headless: true,
    args: ['--mute-audio'], timeout: 20_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }),
  close: async (context) => { await deadline(context.close(), 'Browser cleanup'); report.cleanup.browser = true; },
  stopServer: async () => {
    const errors = [];
    for (const [owned, name] of [[build, 'build'], [server, 'server']]) {
      try { await stopChild(owned, name); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('\n'));
  },
});
let interrupted = false;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => {
    interrupted = true;
    process.exitCode = code;
    void owner.stop().catch(() => { process.exitCode = 1; });
  });
}

try {
  assert.equal(interrupted, false);
  assert.deepEqual(await sourceInputs(), beforeBuild);
  assert.equal(interrupted, false);
  // The browser owns this exact build, not an arbitrary pre-existing .next.
  build = spawnOwned([next, 'build', '--webpack']);
  report.buildPid = build.child.pid;
  build.child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  build.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const buildExit = await deadline(build.closed, 'Same-invocation Next build', 180_000);
  if (build.error) throw build.error;
  const afterBuild = await sourceInputs();
  assertBuildJoin(beforeBuild, afterBuild, buildExit.code);
  assert.equal(interrupted, false);
  report.buildId = (await readFile(join(root, '.next/BUILD_ID'), 'utf8')).trim();
  assert.ok(report.buildId);
  report.build = { command: [node, next, 'build', '--webpack'], before: beforeBuild, after: afterBuild, exit: buildExit,
    environmentSha256: createHash('sha256').update(JSON.stringify(env)).digest('hex') };
  assert.equal(interrupted, false);
  server = spawnOwned([next, 'start', '--hostname', '127.0.0.1', '--port', '0']);
  report.serverPid = server.child.pid;
  let output = '';
  const ready = deadline(new Promise((resolve, reject) => {
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-8_000);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/u);
      if (match && output.includes('Ready in')) resolve(`http://127.0.0.1:${match[1]}`);
    };
    server.child.stdout.on('data', capture);
    server.child.stderr.on('data', capture);
    server.child.once('error', reject);
    server.child.once('close', (code) => reject(new Error(`Next exited ${code}: ${output}`)));
  }), 'Next startup', 30_000);
  const origin = await ready;
  assert.equal(interrupted, false);
  const persistent = await owner.start();
  const browser = persistent.browser();
  assert.ok(browser);
  report.browserVersion = browser.version();
  const census = await deadline(browser.newBrowserCDPSession(), 'Browser census session');
  report.browserPid = (await deadline(census.send('SystemInfo.getProcessInfo'), 'Browser process census')).processInfo.find((item) => item.type === 'browser')?.id;
  await deadline(census.detach(), 'Browser census detach');
  for (const sample of browserCases()) {
    assert.equal(interrupted, false);
    const context = await deadline(browser.newContext({ viewport: { width: sample.width, height: 900 },
      colorScheme: sample.theme, isMobile: sample.width < 500, hasTouch: sample.width < 500,
      reducedMotion: 'reduce', serviceWorkers: 'block' }), 'Context startup');
    const item = { ...sample, passed: false };
    report.cases.push(item);
    let page;
    let primary;
    let verifiedCsp = false;
    let authoredAssets = [];
    const name = `${sample.width}-${sample.theme}-${sample.path.slice(1) || 'home'}`;
    const unexpected = [];
    const failures = [];
    const failedRequests = [];
    const pendingRequests = new Set();
    const routes = routeTasks(failures);
    let activity = 0;
    item.failures = failures;
    item.failedRequests = failedRequests;
    try {
      const assets = new Set();
      item.syntheticAssets = [];
      await deadline(context.route('**/*', (route) => routes.run(async () => {
        const request = route.request();
        const url = new URL(request.url());
        if (isSyntheticBadge({ url: request.url(), method: request.method(), resourceType: request.resourceType() })) {
          item.syntheticAssets.push('Repository fixture: README skills.sh badge (no external request).');
          await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: badgeFixture });
        } else if ((url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) && ['GET', 'HEAD'].includes(request.method())) {
          await route.continue();
        } else {
          unexpected.push({ origin: url.origin, path: url.pathname, method: request.method() });
          await route.abort();
        }
      })), 'Route interception');
      page = await deadline(context.newPage(), 'Page startup');
      const mediaSession = await deadline(context.newCDPSession(page), 'Media fixture session');
      const applyMedia = (transparency) => deadline(mediaSession.send('Emulation.setEmulatedMedia', {
        features: browserMediaFeatures(sample.theme, transparency),
      }), 'Media fixture application');
      await applyMedia('no-preference');
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(15_000);
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('request', (request) => { pendingRequests.add(request); activity += 1; });
      page.on('requestfinished', (request) => { pendingRequests.delete(request); activity += 1; });
      page.on('requestfailed', (request) => {
        pendingRequests.delete(request); activity += 1;
        failedRequests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType(),
          error: request.failure()?.errorText, mainFrame: request.frame() === page.mainFrame() });
      });
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname;
        if (response.status() >= 400) failures.push(`${response.status()} ${path}`);
        if (/\.(?:css|woff2|svg)(?:$|\?)/u.test(path)) assets.add(path);
      });
      const response = await page.goto(origin + sample.path, { waitUntil: 'load' });
      assert.equal(response.status(), 200);
      assert.equal(response.url(), origin + sample.path);
      const csp = (await deadline(response.allHeaders(), 'Response security headers'))['content-security-policy'];
      verifiedCsp = ["default-src 'none'", "script-src 'none'", "style-src 'self'", "font-src 'self' data:",
        'frame-ancestors https://hraness.com https://www.hraness.com'].every((directive) => csp?.split(';').map((part) => part.trim()).includes(directive));
      if (sample.path === '/preview') {
        assert.equal(verifiedCsp, true, 'The frame-safe preview must retain its actual script-free response policy.');
        assert.equal(await deadline(page.evaluate(() => Object.hasOwn(window, '__next_f')), 'Preview runtime inspection'), false, 'Preview scripts must not execute.');
        item.previewCsp = csp;
        authoredAssets = await deadline(page.evaluate(() => [...document.querySelectorAll('script[src], link[rel="preload"][as="script"], link[rel="manifest"]')]
          .map((element) => new URL(element.getAttribute('src') || element.getAttribute('href'), document.baseURI).href)), 'Preview authored assets');
        item.previewAuthoredAssets = authoredAssets;
      }
      await deadline(page.evaluate(async (landing) => {
        for (const weight of ['400', '500', '600', '700']) await document.fonts.load(`${weight} 16px "Nebula Sans"`, 'Textbutler');
        if (landing) await document.fonts.load('400 48px "Instrument Serif"', 'conversations');
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, sample.path === '/'), 'Font settlement', 15_000);
      const metrics = await deadline(page.evaluate(() => {
        const heading = document.querySelector('h1');
        const style = getComputedStyle(heading);
        const headerInner = document.querySelector('.hraness-marketing-header__inner');
        const field = document.querySelector('.hraness-material-wall');
        const hero = document.querySelector('.hraness-marketing-hero');
        const summary = document.querySelector('.hraness-marketing-hero__summary');
        const workspace = document.querySelector('.workspace-example pre');
        const frame = document.querySelector('.hraness-marketing-proof-frame');
        const layers = [];
        const visit = (rules) => {
          for (const rule of rules) {
            if (rule.constructor.name === 'CSSLayerBlockRule') layers.push(rule.name);
            if (rule.styleSheet) visit(rule.styleSheet.cssRules);
            else if (rule.cssRules) visit(rule.cssRules);
          }
        };
        for (const sheet of document.styleSheets) visit(sheet.cssRules);
        return { paper: document.documentElement.dataset.hranessTheme,
          reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
          background: getComputedStyle(document.body).backgroundColor,
          bodyFont: getComputedStyle(document.body).fontFamily,
          bodyInk: getComputedStyle(document.body).color,
          coarse: matchMedia('(pointer: coarse)').matches,
          overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
          forms: document.querySelectorAll('form,input,textarea').length,
          appearanceControls: [...document.querySelectorAll('.hraness-marketing-header details[data-hraness-appearance-menu] fieldset input[type=radio]')].filter(input => input.form === null).map(input => ({name: input.name, value: input.value, legend: input.closest('fieldset').querySelector('legend')?.textContent})),
          headers: document.querySelectorAll('.hraness-marketing-header').length,
          footers: document.querySelectorAll('.hraness-marketing-footer').length,
          askAi: document.querySelectorAll('.message-like-me-ask-ai').length,
          preset: document.querySelector('[data-hraness-marketing-preset]')?.getAttribute('data-hraness-marketing-preset') ?? null,
          headingFont: style.fontFamily, headingSize: Number.parseFloat(style.fontSize),
          headingLeading: Number.parseFloat(style.lineHeight), headingWeight: style.fontWeight,
          headingTracking: Number.parseFloat(style.letterSpacing),
          headerMinHeight: headerInner && getComputedStyle(headerInner).minHeight,
          headerWidth: headerInner?.getBoundingClientRect().width,
          gutter: headerInner && getComputedStyle(headerInner).paddingInlineStart,
          heroPadding: hero && [getComputedStyle(hero).paddingBlockStart, getComputedStyle(hero).paddingBlockEnd],
          summarySize: summary && Number.parseFloat(getComputedStyle(summary).fontSize),
          summaryLeading: summary && Number.parseFloat(getComputedStyle(summary).lineHeight),
          workspaceInk: workspace && getComputedStyle(workspace).color,
          workspaceBackground: workspace && getComputedStyle(workspace).backgroundColor,
          frameBackground: frame && getComputedStyle(frame).backgroundColor,
          sections: [...document.querySelectorAll('.textbutler-marketing h2')].map((element) => {
            const style = getComputedStyle(element);
            return { font: style.fontFamily, weight: style.fontWeight, size: Number.parseFloat(style.fontSize),
              leading: Number.parseFloat(style.lineHeight), tracking: Number.parseFloat(style.letterSpacing) };
          }),
          fieldBackground: field && getComputedStyle(field).backgroundImage,
          fieldBackgroundSize: field && getComputedStyle(field).backgroundSize,
          material: document.querySelector('[data-hraness-material]')?.getAttribute('data-hraness-material') ?? null,
          headerBackdrop: headerInner && getComputedStyle(headerInner.closest('header')).backdropFilter,
          actionHeights: [...document.querySelectorAll('.hraness-marketing-action')].map((action) => action.getBoundingClientRect().height),
          actionRadii: [...document.querySelectorAll('.hraness-marketing-action')].map((action) => getComputedStyle(action).borderRadius),
          fontWeights: [...document.fonts].filter((font) => font.status === 'loaded' && font.family.includes('Nebula Sans')).map((font) => font.weight),
          layers };
      }), 'Presentation metrics');
      const cdp = await deadline(context.newCDPSession(page), 'Font inspection session');
      await deadline(cdp.send('DOM.enable'), 'Font DOM inspection');
      await deadline(cdp.send('CSS.enable'), 'Font CSS inspection');
      const { root: documentNode } = await deadline(cdp.send('DOM.getDocument'), 'Font document inspection');
      const { nodeId } = await deadline(cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: 'h1' }), 'Font heading inspection');
      metrics.renderedFonts = (await deadline(cdp.send('CSS.getPlatformFontsForNode', { nodeId }), 'Rendered font inspection')).fonts;
      await deadline(cdp.detach(), 'Font inspection detach');
      item.metrics = metrics;
      item.assets = [...assets].sort();
      assert.equal(metrics.reducedTransparency, false);
      assertPresentation(metrics, sample);
      if (sample.path === '/') {
        item.textures = await assertWallAssets(context, metrics.fieldBackground, origin);
        await applyMedia('reduce');
        await page.waitForFunction(() => matchMedia('(prefers-reduced-transparency: reduce)').matches
          && getComputedStyle(document.querySelector('.hraness-marketing-header')).backdropFilter === 'none'
          && getComputedStyle(document.querySelector('.hraness-material-wall')).backgroundImage === 'none');
        item.reducedTransparency = await deadline(page.evaluate(() => ({
          matches: matchMedia('(prefers-reduced-transparency: reduce)').matches,
          headerBackdrop: getComputedStyle(document.querySelector('.hraness-marketing-header')).backdropFilter,
          fieldBackground: getComputedStyle(document.querySelector('.hraness-material-wall')).backgroundImage,
        })), 'Reduced transparency metrics');
        assert.deepEqual(item.reducedTransparency, { matches: true, headerBackdrop: 'none', fieldBackground: 'none' });
        await applyMedia('no-preference');
        await page.waitForFunction((expected) => !matchMedia('(prefers-reduced-transparency: reduce)').matches
          && getComputedStyle(document.querySelector('.hraness-marketing-header')).backdropFilter === expected.headerBackdrop
          && getComputedStyle(document.querySelector('.hraness-material-wall')).backgroundImage === expected.fieldBackground,
        { headerBackdrop: metrics.headerBackdrop, fieldBackground: metrics.fieldBackground });
        const restored = await deadline(page.evaluate(() => ({
          matches: matchMedia('(prefers-reduced-transparency: reduce)').matches,
          headerBackdrop: getComputedStyle(document.querySelector('.hraness-marketing-header')).backdropFilter,
          fieldBackground: getComputedStyle(document.querySelector('.hraness-material-wall')).backgroundImage,
        })), 'Restored transparency metrics');
        assert.deepEqual(restored, { matches: false, headerBackdrop: metrics.headerBackdrop, fieldBackground: metrics.fieldBackground });
        const summary = page.locator('.hraness-marketing-question > summary').first();
        await summary.focus();
        await summary.press('Enter');
        await page.locator('details[open]').first().waitFor({ state: 'visible' });
        await summary.press('Enter');
        assert.equal(await page.locator('details[open]').count(), 0);
        await page.getByRole('link', { name: 'See what’s ready', exact: true }).click();
        await page.waitForURL((url) => url.hash === '#development');
        await page.getByRole('heading', { name: 'Start with a reply you review', exact: true }).waitFor({ state: 'visible' });
        item.interaction = 'Keyboard FAQ opened and closed; development action reached its real section.';
      } else if (sample.path === '/docs') {
        const link = page.locator('.document-prose a[href^="#"]').first();
        const target = await link.getAttribute('href');
        await link.click();
        await page.waitForURL((url) => url.hash === target);
        item.interaction = 'Generated documentation anchor navigated to its source-owned section.';
      }
      if (sample.path !== '/preview') {
        await page.locator('.skip-link').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.id === 'main-content');
        item.skipLink = 'Keyboard skip link focused the main content.';
      }
      await deadline(page.evaluate(() => window.scrollTo(0, 0)), 'Screenshot scroll');
      await page.screenshot({ path: join(directory, `${name}-viewport.png`), fullPage: false });
      await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
    } catch (error) {
      primary = error;
      if (page) await page.screenshot({ path: join(directory, `${name}-failed.png`), fullPage: true, timeout: 5_000 }).catch(() => {});
    }
    try {
      await finishBrowserCase({ primary,
        settle: async () => {
          const until = performance.now() + 10_000;
          while (performance.now() < until) {
            const previous = activity;
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (pendingRequests.size === 0 && routes.size === 0 && activity === previous) return;
          }
          throw new Error(`Request settlement exceeded 10000ms (${pendingRequests.size} requests, ${routes.size} route handlers).`);
        },
        close: () => deadline(context.close(), 'Context cleanup', 5_000),
        drain: () => routes.drain(),
        check: () => {
          item.policyBlocks = [];
          for (const request of failedRequests) {
            if (isPreviewPolicyBlock(request, { path: sample.path, origin, verifiedCsp, authoredAssets })) item.policyBlocks.push(request);
            else failures.push(`Request failed: ${new URL(request.url).pathname} ${request.error}`);
          }
          if (sample.path === '/preview') assert.ok(item.policyBlocks.length > 0, 'Native CSP enforcement must be observed.');
          assert.equal(pendingRequests.size, 0, 'Every request must settle before accepting the case.');
          assert.deepEqual(unexpected, [], 'The isolated browser must not send external requests or writes.');
          assert.deepEqual(failures, [], 'Browser and asset failures must remain visible.');
        },
      });
      item.passed = true;
      console.log(`PASS ${name}`);
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain=v1'), '');
  assert.equal(interrupted, false);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (!interrupted) process.exitCode = 1;
} finally {
  try { await owner.stop(); }
  catch (error) { report.cleanup.error = String(error); report.passed = false; process.exitCode = 1; }
  report.serverExit = server?.exit;
  report.buildExit = build?.exit;
  if (report.passed) {
    try { assertBuildJoin(beforeBuild, await sourceInputs(), 0); }
    catch (error) { report.error = String(error); report.passed = false; process.exitCode = 1; }
  }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, error: report.error,
    cleanup: report.cleanup, receipt: join(directory, 'receipt.json') }));
}
