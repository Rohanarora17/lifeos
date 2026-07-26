'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const {
  labels,
  scoreResults,
} = require('./benchmark-native-vision.cjs');

const execFileAsync = promisify(execFile);
const serverUrl = process.env.LIFEOS_SERVER_URL;
const apiToken = process.env.LIFEOS_API_TOKEN;
const deviceToken = process.env.LIFEOS_DEVICE_TOKEN;
const allowProduction = process.env.LIFEOS_BENCHMARK_ALLOW_PRODUCTION === 'true';
const copilotBin = process.env.LIFEOS_COPILOT_BIN
  || path.join(
    os.homedir(),
    'Library/Application Support/LifeOS/LifeOSCopilot.app/Contents/MacOS/LifeOSCopilot',
  );
const resultPath = process.env.LIFEOS_BENCHMARK_RESULT_PATH
  || path.join(process.cwd(), 'output/guardian-audit/vision-real-app-matrix.json');
const fileAppInitialPids = new Map();
const openedFileApps = new Set();
const ownedFileAppPids = new Set();

const topics = [
  'Polynomial commitments',
  'Range proofs',
  'Finite-field arithmetic',
  'Merkle membership proofs',
];
const tutorialVideos = [
  {
    path: '/System/Library/CoreServices/NotificationCenter.app/Contents/Resources/mac_widgets-edu_small.mov',
    title: 'mac_widgets-edu_small',
    topic: 'macOS widgets',
    goal: 'Learn macOS widgets using the tutorial video',
  },
  {
    path: '/System/Library/CoreServices/Setup Assistant.app/Contents/Resources/trackpad_placeholder.mov',
    title: 'trackpad_placeholder',
    topic: 'Mac trackpad basics',
    goal: 'Learn Mac trackpad basics using the tutorial video',
  },
  {
    path: '/System/Library/ExtensionKit/Extensions/MouseExtension.appex/Contents/Resources/Mouse.mov',
    title: 'Mouse',
    topic: 'Mac mouse gestures',
    goal: 'Learn Mac mouse gestures using the tutorial video',
  },
  {
    path: '/System/Library/ExtensionKit/Extensions/TrackpadExtension.appex/Contents/Resources/Trackpad.mov',
    title: 'Trackpad',
    topic: 'Mac trackpad gestures',
    goal: 'Learn Mac trackpad gestures using the tutorial video',
  },
];

