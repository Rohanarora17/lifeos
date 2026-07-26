'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');

const execFileAsync = promisify(execFile);
const labels = [
  'active_creation',
  'active_learning',
  'passive_consumption',
  'idle',
  'distraction',
];

const serverUrl = process.env.LIFEOS_SERVER_URL;
const apiToken = process.env.LIFEOS_API_TOKEN;
const deviceToken = process.env.LIFEOS_DEVICE_TOKEN;
const copilotBin = process.env.LIFEOS_COPILOT_BIN
  || path.join(
    os.homedir(),
    'Library/Application Support/LifeOS/LifeOSCopilot.app/Contents/MacOS/LifeOSCopilot',
  );
const resultPath = process.env.LIFEOS_BENCHMARK_RESULT_PATH
  || path.join(process.cwd(), 'output/guardian-audit/vision-benchmark-results.json');

const topics = [
  'Polynomial commitments',
  'Range proofs',
  'Finite-field arithmetic',
  'Merkle membership proofs',
  'Fiat-Shamir transforms',
  'Constraint systems',
  'Trusted setup analysis',
  'Recursive proofs',
  'Lookup arguments',
  'Witness generation',
  'Proof aggregation',
  'Verifier optimization',
];

function makeCases() {
  return labels.flatMap((label) => topics.map((topic, index) => ({
    id: `${label}-${String(index + 1).padStart(2, '0')}`,
    label,
    topic,
    expectedAlignment: label === 'active_creation'
      ? 95
      : label === 'active_learning'
        ? 90
          : label === 'passive_consumption'
          ? 82
          : label === 'idle'
            ? 5
            : 5,
  })));
}

function fixtureBody(testCase) {
  const { id, label, topic } = testCase;
  if (label === 'active_creation') {
    return `
      <header><strong>Proof Lab</strong><span>Editing ${topic}</span><b>Unsaved</b></header>
      <main class="workspace">
        <aside><h3>Implementation notes</h3><p>Goal: study zero-knowledge proofs</p><p>Case ${id}</p></aside>
        <section class="editor"><div class="tabs">prover.ts &nbsp; notes.md</div><pre><code>// ${topic}
export function buildConstraint(witness: bigint) {
  const challenge = transcript.squeeze();
  assertFieldElement(challenge);
  return commit(witness, challenge);
}

// TODO: document soundness assumptions
// Cursor is active on line 8</code></pre><div class="terminal">✓ 24 proof tests passed &nbsp; | &nbsp; compiling changes...</div></section>
      </main>`;
  }
  if (label === 'active_learning') {
    return `
      <header><strong>ZK Course</strong><span>${topic}</span><b>Lesson ${id.slice(-2)}</b></header>
      <main class="learning">
        <section class="slide"><h1>${topic}</h1><div class="formula">C = g<sup>w</sup> h<sup>r</sup></div><p>Interactive exercise: derive why binding depends on the discrete logarithm assumption.</p><div class="progress"><i></i></div></section>
        <aside class="notes"><h2>My notes</h2><p>1. Write the commitment definition.</p><p>2. Compare hiding and binding.</p><p>3. Solve the practice proof.</p><textarea>Key insight: the verifier checks...</textarea></aside>
      </main>`;
  }
  if (label === 'passive_consumption') {
    return `
      <header><strong>Research Reader</strong><span>${topic}</span><b>Page ${18 + Number(id.slice(-2))}</b></header>
      <main class="paper"><article><p class="authors">Cryptography Research Group</p><h1>${topic}: foundations and current constructions</h1><p class="abstract"><b>Abstract.</b> This section surveys the core definitions used in modern zero-knowledge proof systems.</p><h2>3. Security definition</h2><p>A protocol is zero knowledge when a simulator can reproduce the verifier's view without access to the witness. The following theorem states the required indistinguishability condition.</p><p>The construction is complete for valid witnesses and computationally sound under the stated assumption.</p></article><aside><h3>Reading progress</h3><strong>${35 + Number(id.slice(-2))}%</strong><p>No editor or notes are open.</p></aside></main>`;
  }
  if (label === 'idle') {
    return `
      <main class="idle-screen"><div class="idle-card"><span>COMPUTER IDLE</span><h1>No active work is visible</h1><div class="clock">${String(10 + Number(id.slice(-2))).padStart(2, '0')}:00</div><p>No keyboard or pointer activity detected. The focus session is paused.</p><button>Resume session</button><small>Case ${id}</small></div></main>`;
  }
  return `
    <header><strong>Daily Buzz</strong><span>Entertainment feed</span><b>${id}</b></header>
    <main class="feed">
      <section><div class="hero"><span>TRENDING NOW</span><h1>${[
        'Celebrity reactions',
        'Weekend travel deals',
        'Championship highlights',
        'Viral comedy clips',
      ][Number(id.slice(-2)) % 4]}</h1><p>Watch the latest unrelated stories and highlights.</p><button>Play next video</button></div>
      <div class="posts"><article>Top memes of the day</article><article>Flash sale ends tonight</article><article>Recommended short videos</article></div></section>
      <aside><h2>Trending</h2><p>#Entertainment</p><p>#Shopping</p><p>#Sports</p><p>This content is unrelated to zero-knowledge proofs.</p></aside>
    </main>`;
}

