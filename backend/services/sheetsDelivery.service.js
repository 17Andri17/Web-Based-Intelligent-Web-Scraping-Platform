'use strict';

/* ===========================================================================
   sheetsDelivery
   ---------------------------------------------------------------------------
   Ties Google Sheets delivery to a workflow's runs: after a successful run of
   a workflow that has sheet delivery enabled, append the chosen output list to
   the configured spreadsheet.

   Called fire-and-forget from executionPipeline right after a run is persisted
   (via safeCall), so it covers every trigger — interactive, scheduled, API —
   and can never fail or slow a run. The outcome (ok / an error string) is
   recorded on the config row for the UI, but never thrown.

   Which list is sent defaults the same way the dataset view / change monitor
   pick their primary output, so the three features agree.
   ========================================================================= */

const runStore = require('./runStore.service');
const dataset = require('./dataset.service');
const sheets = require('./googleSheets.service');

// Deliver a just-finished run to its configured Google Sheet.
//   runRow  : persisted run row ({ id, user_id, workflow_id, status, … })
//   results : the run's parsed results object
// Returns { ok, appended?, error? } or null when nothing was attempted.
async function deliverRun(runRow, results) {
  if (!runRow || runRow.status !== 'success') return null;
  if (!results || typeof results !== 'object') return null;

  const cfg = await runStore.getSheetByWorkflow(runRow.workflow_id);
  if (!cfg || !cfg.is_active || !cfg.spreadsheet_id) return null;

  if (!sheets.isConfigured()) {
    await runStore.updateSheetStatus(runRow.workflow_id,
      'Not sent — no Google service account configured on the server (set GOOGLE_SERVICE_ACCOUNT_JSON).');
    return { ok: false, error: 'service account not configured' };
  }

  // Which list to send: the configured output if it's a record-array in this
  // run, else the primary datasetable output.
  const outputs = dataset.listOutputs([{ results }]);
  if (outputs.length === 0) {
    await runStore.updateSheetStatus(runRow.workflow_id, 'Nothing to send — this run produced no list data.');
    return { ok: false, error: 'no datasetable output' };
  }
  const chosen = (cfg.output_key && outputs.find(o => o.key === cfg.output_key)) || outputs[0];

  try {
    const res = await sheets.appendResults(cfg.spreadsheet_id, cfg.sheet_name || 'Sheet1', results, { output: chosen.key });
    await runStore.updateSheetStatus(runRow.workflow_id,
      `OK — appended ${res.appended} row${res.appended === 1 ? '' : 's'} from "${chosen.key}"${res.wroteHeaders ? ' (with header row)' : ''}.`);
    return { ok: true, appended: res.appended };
  } catch (err) {
    await runStore.updateSheetStatus(runRow.workflow_id, `Failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { deliverRun };
