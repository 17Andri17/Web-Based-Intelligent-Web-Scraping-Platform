'use strict';

/* ===========================================================================
   changeMonitor
   ---------------------------------------------------------------------------
   Ties the run-to-run diff engine to a workflow's runs: after a successful run
   of a monitored workflow, diff it against the previous successful run, store
   the summary on the run row, and push a `run.changed` webhook when something
   actually changed.

   Called fire-and-forget from executionPipeline right after a run is persisted
   (via safeCall), so it covers every trigger — interactive, scheduled, and
   API — and can never fail or slow a run. Errors are swallowed here too, so a
   monitoring problem is always invisible to the run itself.

   Which list is watched and how rows are matched come from the workflow's
   monitor config (workflow_monitors); when unset they default the same way the
   dataset view does (primary list, identity-column key), so "changes" line up
   with what the user sees in the Data tab.
   ========================================================================= */

const runStore = require('./runStore.service');
const dataset = require('./dataset.service');
const changeDiff = require('./changeDiff.service');
const webhookDispatcher = require('./webhookDispatcher.service');
const emailNotifier     = require('./emailNotifier.service');

// Evaluate change monitoring for a just-finished run.
//   runRow  : the persisted run row ({ id, user_id, workflow_id, status, … })
//   results : the run's parsed results object (as persisted)
// Returns the stored summary, or null when nothing was evaluated.
async function evaluateRun(runRow, results) {
  if (!runRow || runRow.status !== 'success') return null;
  if (!results || typeof results !== 'object') return null;

  const monitor = await runStore.getMonitorByWorkflow(runRow.workflow_id);
  if (!monitor || !monitor.is_active) return null;

  // Which list to watch: the configured output if it's a record-array in this
  // run, else the primary datasetable output the run produced.
  const outputs = dataset.listOutputs([{ results }]);
  if (outputs.length === 0) return null;
  const chosen =
    (monitor.output_key && outputs.find(o => o.key === monitor.output_key)) || outputs[0];

  // How rows are matched. A configured key_field wins (null/'' = whole-row);
  // otherwise default from the output's columns like the dataset view does.
  // monitor.key_field === null means "unset" (auto), '' means explicit whole-row.
  const keyField = monitor.key_field != null
    ? (monitor.key_field === '' ? null : monitor.key_field)
    : dataset.defaultKeyField(chosen.fields, null);

  const previous = await runStore.previousSuccessfulRunWithResults(runRow.workflow_id, runRow.id);
  const diff = changeDiff.diffResults(previous ? previous.results : null, results, {
    output: chosen.key,
    keyField,
  });

  const summary = changeDiff.summarizeDiff(diff);
  summary.comparedToRunId = previous ? previous.id : null;
  // The first monitored run has no baseline to compare against — record it as a
  // baseline (every row is "new") but never fire an alert for it.
  summary.baseline = !previous;

  await runStore.saveChangeSummary(runRow.id, summary);

  if (!summary.baseline && diff.hasChanges) {
    // Fire-and-forget push; never let a delivery problem surface to the run.
    try { await webhookDispatcher.dispatchChangeEvent(runRow, summary); } catch (_) {}
    // Same alert by e-mail. Change monitoring was webhook-only, which put it
    // out of reach of the people it was built for.
    try { await emailNotifier.notifyRunChanged(runRow, summary); } catch (_) {}
  }

  return summary;
}

module.exports = { evaluateRun };