function renderFixture(testCase) {
  const title = `BENCH-${testCase.id}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;color:#17202a;background:#f4f6f8}
body{overflow:hidden}header{height:68px;background:#17202a;color:white;display:flex;align-items:center;gap:28px;padding:0 34px}
header strong{font-size:22px}header span{flex:1;color:#d5d8dc}header b{background:#f4d03f;color:#17202a;padding:8px 12px;border-radius:4px}
main{height:calc(100vh - 68px)}.workspace,.learning,.paper,.feed{display:grid;grid-template-columns:260px 1fr;gap:0}
.workspace aside,.feed aside{padding:28px;background:#e8edf2;border-right:1px solid #ccd4dc}.workspace .editor{background:#1e272e;color:#ecf0f1;padding:0}
.tabs{height:46px;padding:14px 22px;background:#2f3640}.editor pre{font:18px/1.65 Menlo,monospace;padding:28px;white-space:pre-wrap}
.terminal{position:absolute;left:260px;right:0;bottom:0;background:#111820;padding:18px 28px;color:#58d68d}
.learning{grid-template-columns:1.5fr 1fr}.slide{padding:60px;background:white}.slide h1,.paper h1{font-size:38px;max-width:760px}
.formula{font:42px Georgia,serif;margin:50px 0;padding:35px;background:#eaf2f8;border-left:6px solid #2471a3}
.progress{height:10px;background:#d5d8dc;margin-top:60px}.progress i{display:block;width:58%;height:100%;background:#1e8449}
.notes{padding:38px;background:#fff8dc;border-left:1px solid #d4ac0d}.notes textarea{width:100%;height:220px;padding:14px;font-size:17px}
.paper{grid-template-columns:1fr 280px;background:#fff}.paper article{padding:42px 9%;font:20px/1.7 Georgia,serif}.paper aside{padding:38px;background:#edf2f7}.authors{color:#566573}
.idle-screen{display:grid;place-items:center;background:#111820;color:white}.idle-card{text-align:center;width:620px;padding:48px;border:1px solid #566573}
.idle-card span{color:#f4d03f}.idle-card .clock{font:76px Menlo,monospace;margin:34px}.idle-card button{padding:14px 28px}
.feed{grid-template-columns:1fr 300px;background:#fff}.feed section{padding:34px}.hero{padding:42px;background:#922b21;color:white}.hero h1{font-size:48px}
.hero button{padding:14px 22px}.posts{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:22px}.posts article{padding:28px;background:#f2f3f4}
.feed aside{border-left:1px solid #ccd4dc;border-right:0}small{display:block;margin-top:28px;color:#85929e}
</style></head><body>${fixtureBody(testCase)}</body></html>`;
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function startSession() {
  return jsonFetch(`${serverUrl}/api/guardian/session/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topic: 'Study zero-knowledge proofs',
      goalTitle: 'Study zero-knowledge proofs and write implementation notes',
      durationMinutes: 45,
      source: 'api',
      sessionContext: 'Controlled 60-frame synthetic vision benchmark. Exclude from personalization.',
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

async function captureFrontmost(testCase) {
  const outputPath = path.join(os.tmpdir(), `lifeos-benchmark-${process.pid}-${testCase.id}.jpg`);
  try {
    const { stdout } = await execFileAsync(copilotBin, ['--capture-once', outputPath], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    const metadata = JSON.parse(stdout.trim());
    if (metadata.status !== 'captured') return { metadata, outputPath, base64Jpeg: null };
    const base64Jpeg = (await fs.readFile(outputPath)).toString('base64');
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

function scoreResults(results, staticResults) {
  const scored = results.filter((result) => labels.includes(result.expectedLabel));
  const perLabel = {};
  for (const label of labels) {
    const tp = scored.filter((r) => r.expectedLabel === label && r.predictedLabel === label).length;
    const fp = scored.filter((r) => r.expectedLabel !== label && r.predictedLabel === label).length;
    const fn = scored.filter((r) => r.expectedLabel === label && r.predictedLabel !== label).length;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perLabel[label] = { tp, fp, fn, precision, recall, f1 };
  }
  const macroF1 = labels.reduce((sum, label) => sum + perLabel[label].f1, 0) / labels.length;
  const alignmentPairs = scored.filter((r) => Number.isFinite(r.predictedAlignment));
  const alignmentMae = alignmentPairs.length === 0
    ? null
    : alignmentPairs.reduce(
      (sum, result) => sum + Math.abs(result.expectedAlignment - result.predictedAlignment),
      0,
    ) / alignmentPairs.length;
  const captureFailures = results.filter((result) => result.captureStatus !== 'captured').length;
  const titleMismatches = results.filter((result) => !result.titleMatched).length;
  const invalidAssessments = results.filter((result) => result.analysisReason === 'invalid_assessment').length;
  const staticActiveCreation = staticResults.filter(
    (result) => result.predictedLabel === 'active_creation',
  ).length;

  return {
    sampleCount: scored.length,
    staticRepeatCount: staticResults.length,
    macroF1,
    alignmentMae,
    perLabel,
    captureFailures,
    titleMismatches,
    invalidAssessments,
    staticActiveCreation,
    gates: {
      categoryMacroF1: macroF1 >= 0.85,
      alignmentMae: alignmentMae !== null && alignmentMae <= 10,
      privacy: captureFailures === 0 && titleMismatches === 0,
      staticHandling: staticActiveCreation === 0,
    },
  };
}

async function main() {
  if (!serverUrl || !apiToken || !deviceToken) {
    throw new Error('LIFEOS_SERVER_URL, LIFEOS_API_TOKEN, and LIFEOS_DEVICE_TOKEN are required');
  }
  const requestedLimit = Number(process.env.LIFEOS_BENCHMARK_LIMIT ?? 0);
  const allCases = makeCases();
  const cases = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? allCases.slice(0, requestedLimit)
    : allCases;
  const results = [];
  const staticResults = [];
  const startedAt = new Date().toISOString();
  let sessionId = null;
  let browser = null;

  await fs.mkdir(path.dirname(resultPath), { recursive: true });

  try {
    const sessionResponse = await startSession();
    sessionId = sessionResponse.session?.sessionId;
    if (!sessionId) throw new Error('Benchmark Guardian session did not start');

    browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      args: ['--window-size=1440,1000', '--disable-notifications'],
    });
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const page = await context.newPage();

    for (let index = 0; index < cases.length; index++) {
      const testCase = cases[index];
      await page.setContent(renderFixture(testCase), { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      await page.evaluate(() => window.focus());
      await page.waitForTimeout(450);

      const capture = await captureFrontmost(testCase);
      let analysis = null;
      try {
        if (capture.base64Jpeg) {
          analysis = await uploadCapture(sessionId, capture);
        }
      } finally {
        await fs.unlink(capture.outputPath).catch(() => {});
      }

      const result = {
        id: testCase.id,
        expectedLabel: testCase.label,
        expectedAlignment: testCase.expectedAlignment,
        predictedLabel: analysis?.signal?.engagementDepth ?? 'unknown',
        predictedAlignment: analysis?.signal?.taskAlignment ?? null,
        confidence: analysis?.signal?.confidence ?? null,
        analyzed: analysis?.analyzed === true,
        analysisReason: analysis?.reason ?? null,
        captureStatus: capture.metadata.status,
        capturedApp: capture.metadata.app ?? null,
        titleMatched: String(capture.metadata.title ?? '').includes(`BENCH-${testCase.id}`),
      };
      results.push(result);
      process.stdout.write(
        `[${String(index + 1).padStart(2, '0')}/${cases.length}] ${testCase.id} -> ${result.predictedLabel} ${result.predictedAlignment ?? '-'}\n`,
      );

      if (testCase.label === 'active_creation') {
        await page.bringToFront();
        await page.waitForTimeout(250);
        const staticCapture = await captureFrontmost({ ...testCase, id: `${testCase.id}-static` });
        let staticAnalysis = null;
        try {
          if (staticCapture.base64Jpeg) {
            staticAnalysis = await uploadCapture(sessionId, staticCapture);
          }
        } finally {
          await fs.unlink(staticCapture.outputPath).catch(() => {});
        }
        staticResults.push({
          sourceId: testCase.id,
          analyzed: staticAnalysis?.analyzed === true,
          analysisReason: staticAnalysis?.reason ?? null,
          predictedLabel: staticAnalysis?.signal?.engagementDepth ?? 'unknown',
          captureStatus: staticCapture.metadata.status,
        });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (sessionId) await endSession(sessionId).catch(() => {});
  }

  const summary = scoreResults(results, staticResults);
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    sessionId,
    goal: 'Study zero-knowledge proofs and write implementation notes',
    modelTarget: 'gemini-3.1-pro-preview through production fallback routing',
    rawFramesRetained: 0,
    summary,
    results,
    staticResults,
  };
  await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`Result: ${resultPath}\n`);

  if (!Object.values(summary.gates).every(Boolean)) process.exitCode = 2;
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
  renderFixture,
  scoreResults,
};