function makeCases() {
  const cases = [];
  for (let index = 0; index < topics.length; index++) {
    const ordinal = String(index + 1).padStart(2, '0');
    const topic = topics[index];
    const tutorialVideo = tutorialVideos[index];
    const secondaryCreationCase = {
      id: `cursor-implementation-${ordinal}`,
      kind: 'editor',
      app: 'Cursor',
      expectedApp: /Cursor/i,
      expectedAppName: 'Cursor',
      expectedTitle: `AUDIT-cursor-implementation-${ordinal}`,
      label: 'active_creation',
      expectedAlignment: 95,
      topic,
      goal: 'Study zero-knowledge proofs and implement proof-system exercises',
    };
    const readingCase = index === 0
      ? {
        id: `preview-reading-${ordinal}`,
        kind: 'pdf',
        app: 'Preview',
        expectedApp: /Preview/i,
        expectedAppName: 'Preview',
        expectedTitle: `AUDIT-preview-reading-${ordinal}`,
        label: 'passive_consumption',
        expectedAlignment: 95,
        topic,
        goal: 'Read a zero-knowledge proof research paper',
      }
      : {
        id: `edge-reading-${ordinal}`,
        kind: 'browser',
        browser: 'msedge',
        expectedApp: /Microsoft Edge/i,
        expectedAppName: 'Microsoft Edge',
        expectedTitle: `AUDIT-edge-reading-${ordinal}`,
        label: 'passive_consumption',
        expectedAlignment: 95,
        topic,
        goal: 'Read a zero-knowledge proof research paper',
      };
    const secondaryIdleCase = {
      id: `edge-idle-${ordinal}`,
      kind: 'browser',
      browser: 'msedge',
      expectedApp: /Microsoft Edge/i,
      expectedAppName: 'Microsoft Edge',
      expectedTitle: `AUDIT-edge-idle-${ordinal}`,
      label: 'idle',
      expectedAlignment: 5,
      topic,
      goal: 'Study zero-knowledge proofs and write implementation notes',
    };
    cases.push(
      {
        id: `cursor-creation-${ordinal}`,
        kind: 'editor',
        app: 'Cursor',
        expectedApp: /Cursor/i,
        expectedAppName: 'Cursor',
        expectedTitle: `AUDIT-cursor-creation-${ordinal}`,
        label: 'active_creation',
        expectedAlignment: 95,
        topic,
        goal: 'Study zero-knowledge proofs and write implementation notes',
      },
      secondaryCreationCase,
      {
        id: `edge-learning-${ordinal}`,
        kind: 'browser',
        browser: 'msedge',
        expectedApp: /Microsoft Edge/i,
        expectedAppName: 'Microsoft Edge',
        expectedTitle: `AUDIT-edge-learning-${ordinal}`,
        label: 'active_learning',
        expectedAlignment: 95,
        topic,
        goal: 'Study zero-knowledge proofs and resolve unclear concepts',
      },
      {
        id: `chrome-learning-${ordinal}`,
        kind: 'browser',
        browser: 'chrome',
        expectedApp: /Google Chrome/i,
        expectedAppName: 'Google Chrome',
        expectedTitle: `AUDIT-chrome-learning-${ordinal}`,
        label: 'active_learning',
        expectedAlignment: 95,
        topic,
        goal: 'Study zero-knowledge proofs and resolve unclear concepts',
      },
      readingCase,
      {
        id: `quicktime-video-${ordinal}`,
        kind: 'video',
        app: 'QuickTime Player',
        expectedApp: /QuickTime Player/i,
        expectedAppName: 'QuickTime Player',
        expectedTitle: tutorialVideo.title,
        label: 'passive_consumption',
        expectedAlignment: 95,
        topic: tutorialVideo.topic,
        goal: tutorialVideo.goal,
        videoPath: tutorialVideo.path,
      },
      secondaryIdleCase,
      {
        id: `chrome-idle-${ordinal}`,
        kind: 'browser',
        browser: 'chrome',
        expectedApp: /Google Chrome/i,
        expectedAppName: 'Google Chrome',
        expectedTitle: `AUDIT-chrome-idle-${ordinal}`,
        label: 'idle',
        expectedAlignment: 5,
        topic,
        goal: 'Study zero-knowledge proofs and write implementation notes',
      },
      {
        id: `chrome-distraction-${ordinal}`,
        kind: 'browser',
        browser: 'chrome',
        expectedApp: /Google Chrome/i,
        expectedAppName: 'Google Chrome',
        expectedTitle: `AUDIT-chrome-distraction-${ordinal}`,
        label: 'distraction',
        expectedAlignment: 5,
        topic,
        goal: 'Study zero-knowledge proofs and write implementation notes',
      },
      {
        id: `brave-distraction-${ordinal}`,
        kind: 'browser',
        browser: 'brave',
        expectedApp: /Brave Browser/i,
        expectedAppName: 'Brave Browser',
        expectedTitle: `AUDIT-brave-distraction-${ordinal}`,
        label: 'distraction',
        expectedAlignment: 5,
        topic,
        goal: 'Study zero-knowledge proofs and write implementation notes',
      },
    );
  }
  return cases;
}

function makePrivacyCases() {
  return [
    { id: 'privacy-whatsapp', app: 'WhatsApp', expectedRule: 'sensitive_app:whatsapp' },
    { id: 'privacy-messages', app: 'Messages', expectedRule: 'sensitive_app:messages' },
    { id: 'privacy-facetime', app: 'FaceTime', expectedRule: 'sensitive_app:facetime' },
    { id: 'privacy-zoom', app: 'zoom.us', expectedRule: 'sensitive_app:zoom' },
  ];
}

