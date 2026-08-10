'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { generateCode } = require('../workflow/workflowCodegen');

// Where SAVE_DATA writes relative destinations (see workflowCodegen's
// SAVE_DATA case). Kept under backend/data so it sits beside the SQLite file
// and is easy to find. Created on boot.
const EXPORT_DIR = process.env.WS_EXPORT_DIR
  || path.join(__dirname, '..', 'data', 'exports');
try { fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch (_) {}

// Global cap on concurrently-running generated scripts (each spawns its own
// headless Chrome). Without this, the scheduler (concurrency 3) and the API
// worker (concurrency 2) could launch 5 Chromes at once and thrash a laptop.
// A tiny FIFO semaphore; 0/negative disables the cap.
const MAX_CONCURRENT_RUNS = (() => {
  const n = Number(process.env.WS_MAX_CONCURRENT_RUNS);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();
let activeRuns = 0;
const runWaiters = [];
function acquireRunSlot() {
  if (activeRuns < MAX_CONCURRENT_RUNS) { activeRuns++; return Promise.resolve(); }
  return new Promise((resolve) => runWaiters.push(resolve));
}
function releaseRunSlot() {
  const next = runWaiters.shift();
  if (next) next();          // hand the slot straight to the next waiter
  else activeRuns = Math.max(0, activeRuns - 1);
}

// Remove stale generated scripts left behind by a previous crash (they're
// normally unlinked on child exit). Runs once at startup; best-effort.
function cleanupTempScripts() {
  try {
    const dir = os.tmpdir();
    for (const f of fs.readdirSync(dir)) {
      if (/^ws_workflow_\d+_[a-z0-9]+\.js$/.test(f) || /^ws_resume_\d+_[a-z0-9]+\.json$/.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}
cleanupTempScripts();

const RESULTS_MARKER = 'WORKFLOW_RESULTS:';
const STEP_BEGIN     = 'STEP_BEGIN:';
const STEP_ERROR     = 'STEP_ERROR:';
const ITER_START     = 'ITER_START:';
const ITER_TICK      = 'ITER_TICK:';
const ITER_END       = 'ITER_END:';
const STEP_RESULT    = 'STEP_RESULT:';    // per-extraction record-count / field-fill stats
const STEP_SNAPSHOT  = 'STEP_SNAPSHOT:';  // page HTML captured when a step looks broken
const COLLECT_SUMMARY = 'COLLECT_SUMMARY:'; // Collect-List completeness (human line logged separately)
const CAPTCHA_MARKER = 'CAPTCHA_DETECTED:'; // a captcha was seen but not solved (auto-handle continued)
const ITER_WORKERS   = 'ITER_WORKERS:';  // which item each parallel worker is on
const RESULT_CHUNK   = 'RESULT_CHUNK:';   // incremental results delta (durable partial results)

// How long the child gets to flush its tail after SIGTERM before we SIGKILL it.
// Its SIGTERM handler emits one final RESULT_CHUNK and exits, so this only has
// to cover a single write — but a wedged Chrome shouldn't hold a cancel open.
const CANCEL_GRACE_MS = 5000;

/**
 * Apply one RESULT_CHUNK delta to the accumulating results object.
 *
 * The child sends deltas rather than snapshots (re-serialising the whole result
 * set every iteration would be O(n²) stdout on a long run), so the parent
 * reassembles them here:
 *   { key: { append: [...] } }  → push onto the existing array
 *   { key: { set: value } }     → replace wholesale (scalars, or an array the
 *                                 child reset because its step re-ran)
 * Exported for tests, which round-trip child emission against this reassembly.
 */
function applyResultDelta(target, delta) {
  if (!delta || typeof delta !== 'object') return target;
  for (const [key, d] of Object.entries(delta)) {
    if (!d || typeof d !== 'object') continue;
    if (Array.isArray(d.append)) {
      if (!Array.isArray(target[key])) target[key] = [];
      target[key].push(...d.append);
    } else if ('set' in d) {
      target[key] = d.set;
    }
  }
  return target;
}

/**
 * Apply one RESULT_CHUNK to the parent's accumulators.
 *
 * The chunk carries the row delta AND the completion ledger together, because
 * they have to be applied together: an item is only "done" once the rows it
 * produced are held out here. Splitting them (as an independent ITER_DONE
 * marker did) meant a run could be recorded as having finished items whose
 * data never left the child, and a resume would then skip them for good.
 */
function applyResultChunk(chunk, { results, itemsByStep, doneSteps, times }) {
  if (!chunk || typeof chunk !== 'object') return;
  if (chunk.rows) applyResultDelta(results, chunk.rows);
  // Timings arrive whole, not as a delta — the child's map is authoritative.
  if (times && chunk.times && typeof chunk.times === 'object') {
    for (const [stepId, t] of Object.entries(chunk.times)) {
      if (t && typeof t === 'object') times[stepId] = { n: t.n || 0, ms: t.ms || 0 };
    }
  }
  if (chunk.doneItems && typeof chunk.doneItems === 'object') {
    for (const [stepId, urls] of Object.entries(chunk.doneItems)) {
      if (!Array.isArray(urls) || !urls.length) continue;
      let set = itemsByStep.get(stepId);
      if (!set) { set = new Set(); itemsByStep.set(stepId, set); }
      for (const u of urls) set.add(String(u));
    }
  }
  if (Array.isArray(chunk.doneSteps)) {
    for (const stepId of chunk.doneSteps) doneSteps.add(String(stepId));
  }
}

// The ledger shape stored in runs.progress_json and handed back to a resumed
// run: which items each loop finished, and which whole steps finished.
function serialiseProgress(progressByStep, outKeyByStep, doneStepIds) {
  const steps = {};
  for (const [stepId, urls] of progressByStep) {
    if (!urls || !urls.size) continue;
    steps[stepId] = { urls: Array.from(urls) };
    const key = outKeyByStep && outKeyByStep.get(stepId);
    if (key) steps[stepId].outKey = key;
  }
  const done = doneStepIds && doneStepIds.size ? Array.from(doneStepIds) : null;
  if (!Object.keys(steps).length && !done) return null;
  return done ? { steps, doneSteps: done } : { steps };
}

// Rows captured so far, for cheap progress display. Arrays count their length;
// a non-null scalar counts as one.
function countResultRows(results) {
  let n = 0;
  for (const v of Object.values(results || {})) {
    if (Array.isArray(v)) n += v.length;
    else if (v !== null && v !== undefined) n += 1;
  }
  return n;
}

/* ===========================================================================
   runner.service
   ---------------------------------------------------------------------------
   Spawns the generated Puppeteer script as a child process, parses its
   stdout / stderr line-by-line, and surfaces structured events:

     events.on('log',       ({ line, level }))
     events.on('stepBegin', ({ id, type, label, kind }))
     events.on('stepError', ({ step, message, stack, url, html }))
     events.on('results',   (resultObject))

   `runChild(workflow)` returns { events, promise }. The promise resolves
   with { success, exitCode, results, errorInfo }, where errorInfo is
   populated whenever a STEP_ERROR line was emitted (whether the process
   then exited cleanly or not — the codegen always sets exitCode = 1 after
   STEP_ERROR, so success === false in that case).
   ========================================================================= */

function runChild(workflow, { signal, resume = null } = {}) {
  const events = new EventEmitter();

  const code    = generateCode(workflow);
  const tmpDir  = os.tmpdir();
  const stamp   = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const tmpFile = path.join(tmpDir, `ws_workflow_${stamp}.js`);
  fs.writeFileSync(tmpFile, code, 'utf8');

  // Resume payload goes to a sidecar file rather than being embedded in the
  // script: it carries every already-captured URL plus the rows to restore,
  // which on a large job is megabytes — far too much to inline. Deleted with
  // the script on exit.
  let resumeFile = null;
  // Written for a resume (per-step ledgers) OR a shard (a slice assignment with
  // no ledger yet) — a shard's `steps` is empty, so keying only off that would
  // silently drop the shard assignment and every shard would scrape everything.
  const hasResumeState = !!(resume && (
    (resume.steps && Object.keys(resume.steps).length) ||
    (resume.doneSteps && Object.keys(resume.doneSteps).length) ||
    (resume.shard && resume.shard.count > 1)
  ));
  if (hasResumeState) {
    try {
      resumeFile = path.join(tmpDir, `ws_resume_${stamp}.json`);
      fs.writeFileSync(resumeFile, JSON.stringify(resume), 'utf8');
    } catch (_) { resumeFile = null; }
  }

  // Both temp files are removed on every exit path. Best-effort: a leftover is
  // swept by cleanupTempScripts on the next boot.
  const cleanupTempFiles = () => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    if (resumeFile) { try { fs.unlinkSync(resumeFile); } catch (_) {} }
  };

  const promise = (async () => {
    // Wait for a global run slot before launching Chrome, so concurrent
    // scheduled/API runs can't exceed MAX_CONCURRENT_RUNS. Released on child
    // exit / error below. The events emitter is already returned to the
    // caller, so listeners are attached before any output can arrive.
    await acquireRunSlot();
    let slotReleased = false;
    const releaseOnce = () => { if (!slotReleased) { slotReleased = true; releaseRunSlot(); } };

    return await new Promise((resolve) => {
    let child;
    try {
      child = spawn('node', [tmpFile], {
        env: {
          ...process.env,
          NODE_PATH: path.join(__dirname, '..', 'node_modules'),
          WS_EXPORT_DIR: EXPORT_DIR,
          ...(resumeFile ? { WS_RESUME_FILE: resumeFile } : {}),
        },
        cwd: path.dirname(tmpFile),
      });
    } catch (err) {
      cleanupTempFiles();
      releaseOnce();
      resolve({ success: false, exitCode: -1, results: null, errorInfo: { message: err.message, step: null } });
      return;
    }

    let resultsObj = null;
    let errorInfo  = null;
    // Durable partial results: rebuilt here, in the PARENT, from the child's
    // RESULT_CHUNK deltas. Because the data lives out here well before the
    // child ends, it survives a crash, a timeout, an OOM, or a SIGKILL — all
    // of which previously destroyed the entire run's output.
    const partialResults = {};
    let partialRows = 0;
    let sawAnyChunk = false;
    // Resume ledger: stepId → Set of item URLs this run actually finished.
    // Kept as Sets while running (membership is the only query) and converted
    // to arrays when handed on.
    const progressByStep = new Map();
    // Whole top-level steps the child reported finished (with their outputs
    // saved). Lets a resume skip re-running the prefix that already succeeded.
    const doneStepIds = new Set();
    // stepId → { n, ms }: how many times a step ran and the total time in it.
    const stepTimes = Object.create(null);
    const outKeyByStep = new Map();   // stepId → result key the loop writes into
    const stepResults   = [];   // [{ stepId, type, label, key, count, fields, multiple }]
    const stepSnapshots = {};   // stepId → { url, html }
    const captchaEvents = [];   // [{ type, sitekey, provider, url, reason }] — seen-but-not-solved
    let buffer     = '';
    // Keep the tail of stderr lines so that when the child exits non-zero
    // WITHOUT emitting a structured STEP_ERROR (e.g. a SyntaxError that
    // crashes the script before any STEP_BEGIN fires), we can still
    // surface a useful message instead of "exited with code 1".
    const stderrTail = [];
    const STDERR_TAIL_MAX = 30;

    const handleLine = (line, isErr) => {
      if (!line) return;
      // Structured markers — never emitted as logs
      if (line.startsWith(STEP_BEGIN)) {
        try { events.emit('stepBegin', JSON.parse(line.slice(STEP_BEGIN.length))); } catch (_) {}
        return;
      }
      if (line.startsWith(STEP_ERROR)) {
        try { errorInfo = JSON.parse(line.slice(STEP_ERROR.length)); } catch (_) {
          errorInfo = { message: line.slice(STEP_ERROR.length) };
        }
        events.emit('stepError', errorInfo);
        return;
      }
      // Loop iteration markers — power the live "Flow" tab's
      // "N/M iterations" progress for FOR_EACH / FOR_EACH_ELEMENTS /
      // RUN_SUBFLOW iterate mode. Same opt-in shape as STEP_BEGIN.
      if (line.startsWith(ITER_WORKERS)) {
        try { events.emit('workers', JSON.parse(line.slice(ITER_WORKERS.length))); } catch (_) {}
        return;
      }
      if (line.startsWith(ITER_START)) {
        try {
          const info = JSON.parse(line.slice(ITER_START.length));
          // A per-item loop announces which result key it writes into, once,
          // here. Resume needs it to know which rows to restore — inferring it
          // later from the result shape would be guesswork.
          if (info && info.stepId && info.outKey) outKeyByStep.set(info.stepId, info.outKey);
          events.emit('iteration', { kind: 'start', ...info });
        } catch (_) {}
        return;
      }
      if (line.startsWith(ITER_TICK)) {
        try { events.emit('iteration', { kind: 'tick', ...JSON.parse(line.slice(ITER_TICK.length)) }); } catch (_) {}
        return;
      }
      if (line.startsWith(ITER_END)) {
        try { events.emit('iteration', { kind: 'end', ...JSON.parse(line.slice(ITER_END.length)) }); } catch (_) {}
        return;
      }
      if (line.startsWith(RESULTS_MARKER)) {
        try {
          resultsObj = JSON.parse(line.slice(RESULTS_MARKER.length));
          events.emit('results', resultsObj);
        } catch (_) {}
        return;
      }
      // Incremental results delta — never logged, never surfaced as output.
      // Powers the mid-run checkpoint the pipeline persists.
      if (line.startsWith(RESULT_CHUNK)) {
        try {
          applyResultChunk(JSON.parse(line.slice(RESULT_CHUNK.length)), {
            results: partialResults,
            itemsByStep: progressByStep,
            doneSteps: doneStepIds,
            times: stepTimes,
          });
          partialRows = countResultRows(partialResults);
          sawAnyChunk = true;
          events.emit('partial', {
            results: partialResults,
            rows: partialRows,
            // Already serialised: the caller persists this verbatim and has no
            // business knowing the internal Map/Set shape. Chunks are throttled
            // to ~1.5s apart, so rebuilding it here is not a hot path.
            progress: serialiseProgress(progressByStep, outKeyByStep, doneStepIds),
            times: stepTimes,
          });
        } catch (_) {}
        return;
      }
      // Extraction stats / snapshots — structured, never logged. These power
      // empty-result detection + self-healing in the execution pipeline.
      if (line.startsWith(STEP_RESULT)) {
        try { stepResults.push(JSON.parse(line.slice(STEP_RESULT.length))); } catch (_) {}
        return;
      }
      if (line.startsWith(STEP_SNAPSHOT)) {
        try {
          const s = JSON.parse(line.slice(STEP_SNAPSHOT.length));
          if (s && s.stepId) stepSnapshots[s.stepId] = { url: s.url || null, html: s.html || null };
        } catch (_) {}
        return;
      }
      // Collect-List completeness marker — machine twin of the human "✓/⚠
      // Collect List" line, which is logged separately. Suppress the raw JSON.
      if (line.startsWith(COLLECT_SUMMARY)) return;
      // A captcha was detected but left unsolved (auto-handle continued rather
      // than failing). Surface it as a friendly warning + a structured event
      // so the run can be flagged/inspected — but don't fail the run over it.
      if (line.startsWith(CAPTCHA_MARKER)) {
        let info = null;
        try { info = JSON.parse(line.slice(CAPTCHA_MARKER.length)); } catch (_) { info = { raw: line.slice(CAPTCHA_MARKER.length) }; }
        captchaEvents.push(info);
        events.emit('captcha', info);
        events.emit('log', { line: `🧩 CAPTCHA detected (${info.type || 'unknown'})${info.reason ? ' — ' + info.reason : ''}`, level: 'error' });
        return;
      }
      const level = isErr ? 'error' : 'info';
      if (line.trim()) {
        if (isErr) {
          stderrTail.push(line);
          if (stderrTail.length > STDERR_TAIL_MAX) stderrTail.shift();
        }
        events.emit('log', { line, level });
      }
    };

    const handleData = (data, isErr) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const l of lines) handleLine(l, isErr);
    };

    child.stdout.on('data', (d) => handleData(d, false));
    child.stderr.on('data', (d) => handleData(d, true));

    let cancelled = false;
    let killTimer = null;
    if (signal) {
      const onAbort = () => {
        cancelled = true;
        // SIGTERM first so the child's handler can flush its tail (one last
        // RESULT_CHUNK) — a cancel shouldn't throw away what was already
        // scraped. Escalate to SIGKILL if it doesn't go quietly.
        try { child.kill('SIGTERM'); } catch (_) {}
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, CANCEL_GRACE_MS);
        if (killTimer.unref) killTimer.unref();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      cleanupTempFiles();
      if (killTimer) clearTimeout(killTimer);
      releaseOnce();
      events.emit('log', { line: `❌ Failed to start runner: ${err.message}`, level: 'error' });
      resolve({ success: false, exitCode: -1, results: null,
                errorInfo: errorInfo || { message: err.message, step: null },
                stepResults, stepSnapshots, captchaEvents,
                partialResults, partialRows, sawAnyChunk,
                progress: serialiseProgress(progressByStep, outKeyByStep, doneStepIds), stepTimes });
    });

    child.on('close', (exitCode) => {
      if (buffer.trim()) handleLine(buffer, false);
      cleanupTempFiles();
      if (killTimer) clearTimeout(killTimer);
      releaseOnce();
      const success = exitCode === 0 && !errorInfo;
      if (cancelled && !errorInfo) {
        errorInfo = { message: 'Run cancelled by user', step: null, cancelled: true };
      }
      // Non-zero exit with no STEP_ERROR usually means the generated
      // script failed BEFORE any step ran (e.g. a SyntaxError in the
      // emitted code). Synthesise an errorInfo from the stderr tail so
      // the user sees the actual JS error instead of "exited with N".
      if (!success && !errorInfo && stderrTail.length > 0) {
        // Best-effort headline: the first stderr line that looks like a
        // typed Error (SyntaxError / TypeError / ReferenceError / …).
        const errLine = stderrTail.find(l => /^[A-Z][A-Za-z]*Error:/.test(l))
                     || stderrTail[stderrTail.length - 1];
        errorInfo = {
          message: errLine,
          step: null,
          stack: stderrTail.slice(-12).join('\n'),
          preExecution: true,
        };
      }
      resolve({ success, exitCode, results: resultsObj, errorInfo, stepResults, stepSnapshots, captchaEvents,
                partialResults, partialRows, sawAnyChunk,
                progress: serialiseProgress(progressByStep, outKeyByStep, doneStepIds), stepTimes });
    });
    });
  })();

  return { events, promise };
}

module.exports = {
  runChild, applyResultDelta, applyResultChunk, countResultRows, serialiseProgress,
};
