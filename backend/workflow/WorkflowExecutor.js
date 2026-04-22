'use strict';

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { generateCode } = require('./workflowCodegen');

const RESULTS_MARKER = 'WORKFLOW_RESULTS:';

/* =========================================================================
   executeWorkflow(workflow, socket)

   1. Generates Puppeteer script into a temp file
   2. Runs `node <tempFile>` as a child process
   3. Streams log lines back through socket events
   4. Parses WORKFLOW_RESULTS: line and emits workflowComplete with data

   Socket events emitted:
     executionLog   { line: string, level: 'info'|'error' }
     executionDone  { success: boolean, results: object|null, error?: string }
 ========================================================================= */
async function executeWorkflow(workflow, socket) {
  const code    = generateCode(workflow);
  const tmpDir  = os.tmpdir();
  const tmpFile = path.join(tmpDir, `ws_workflow_${Date.now()}.js`);

  fs.writeFileSync(tmpFile, code, 'utf8');

  socket.emit('executionLog', { line: '▶ Starting workflow execution…', level: 'info' });
  socket.emit('executionLog', { line: `  Script: ${tmpFile}`, level: 'info' });

  return new Promise((resolve) => {
    const child = spawn('node', [tmpFile], {
      env: { ...process.env, NODE_PATH: path.join(__dirname, '../node_modules') },
      cwd: path.dirname(tmpFile),
    });

    let resultJson = null;
    let error      = null;
    let buffer     = '';

    const processLine = (line, isErr) => {
      if (line.startsWith(RESULTS_MARKER)) {
        try {
          resultJson = JSON.parse(line.slice(RESULTS_MARKER.length));
        } catch (e) {
          socket.emit('executionLog', { line: `⚠ Failed to parse results: ${e.message}`, level: 'error' });
        }
        return; // don't show the raw JSON line in the log
      }

      const level = isErr ? 'error' : 'info';
      if (line.trim()) {
        socket.emit('executionLog', { line, level });
      }
    };

    const handleData = (data, isErr) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep partial last line
      lines.forEach(l => processLine(l, isErr));
    };

    child.stdout.on('data', (d) => handleData(d, false));
    child.stderr.on('data', (d) => handleData(d, true));

    child.on('close', (code) => {
      // Flush buffer
      if (buffer.trim()) processLine(buffer, false);

      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch (_) {}

      const success = code === 0;

      if (success) {
        socket.emit('executionLog', { line: '✅ Workflow completed successfully', level: 'info' });
      } else {
        socket.emit('executionLog', { line: `❌ Workflow exited with code ${code}`, level: 'error' });
      }

      socket.emit('executionDone', {
        success,
        results: resultJson,
        exitCode: code,
      });

      resolve({ success, results: resultJson });
    });

    child.on('error', (err) => {
      socket.emit('executionLog', { line: `❌ Failed to start process: ${err.message}`, level: 'error' });
      socket.emit('executionDone', { success: false, results: null, error: err.message });
      resolve({ success: false, results: null });
    });

    // Allow frontend to kill the run mid-flight
    socket.once('cancelExecution', () => {
      child.kill('SIGTERM');
      socket.emit('executionLog', { line: '🛑 Execution cancelled', level: 'error' });
    });
  });
}

module.exports = { executeWorkflow };