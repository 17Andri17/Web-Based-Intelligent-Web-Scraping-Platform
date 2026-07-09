'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { generateCode } = require('../workflow/workflowCodegen');

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

function runChild(workflow, { signal } = {}) {
  const events = new EventEmitter();

  const code    = generateCode(workflow);
  const tmpDir  = os.tmpdir();
  const tmpFile = path.join(tmpDir, `ws_workflow_${Date.now()}_${Math.random().toString(36).slice(2,8)}.js`);
  fs.writeFileSync(tmpFile, code, 'utf8');

  const promise = new Promise((resolve) => {
    let child;
    try {
      child = spawn('node', [tmpFile], {
        env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') },
        cwd: path.dirname(tmpFile),
      });
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      resolve({ success: false, exitCode: -1, results: null, errorInfo: { message: err.message, step: null } });
      return;
    }

    let resultsObj = null;
    let errorInfo  = null;
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
      if (line.startsWith(ITER_START)) {
        try { events.emit('iteration', { kind: 'start', ...JSON.parse(line.slice(ITER_START.length)) }); } catch (_) {}
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
    if (signal) {
      const onAbort = () => {
        cancelled = true;
        try { child.kill('SIGTERM'); } catch (_) {}
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      events.emit('log', { line: `❌ Failed to start runner: ${err.message}`, level: 'error' });
      resolve({ success: false, exitCode: -1, results: null,
                errorInfo: errorInfo || { message: err.message, step: null },
                stepResults, stepSnapshots, captchaEvents });
    });

    child.on('close', (exitCode) => {
      if (buffer.trim()) handleLine(buffer, false);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
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
      resolve({ success, exitCode, results: resultsObj, errorInfo, stepResults, stepSnapshots, captchaEvents });
    });
  });

  return { events, promise };
}

module.exports = { runChild };
