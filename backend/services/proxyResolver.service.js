'use strict';

const proxiesRepo = require('../db/repositories/proxies.repo');
const proxyPoolsRepo = require('../db/repositories/proxyPools.repo');

/* ===========================================================================
   proxyResolver.service
   ---------------------------------------------------------------------------
   Single entry point for turning a workflow's stored proxy preference into
   an actual, usable, credentials-included proxy config (or null) — used by
   both executionPipeline.service.js (scheduled/manual runs) and server.js
   (live editor preview) so the mode/legacy-format handling lives in exactly
   one place.

   workflow.meta.proxy shapes:
     { mode: 'none' }                    — explicit no-proxy
     { mode: 'single', id }              — one specific proxy (own or shared)
     { mode: 'pool', poolId }            — rotate through a pool (own or shared)
     { mode: 'platform' }                — the platform's designated default
                                            shared pool, no id needed — this is
                                            the seam a future plan-based
                                            selector hooks into (see
                                            proxyPools.repo.js)
   Falls back to the legacy bare `meta.proxyId` (from before pools existed)
   so workflows saved before this feature shipped keep working unchanged.
   ========================================================================= */

async function resolveWorkflowProxy(meta, userId) {
  if (!meta) return null;
  const spec = meta.proxy || (meta.proxyId ? { mode: 'single', id: meta.proxyId } : null);
  if (!spec || spec.mode === 'none' || !spec.mode) return null;

  try {
    switch (spec.mode) {
      case 'single':
        return spec.id ? await proxiesRepo.resolveForUse(spec.id, userId) : null;
      case 'pool':
        return spec.poolId ? await proxyPoolsRepo.pickProxyForUse(spec.poolId, userId) : null;
      case 'platform':
        return await proxyPoolsRepo.pickFromDefaultSharedPool();
      default:
        return null;
    }
  } catch (_) {
    // A deleted/inaccessible proxy or pool shouldn't fail the whole run —
    // proceed without a proxy rather than blocking scrape execution over it.
    return null;
  }
}

module.exports = { resolveWorkflowProxy };
