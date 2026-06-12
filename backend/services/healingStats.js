'use strict';

/* ===========================================================================
   healingStats
   ---------------------------------------------------------------------------
   Pure, deterministic logic for deciding whether an extraction step "looks
   broken" from its runtime record counts — the signal the self-healing
   pipeline uses INSTEAD of relying on an exception being thrown. A list step
   that matches nothing returns [] and the run otherwise succeeds, so without
   this the failure is silent (0 records recorded, but reported as success).

   A "step stat" is produced by the generated script (see workflowCodegen's
   STEP_RESULT marker) and has the shape:

     {
       stepId:  string,
       type:    'EXTRACT_LIST' | 'FOR_EACH_ELEMENTS' | 'EXTRACT_TEXT' | …,
       label:   string,
       key:     string,        // results-object key (for history baselines)
       count:   number,        // records: array length, or 0/1 for scalars
       multiple:boolean,
       fields:  { [name]: { nonEmpty: number, total: number } },
     }

   No DOM, no I/O — everything here is a pure function so it is unit-testable
   and produces identical verdicts in the codegen runtime and in the pipeline.
   ========================================================================= */

const THRESHOLDS = {
  // A list/multiple step with this many records (or fewer) is "suspicious"
  // and worth capturing a page snapshot for. count === 0 is always broken;
  // count === 1 is only escalated to broken when history proves there used
  // to be clearly more (see MIN_BASELINE_FOR_LOW).
  SUSPICIOUS_AT_OR_BELOW: 1,
  // How many records a previous successful run must have produced before we
  // treat a drop to ≤1 as a genuine breakage rather than a legitimately
  // short list. Keeps single-item pages from constantly self-healing.
  MIN_BASELINE_FOR_LOW: 3,
};

// Extraction step types that yield a *collection* of records (so count and
// per-field fill rates are meaningful). Everything else is a scalar single
// value where the only question is "did we get anything at all?".
const COLLECTION_TYPES = new Set(['EXTRACT_LIST', 'FOR_EACH_ELEMENTS', 'EXTRACT_TABLE']);

function isCollectionType(type) {
  return COLLECTION_TYPES.has(type);
}

// Fields that are entirely empty across EVERY record (nonEmpty === 0 while
// total > 0). An always-empty field means its per-item selector stopped
// matching — the "captures the row but none of the values" failure mode.
function emptyFieldsOf(stat) {
  const out = [];
  const fields = (stat && stat.fields) || {};
  for (const [name, fs] of Object.entries(fields)) {
    if (!fs || typeof fs !== 'object') continue;
    if ((fs.total || 0) > 0 && (fs.nonEmpty || 0) === 0) out.push(name);
  }
  return out;
}

// Runtime-only predicate (mirrored inline in the generated script): is this
// stat worth attaching a page snapshot to? We snapshot anything that could be
// broken so the pipeline always has the HTML it needs to attempt a repair —
// without the cost of snapshotting healthy steps. A single SCALAR extraction
// is only suspicious at count 0 (count 1 is its healthy state); a COLLECTION
// is suspicious at ≤1 record or when a field is empty in every record.
function isSuspicious(stat, isCollection = true) {
  if (!stat) return false;
  const count = Number(stat.count) || 0;
  if (isCollection ? count <= THRESHOLDS.SUSPICIOUS_AT_OR_BELOW : count === 0) return true;
  return emptyFieldsOf(stat).length > 0;
}

/**
 * Decide whether a step is broken, using its runtime stat plus an optional
 * historical baseline (the typical record count from prior successful runs).
 *
 * @returns {{ broken:boolean, reason:string|null, brokenFields:string[],
 *             baseline:number|null, count:number, severity:'none'|'field'|'empty' }}
 *    severity:
 *      'empty' — zero records (or scalar produced nothing): definitely broken
 *      'field' — records exist but one or more fields are always empty
 *      'none'  — healthy
 */
function classifyStep(stat, baseline = null) {
  const count = Number(stat && stat.count) || 0;
  const brokenFields = emptyFieldsOf(stat);
  const isCollection = isCollectionType(stat && stat.type);
  const base = (typeof baseline === 'number' && baseline > 0) ? baseline : null;

  // 1) Nothing came back at all — the strongest, unambiguous signal.
  if (count === 0) {
    return {
      broken: true,
      reason: isCollection ? 'no-records' : 'no-value',
      brokenFields,
      baseline: base,
      count,
      severity: 'empty',
    };
  }

  // 2) A single record where history shows there were clearly many before.
  if (isCollection
      && count <= THRESHOLDS.SUSPICIOUS_AT_OR_BELOW
      && base != null
      && base >= THRESHOLDS.MIN_BASELINE_FOR_LOW) {
    return {
      broken: true,
      reason: 'too-few-records',
      brokenFields,
      baseline: base,
      count,
      severity: 'empty',
    };
  }

  // 3) Records exist but a field is empty in every one of them.
  if (brokenFields.length > 0) {
    return {
      broken: true,
      reason: 'empty-fields',
      brokenFields,
      baseline: base,
      count,
      severity: 'field',
    };
  }

  return { broken: false, reason: null, brokenFields: [], baseline: base, count, severity: 'none' };
}

// Human-readable, no-AI summary of why a step was flagged. Used in logs and
// in the run's repair record so the user can see the deterministic trigger.
function describeBreakage(verdict, stat) {
  const label = (stat && (stat.label || stat.type)) || 'step';
  switch (verdict.reason) {
    case 'no-records':
      return `"${label}" captured 0 records (its list selector matched nothing).`;
    case 'no-value':
      return `"${label}" extracted no value (its selector matched nothing).`;
    case 'too-few-records':
      return `"${label}" captured only ${verdict.count} record(s); previous runs averaged ~${verdict.baseline}.`;
    case 'empty-fields':
      return `"${label}" captured ${verdict.count} record(s) but field(s) ${verdict.brokenFields.map(f => `"${f}"`).join(', ')} were empty in all of them.`;
    default:
      return `"${label}" looks healthy.`;
  }
}

module.exports = {
  THRESHOLDS,
  isCollectionType,
  emptyFieldsOf,
  isSuspicious,
  classifyStep,
  describeBreakage,
};
