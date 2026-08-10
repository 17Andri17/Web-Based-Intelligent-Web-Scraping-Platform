'use strict';

/* ===========================================================================
   workflowImport
   ---------------------------------------------------------------------------
   Turns a portable export envelope into a workflow in someone's account.

   Two callers share this: uploading an exported .json file, and starting from
   a gallery template. A template IS an envelope, so giving them separate code
   would mean two ways to create a workflow that could drift apart — and the
   custom-action remapping is exactly the kind of thing you only want written
   once.
   ========================================================================= */

const workflows = require('../db/repositories/workflows.repo');
const customActionsRepo = require('../db/repositories/customActions.repo');
const portable = require('../utils/workflowPortable');
const { collectSubflowIds } = require('../workflow/workflowUtils');

const MAX_NAME_LEN = 120;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB cap per workflow

/**
 * Validate an envelope and create the workflow it describes.
 *
 * @param {object} env        a portable export envelope
 * @param {number} userId     account to create it in
 * @param {string} [targetName]  explicit name; otherwise the envelope's own
 *                               name (with `suffix` appended)
 * @param {string} [suffix]   appended when no targetName is given — " (imported)"
 *                            for a file upload, nothing for a template
 * @returns {Promise<{ok:true, workflow, createdCustomActions, unresolvedCustomActionRefs, subflowRefs}
 *                  | {ok:false, status:number, error:string}>}
 */
async function createFromEnvelope({ env, userId, targetName, suffix = '' }) {
  const v = portable.validateEnvelope(env);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  if (Buffer.byteLength(JSON.stringify(env.steps), 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 400, error: 'Workflow is too large to import.' };
  }

  const existing = await customActionsRepo.listForUser(userId);
  const byName = new Map(existing.map(a => [a.name, a]));
  const createAction = (def) => customActionsRepo.create({
    userId,
    name: def.name,
    description: def.description || '',
    inputsJson: JSON.stringify(Array.isArray(def.inputs) ? def.inputs : []),
    outputsJson: JSON.stringify(Array.isArray(def.outputs) ? def.outputs : []),
    code: def.code || '',
  });

  const { steps, created, missing } =
    await portable.remapCustomActions(env.steps, env.customActions, byName, createAction);

  // stripMetaForExport also guards the INBOUND direction: an envelope that
  // carries a proxy binding from another account must not import it.
  const meta = portable.stripMetaForExport(env.meta || {});

  const name = ((targetName && String(targetName).trim())
    || `${env.name || 'Imported workflow'}${suffix}`).slice(0, MAX_NAME_LEN);

  const wf = await workflows.create({
    userId,
    name,
    stepsJson: JSON.stringify(steps),
    metaJson: JSON.stringify(meta),
  });

  return {
    ok: true,
    workflow: { id: wf.id, name: wf.name },
    createdCustomActions: created,
    unresolvedCustomActionRefs: missing.length,
    // Subflow references only resolve inside the account they came from; the
    // UI surfaces this as a note rather than failing the import.
    subflowRefs: collectSubflowIds(steps).length,
  };
}

module.exports = { createFromEnvelope, MAX_NAME_LEN, MAX_PAYLOAD_BYTES };
