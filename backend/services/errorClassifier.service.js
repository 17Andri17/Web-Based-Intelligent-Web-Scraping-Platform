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

// Human-readable summary tailored to each category. This is the line a
// non-technical user reads when a run fails, so it stays in plain language and
// leads with what they can DO. Setup details that only make sense to whoever
// administers the instance (environment variables, provider pricing) belong in
// `adminHint`, which the UI shows behind a "technical details" disclosure —
// never inline in the message. The raw error is surfaced separately.
function summarise(category, message, stepLabel) {
  const stepRef = stepLabel ? `step "${stepLabel}"` : 'a step';
  switch (category) {
    case 'CONNECTION':
      return `Couldn't reach the site while running ${stepRef}. The platform already retried a few times, so the connection problem lasted a while — the site may be down, or your network may have dropped.`;
    case 'HTTP':
      return `The site returned an error page while running ${stepRef}. It may have moved the page, blocked the request, or asked you to slow down.`;
    case 'CAPTCHA':
      return `The site showed an "are you human?" check and blocked ${stepRef}. You can solve it yourself in the live browser while building the scraper, or slow the run down and use a proxy so it stops appearing. For runs that happen unattended, an automatic solver can be set up.`;
    case 'SELECTOR':
      return `Couldn't find the thing ${stepRef} was pointed at. The website has probably changed its layout — the platform tried to repair the step automatically.`;
    case 'EMPTY_RESULT':
      return `${stepRef} finished without error but came back empty — what it points at wasn't on the page. That nearly always means the site changed its layout. The platform tried to repair the step automatically.`;
    case 'LLM':
      return `The automatic repair service couldn't be reached, so this run is waiting for you to look at it.`;
    default:
      return `${stepRef} failed: ${truncate(message)}`;
  }
}

// Setup guidance for whoever runs this instance — environment variables,
// providers, costs. Kept out of `summary` so the person who just wanted their
// data isn't handed a configuration task written in shell.
function adminHint(category, message) {
  switch (category) {
    case 'CAPTCHA':
      return 'To solve CAPTCHAs on unattended runs, set CAPTCHA_PROVIDER and CAPTCHA_API_KEY (e.g. CapSolver, roughly $0.30–0.80 per 1000 solves) and add a "Solve CAPTCHA" step to the workflow.';
    case 'LLM':
      return `The LLM API call failed: ${truncate(message)}. Check LLM_API_KEY and the provider's status.`;
    default:
      return null;
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

module.exports = { classifyError, summarise, adminHint, shouldAttemptRepair };
