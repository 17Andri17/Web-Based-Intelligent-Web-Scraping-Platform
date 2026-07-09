'use strict';

/* ===========================================================================
   Error classifier
   ---------------------------------------------------------------------------
   Classifies a workflow execution error into one of:
     CONNECTION  — transient network failure, safe to retry
     HTTP        — server returned a non-success status (4xx/5xx)
     CAPTCHA     — a CAPTCHA / anti-bot challenge blocked the page
     SELECTOR    — a CSS/XPath selector failed to match, the page structure
                   likely changed: candidate for LLM-driven repair
     LLM         — the LLM API itself failed (rate limit, network, etc.)
     UNKNOWN     — anything we can't confidently attribute

   The categorisation drives the recovery strategy:
     CONNECTION → retry with backoff
     HTTP       → surface to the user (page can't be reached)
     CAPTCHA    → surface to the user (configure a solver or solve manually);
                  never a selector-repair candidate
     SELECTOR   → ask the LLM to propose a new selector
     LLM        → mark the run as 'needs_review'
   ========================================================================= */

const CONN_PATTERNS = [
  /\bETIMEDOUT\b/i,
  /\bECONNREFUSED\b/i,
  /\bECONNRESET\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bEHOSTUNREACH\b/i,
  /\bENETUNREACH\b/i,
  /net::ERR_(?:TIMED_OUT|CONNECTION_(?:REFUSED|RESET|CLOSED)|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE)/i,
  /Navigation timeout of \d+ ms exceeded/i,
  /Timeout exceeded while waiting for navigation/i,
  /socket hang up/i,
];

// Page returned an HTTP error status. Puppeteer's goto throws with these phrases.
const HTTP_PATTERNS = [
  /net::ERR_(?:HTTP_RESPONSE_CODE_FAILURE|ABORTED|FAILED|EMPTY_RESPONSE|TOO_MANY_REDIRECTS|UNSAFE_PORT|INVALID_RESPONSE|CERT_)/i,
  /HTTP\s+(?:4\d{2}|5\d{2})/i,
  /status\s+code\s+(?:4\d{2}|5\d{2})/i,
  /\b(?:404|403|410|429|500|502|503|504)\b/,
];

const SELECTOR_PATTERNS = [
  /waitForAny:\s*none matched/i,
  /Waiting for selector\s+`.+`\s+failed/i,
  /No node found for selector/i,
  /failed to find element matching selector/i,
  /resolveElement.*element not found/i,
  /Cannot read prop(?:erty|erties) of (?:null|undefined)/i,
  /TypeError: el(?:ement)? is null/i,
  /evalOnElement.*not found/i,
];

const LLM_PATTERNS = [
  /^LLM HTTP \d+/i,
  /\bNO_API_KEY\b/,
  /\bEMPTY_RESPONSE\b/,
  /\bECONNREFUSED.*(?:groq|openai|anthropic)/i,
];

// CAPTCHA / anti-bot challenge. The generated runtime throws with a
// "CAPTCHA_DETECTED: ..." message (see browser/captcha.js). We also catch a
// couple of provider-agnostic phrasings just in case.
const CAPTCHA_PATTERNS = [
  /\bCAPTCHA_DETECTED\b/i,
  /\b(?:recaptcha|hcaptcha|turnstile)\b.*\b(?:challenge|blocked|required)\b/i,
  /\bare you a (?:human|robot)\b/i,
];

function matches(patterns, s) {
  return patterns.some(p => p.test(s));
}

function classifyError(message) {
  const s = String(message || '');
  if (!s) return 'UNKNOWN';
  if (matches(LLM_PATTERNS, s)) return 'LLM';
  // CAPTCHA before HTTP/SELECTOR: an anti-bot block often co-occurs with a 403
  // and with selectors that "don't match" (because the real page never
  // loaded) — but the actionable cause is the challenge, not the selector.
  if (matches(CAPTCHA_PATTERNS, s)) return 'CAPTCHA';
  // HTTP must be checked before CONNECTION, since 'net::ERR_*' patterns
  // overlap (a 503 wrapped in net::ERR_HTTP_RESPONSE_CODE_FAILURE).
  if (matches(HTTP_PATTERNS, s)) return 'HTTP';
  if (matches(CONN_PATTERNS, s)) return 'CONNECTION';
  if (matches(SELECTOR_PATTERNS, s)) return 'SELECTOR';
  return 'UNKNOWN';
}

// Human-readable summary tailored to each category. Shown to the user
// alongside the raw error message.
function summarise(category, message, stepLabel) {
  const stepRef = stepLabel ? `step "${stepLabel}"` : 'a step';
  switch (category) {
    case 'CONNECTION':
      return `Network problem while running ${stepRef}. The platform retried automatically — if you're seeing this, the retries didn't succeed either.`;
    case 'HTTP':
      return `The target page returned an error response while running ${stepRef}. Check the URL is still reachable and not blocked / rate-limited.`;
    case 'CAPTCHA':
      return `A CAPTCHA / anti-bot challenge blocked ${stepRef}. Free options: solve it live while building the scraper, or lower your request rate and use a residential proxy so it stops appearing. For unattended runs, configure a solver (set CAPTCHA_PROVIDER + CAPTCHA_API_KEY — e.g. CapSolver ~$0.30–0.80 / 1000 solves) and add a "Solve CAPTCHA" step.`;
    case 'SELECTOR':
      return `Could not locate the element used by ${stepRef}. The website's HTML may have changed — the platform attempted an automatic repair via the LLM.`;
    case 'EMPTY_RESULT':
      return `${stepRef} ran without error but captured no data — its selector matched nothing, which almost always means the page structure changed. The platform attempted an automatic repair.`;
    case 'LLM':
      return `The AI repair service is unavailable right now (${truncate(message)}). This run has been flagged for manual review.`;
    default:
      return `${stepRef} failed: ${truncate(message)}`;
  }
}

function truncate(s, n = 200) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Selector-class errors are the only category we attempt to repair via LLM.
// UNKNOWN errors get one repair attempt too, on the theory that a TypeError
// reading `.click` of null almost always means a missing selector.
function shouldAttemptRepair(category) {
  return category === 'SELECTOR' || category === 'UNKNOWN' || category === 'EMPTY_RESULT';
}

module.exports = { classifyError, summarise, shouldAttemptRepair };