function productiveHtml(testCase) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>AUDIT-${testCase.id}</title>
    <style>
      body{margin:0;font-family:Arial,sans-serif;background:#f4f6f8;color:#17202a}
      header{padding:22px 42px;background:#17202a;color:#fff}
      main{display:grid;grid-template-columns:1fr 340px;min-height:760px}
      article{padding:48px 7%;background:#fff;font:20px/1.65 Georgia,serif}
      aside{padding:38px;background:#eaf2f8}h1{font:38px/1.2 Arial,sans-serif}
      .exercise{padding:26px;border-left:6px solid #2471a3;background:#edf6fc}
      textarea{width:100%;height:180px;font-size:17px}
    </style></head><body>
    <header>Interactive cryptography lesson | ${testCase.topic}</header>
    <main><article><h1>${testCase.topic}</h1>
      <p>Work through the definition, identify the security assumption, and
      compare the prover and verifier responsibilities.</p>
      <div class="exercise"><b>Active exercise</b><p>Derive the challenge and
      explain why the transcript remains binding.</p></div>
      <h2>Concept check</h2><p>Write the missing verification equation before
      continuing to the next section.</p></article>
      <aside><h2>My working notes</h2><textarea>Step 1: define the witness relation.
Step 2: derive the verifier equation.
Question to resolve:</textarea></aside></main></body></html>`;
}

function distractionHtml(testCase) {
  const stories = [
    'Celebrity reactions and viral clips',
    'Weekend shopping offers',
    'Championship highlight reels',
    'Travel deals and entertainment news',
  ];
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>AUDIT-${testCase.id}</title>
    <style>
      body{margin:0;font-family:Arial,sans-serif;background:#f2f3f4;color:#17202a}
      header{padding:20px 38px;background:#922b21;color:#fff}
      main{padding:45px}.hero{padding:55px;background:#fff;border-top:8px solid #c0392b}
      h1{font-size:48px;max-width:800px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
      article{padding:32px;background:#fff}button{padding:14px 24px}
    </style></head><body><header>Daily Buzz | Entertainment feed</header>
    <main><section class="hero"><small>TRENDING NOW</small>
      <h1>${stories[Number(testCase.id.slice(-2)) - 1]}</h1>
      <p>Unrelated recommendations, short videos, and shopping stories.</p>
      <button>Play next clip</button></section>
      <section class="grid"><article>Top memes today</article>
      <article>Flash sale</article><article>Recommended videos</article></section>
    </main></body></html>`;
}

function passiveHtml(testCase) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>AUDIT-${testCase.id}</title>
    <style>
      body{margin:0;font:19px/1.7 Georgia,serif;background:#e5e7e9;color:#17202a}
      article{width:820px;min-height:1040px;margin:28px auto;padding:68px 76px;background:#fff}
      h1{font:38px/1.2 Arial,sans-serif}.authors{color:#566573}.theorem{padding:24px;
      background:#f4f6f8;border-left:5px solid #566573}.page{text-align:center;color:#85929e}
    </style></head><body><article><p class="authors">Cryptography Research Group</p>
    <h1>${testCase.topic}: foundations and current constructions</h1>
    <p><b>Abstract.</b> This paper surveys the definitions and assumptions used
    in modern zero-knowledge proof systems.</p><h2>3. Security definition</h2>
    <p>A protocol is zero knowledge when a simulator can reproduce the
    verifier's view without access to the witness. The construction remains
    complete for valid witnesses and computationally sound under the stated
    assumption.</p><div class="theorem"><b>Theorem 3.2.</b> Under the discrete
    logarithm assumption, the commitment construction is computationally
    binding.</div><p>No editor, exercise, or notes panel is open. This is a
    read-only paper view.</p><p class="page">Page 19</p></article></body></html>`;
}

function textFixture(testCase) {
  if (testCase.kind === 'idle-text') return '';
  return `AUDIT ${testCase.id}

${testCase.topic} implementation notes

Current goal: write and test the prover constraint.

export function verifyWitness(witness: bigint) {
  const challenge = transcript.squeeze();
  return commit(witness, challenge);
}

Working now:
1. Check the field bounds.
2. Add the negative test.
3. Explain the soundness assumption.
`;
}

function idleHtml(testCase) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>AUDIT-${testCase.id}</title>
    <style>
      body{margin:0;display:grid;place-items:center;height:100vh;background:#f5f5f5;
      font-family:Arial,sans-serif;color:#566573}.state{text-align:center}
      h1{font-size:40px;font-weight:400}.clock{font:64px Menlo,monospace}
    </style></head><body><div class="state"><small>SESSION PAUSED</small>
    <h1>No active work is visible</h1><div class="clock">00:00</div>
    <p>No keyboard or pointer activity detected.</p></div></body></html>`;
}

async function writeFixtures(root, cases) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const paths = new Map();
  try {
    for (const testCase of cases) {
      if (testCase.kind === 'editor' || testCase.kind === 'idle-text') {
        const fixturePath = path.join(root, `AUDIT-${testCase.id}.txt`);
        await fs.writeFile(fixturePath, textFixture(testCase), { mode: 0o600 });
        paths.set(testCase.id, fixturePath);
      } else if (testCase.kind === 'pdf' || testCase.kind === 'idle-pdf') {
        const fixturePath = path.join(root, `AUDIT-${testCase.id}.pdf`);
        await page.setContent(
          testCase.kind === 'idle-pdf' ? idleHtml(testCase) : passiveHtml(testCase),
          { waitUntil: 'domcontentloaded' },
        );
        await page.pdf({
          path: fixturePath,
          format: 'A4',
          printBackground: true,
          margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
        });
        await fs.chmod(fixturePath, 0o600);
        paths.set(testCase.id, fixturePath);
      }
    }
  } finally {
    await browser.close();
  }
  return paths;
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function startSession(goal) {
  return jsonFetch(`${serverUrl}/api/guardian/session/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topic: goal,
      goalTitle: goal,
      durationMinutes: 45,
      source: 'api',
      sessionContext: 'Disposable-database real-application vision audit.',
    }),
  });
}

async function endSession(sessionId) {
  return jsonFetch(`${serverUrl}/api/guardian/session/end`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sessionId }),
  });
}

async function captureFrontmost(id, expectedApp, expectedTitle) {
  const outputPath = path.join(os.tmpdir(), `lifeos-real-app-${process.pid}-${id}.jpg`);
  try {
    const args = ['--capture-once', outputPath];
    if (expectedApp) args.push('--expect-app', expectedApp);
    if (expectedTitle) args.push('--expect-title', expectedTitle);
    const { stdout } = await execFileAsync(copilotBin, args, {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    const metadata = JSON.parse(stdout.trim());
    const base64Jpeg = metadata.status === 'captured'
      ? (await fs.readFile(outputPath)).toString('base64')
      : null;
    return { metadata, outputPath, base64Jpeg };
  } catch (error) {
    return {
      metadata: { status: 'capture_error', error: error.message },
      outputPath,
      base64Jpeg: null,
    };
  }
}

async function uploadCapture(sessionId, capture) {
  return jsonFetch(`${serverUrl}/api/guardian/vision`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'capture',
      sessionId,
      base64Jpeg: capture.base64Jpeg,
      appInFocus: capture.metadata.app,
      windowTitle: capture.metadata.title,
    }),
  });
}

async function frontmostPid() {
  const { stdout: front } = await execFileAsync('lsappinfo', ['front']);
  const { stdout: info } = await execFileAsync('lsappinfo', [
    'info',
    '-only',
    'pid',
    front.trim(),
  ]);
  const match = info.match(/"pid"=(\d+)/);
  return match ? Number(match[1]) : null;
}

async function runningPids(processName) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', processName]);
    return new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number));
  } catch {
    return new Set();
  }
}

async function launchFileApp(testCase, fixturePath) {
  if (!fileAppInitialPids.has(testCase.app)) {
    fileAppInitialPids.set(testCase.app, await runningPids(testCase.app));
  }
  const initialPids = fileAppInitialPids.get(testCase.app);
  const firstOpen = !openedFileApps.has(testCase.app);
  const openArgs = initialPids.size === 0 && firstOpen
    ? ['-F', '-a', testCase.app, fixturePath]
    : ['-a', testCase.app, fixturePath];
  await execFileAsync('open', openArgs);
  openedFileApps.add(testCase.app);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const pid = await frontmostPid();
  if (pid && !initialPids.has(pid)) ownedFileAppPids.add(pid);
  return {
    async reactivate() {
      await execFileAsync('open', ['-a', testCase.app, fixturePath]);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    },
    async close() {},
  };
}

async function closeOwnedFileApps() {
  for (const pid of ownedFileAppPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The audit-owned app may already have exited.
    }
  }
  openedFileApps.clear();
  ownedFileAppPids.clear();
}

async function launchStandaloneApp(app) {
  const before = await runningPids(app);
  await execFileAsync('open', ['-n', '-a', app]);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await execFileAsync('open', ['-a', app]);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const pid = await frontmostPid();
  return {
    async close() {
      if (pid && !before.has(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The fixture app may already have exited.
        }
      }
    },
  };
}

async function launchFreshFileApp(testCase, fixturePath) {
  const before = await runningPids(testCase.app);
  await execFileAsync('open', ['-F', '-a', testCase.app, fixturePath]);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const pid = await frontmostPid();
  return {
    async reactivate() {
      await execFileAsync('open', ['-a', testCase.app, fixturePath]);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    },
    async close() {
      if (pid && !before.has(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The audit-owned app may already have exited.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
  };
}

async function launchBrowserCase(testCase) {
  const options = {
    headless: false,
    args: ['--window-size=1440,1000', '--disable-notifications', '--no-first-run'],
  };
  if (testCase.browser === 'brave') {
    options.executablePath = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  } else {
    options.channel = testCase.browser;
  }
  const browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await context.newPage();
  const html = testCase.label === 'distraction'
    ? distractionHtml(testCase)
    : testCase.label === 'idle'
      ? idleHtml(testCase)
      : testCase.label === 'passive_consumption'
        ? passiveHtml(testCase)
        : productiveHtml(testCase);
  await page.setContent(
    html,
    { waitUntil: 'domcontentloaded' },
  );
  await page.bringToFront();
  await page.evaluate(() => window.focus());
  await page.waitForTimeout(700);
  return {
    async reactivate() {
      await page.bringToFront();
      await page.evaluate(() => window.focus());
      await page.waitForTimeout(500);
    },
    close: () => browser.close(),
  };
}

async function launchCase(testCase, fixturePaths) {
  if (testCase.kind === 'browser') return launchBrowserCase(testCase);
  if (testCase.kind === 'video') {
    return launchFreshFileApp(testCase, testCase.videoPath);
  }
  return launchFileApp(testCase, fixturePaths.get(testCase.id));
}

async function runCaptureCase(testCase, sessionId, fixturePaths) {
  const handle = await launchCase(testCase, fixturePaths);
  let capture;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      capture = await captureFrontmost(
        testCase.id,
        testCase.expectedAppName,
        testCase.expectedTitle,
      );
      if (
        capture.metadata.status === 'captured'
        || !String(capture.metadata.privacyReason ?? '').startsWith('unexpected_frontmost_')
      ) {
        break;
      }
      await fs.unlink(capture.outputPath).catch(() => {});
      await handle.reactivate();
    }
    const appMatched = testCase.expectedApp.test(capture.metadata.app ?? '');
    const titleMatched = String(capture.metadata.title ?? '')
      .toLowerCase()
      .includes(testCase.expectedTitle.toLowerCase());
    let analysis = null;
    try {
      if (capture.base64Jpeg && appMatched && titleMatched) {
        analysis = await uploadCapture(sessionId, capture);
      }
    } finally {
      await fs.unlink(capture.outputPath).catch(() => {});
    }
    return {
      id: testCase.id,
      appKind: testCase.kind,
      expectedLabel: testCase.label,
      expectedAlignment: testCase.expectedAlignment,
      predictedLabel: analysis?.signal?.engagementDepth ?? 'unknown',
      predictedAlignment: analysis?.signal?.taskAlignment ?? null,
      confidence: analysis?.signal?.confidence ?? null,
      analyzed: analysis?.analyzed === true,
      analysisReason: analysis?.reason ?? null,
      captureStatus: capture.metadata.status,
      capturedApp: capture.metadata.app ?? null,
      capturedTitle: capture.metadata.title ?? null,
      appMatched,
      titleMatched,
    };
  } finally {
    if (capture?.outputPath) await fs.unlink(capture.outputPath).catch(() => {});
    await handle.close();
  }
}

async function runPrivacyCase(testCase) {
  const handle = await launchStandaloneApp(testCase.app);
  let capture;
  try {
    capture = await captureFrontmost(testCase.id, testCase.app, null);
    return {
      id: testCase.id,
      app: testCase.app,
      status: capture.metadata.status,
      privacyReason: capture.metadata.privacyReason ?? null,
      frameProduced: Boolean(capture.base64Jpeg),
      passed:
        capture.metadata.status === 'skipped'
        && capture.metadata.privacyReason === testCase.expectedRule
        && !capture.base64Jpeg,
    };
  } finally {
    if (capture?.outputPath) await fs.unlink(capture.outputPath).catch(() => {});
    await handle.close();
  }
}

async function main() {
  if (!serverUrl || !apiToken || !deviceToken) {
    throw new Error('LIFEOS_SERVER_URL, LIFEOS_API_TOKEN, and LIFEOS_DEVICE_TOKEN are required');
  }
  const parsedUrl = new URL(serverUrl);
  if (!allowProduction && !['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname)) {
    throw new Error('Real-app benchmark refuses non-local servers without LIFEOS_BENCHMARK_ALLOW_PRODUCTION=true');
  }

  const cases = makeCases();
  const privacyCases = makePrivacyCases();
  const requestedLimit = Number(process.env.LIFEOS_BENCHMARK_LIMIT ?? 0);
  const match = process.env.LIFEOS_BENCHMARK_MATCH;
  const matchedCases = match ? cases.filter((testCase) => testCase.id.includes(match)) : cases;
  const limitedCases = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? matchedCases.slice(0, requestedLimit)
    : matchedCases;
  const selectedCases = [...limitedCases].sort((left, right) => left.goal.localeCompare(right.goal));
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lifeos-real-app-fixtures-'));
  const results = [];
  const privacyResults = [];
  const startedAt = new Date().toISOString();
  let currentGoal = null;
  let sessionId = null;

  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  try {
    const fixturePaths = await writeFixtures(fixtureRoot, selectedCases);
    for (let index = 0; index < selectedCases.length; index++) {
      const testCase = selectedCases[index];
      if (currentGoal !== testCase.goal) {
        if (sessionId) await endSession(sessionId);
        const response = await startSession(testCase.goal);
        sessionId = response.session?.sessionId;
        if (!sessionId) throw new Error(`Guardian session did not start for ${testCase.goal}`);
        currentGoal = testCase.goal;
      }
      const result = await runCaptureCase(testCase, sessionId, fixturePaths);
      results.push(result);
      process.stdout.write(
        `[${String(index + 1).padStart(2, '0')}/${selectedCases.length}] `
        + `${testCase.id} (${result.capturedApp ?? 'none'}) -> `
        + `${result.predictedLabel} ${result.predictedAlignment ?? '-'}\n`,
      );
    }
    if (sessionId) {
      await endSession(sessionId);
      sessionId = null;
    }

    if (!requestedLimit) {
      for (const testCase of privacyCases) {
        const result = await runPrivacyCase(testCase);
        privacyResults.push(result);
        process.stdout.write(
          `[privacy] ${testCase.id} -> ${result.passed ? 'pass' : 'fail'} `
          + `${result.privacyReason ?? result.status}\n`,
        );
      }
    }
  } finally {
    if (sessionId) await endSession(sessionId).catch(() => {});
    await closeOwnedFileApps();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }

  const summary = scoreResults(results, []);
  summary.privacyDenial = {
    sampleCount: privacyResults.length,
    passed: privacyResults.filter((result) => result.passed).length,
    frameProduced: privacyResults.filter((result) => result.frameProduced).length,
    gate: privacyResults.length > 0 && privacyResults.every((result) => result.passed),
  };
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    environment: parsedUrl.hostname,
    rawFramesRetained: 0,
    fixtureFilesRetained: 0,
    summary,
    results,
    privacyResults,
  };
  await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`Result: ${resultPath}\n`);

  const gates = [
    summary.gates.categoryMacroF1,
    summary.gates.alignmentMae,
    summary.privacyDenial.gate,
  ];
  if (!requestedLimit && !gates.every(Boolean)) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  labels,
  makeCases,
  makePrivacyCases,
};
