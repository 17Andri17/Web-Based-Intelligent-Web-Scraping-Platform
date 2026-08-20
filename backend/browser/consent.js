'use strict';

/* ===========================================================================
   CMP / Cookie-consent auto-dismiss
   ---------------------------------------------------------------------------
   One source of truth for the page-side "find and dismiss the cookie banner"
   logic, reused by BOTH:
     - the live editor session (injected via evaluateOnNewDocument in server.js)
     - generated scrape scripts (inlined by workflowCodegen.js)

   The core is `__consentApplyOnce(preference, registryOnly)` — pure DOM, no
   dependencies. It returns the handled CMP/source name (string) or null.
   `__consentClassifyClick(target)` shares the same word lists / region
   detection and is used by the live editor's "click-to-teach" listener to
   recognise when the USER manually dismissed a banner the cascade missed.

   Default behaviour is ACCEPT: as a scraper the goal is to remove the overlay
   and unblock content as reliably as possible, and the accept control is the
   one CMPs almost always render with a single, stably-labelled click. A
   'reject' preference is supported (prefers a one-click reject, else falls
   back to accept), and 'off' disables it entirely.

   Detection strategy (in order of precision):
     1. Known-CMP registry — exact selectors / JS APIs for ~25 popular CMPs.
     2. Container-first heuristic — find elements that LOOK like a consent
        surface (cookie-ish id/class, dialog role, fixed overlay) whose text
        talks about cookies, then scan clickable descendants (including
        pointer-cursor divs/spans, which many custom banners use).
     3. Global scored scan — every button-ish element on the page (and in
        open shadow roots) is scored on wording strength + surrounding
        consent evidence; the best candidate above threshold is clicked.
        This replaces the old first-match-wins scan, which often clicked a
        weak match (or nothing) on long-tail banners.
     4. Close-button last resort — inside a container with STRONG cookie
        evidence, a plain ×/close control also unblocks the page.

   Cooperation with the in-page SelectorTool: clicks are wrapped with
   window.__consentInProgress__ = true so the selector tool's capture-phase
   click handler lets the synthetic click through to the real button instead
   of treating it as an element selection. This is what keeps consent working
   while the user is in selection mode or switches modes mid-navigation.
   ========================================================================= */

const CONSENT_CASCADE_SRC = `
var __consentU = (function () {
  /* ── Wording tiers ──────────────────────────────────────────────────────
     STRONG phrases are unambiguous consent wording — safe to click on any
     single piece of region evidence. WEAK words ('ok', 'continue', …) also
     appear on newsletter popups / app banners, so they additionally require
     EXPLICIT cookie evidence (cookie-ish id/class or cookie-talking text).
     All entries are diacritics-stripped lowercase (see norm()). */
  var STRONG_ACCEPT = [
    'accept all','accept all cookies','allow all','allow all cookies','accept cookies','allow cookies',
    'agree and close','agree & close','agree to all','agree and continue','accept and continue','accept & continue',
    'accept and close','accept & close','i accept','i agree','yes, i agree','consent to all','enable all',
    'alle akzeptieren','alle cookies akzeptieren','allen zustimmen','akzeptieren und weiter','alles akzeptieren','einverstanden',
    'tout accepter','accepter tout','accepter et fermer',"j'accepte",'accepter les cookies','tout autoriser','autoriser tous',
    'aceptar todo','aceptar todas','aceptar cookies','aceptar y cerrar','aceptar y continuar',
    'accetta tutto','accetta tutti','accetto','accetta e chiudi','accetta cookie','accetta i cookie',
    'aceitar todos','aceitar tudo','aceitar cookies','aceitar e fechar',
    'akceptuj wszystko','akceptuj wszystkie','akceptuje wszystkie','zaakceptuj wszystko','zaakceptuj wszystkie',
    'zgadzam sie','zgoda na wszystkie','zezwol na wszystkie','przejdz do serwisu','akceptuje i przechodze',
    'alles accepteren','accepteer alles','alles toestaan','ik ga akkoord','akkoord',
    'godkann alla','acceptera alla','tillat alla','godta alle','tillad alle','accepter alle','accepter alle cookies',
    'hyvaksy kaikki','salli kaikki',
    'prijmout vse','prijmout vsechny','souhlasim','prijat vse',
    'osszes elfogadasa','mindet elfogadom','elfogadom',
    'accepta tot','accepta toate','sunt de acord',
    'tumunu kabul et','hepsini kabul et','kabul et',
    'prihvati sve','slazem se','sprejmi vse',
    'принять все','принять всё','прийняти вси','прийняти всі'
  ];
  var WEAK_ACCEPT = [
    'accept','agree','allow','ok','okay','got it','i understand','understood','continue','proceed','fine','yes',
    'akzeptieren','zustimmen','verstanden','weiter','stimme zu',
    'accepter','autoriser','compris','continuer',
    'aceptar','acepto','entendido','de acuerdo','continuar',
    'accetta','va bene','ho capito','continua',
    'aceitar','entendi','prosseguir',
    'akceptuj','akceptuje','rozumiem','zgoda','dalej','kontynuuj',
    'accepteren','toestaan','begrepen','prima','doorgaan',
    'godkann','tillat','godta','acceptera','fortsatt',
    'hyvaksy','jatka',
    'prijmout','souhlas','pokracovat',
    'elfogad','folytatas',
    'accepta','continua',
    'kabul','devam',
    'prihvatam','prihvati','razumem','nastavi'
  ];
  var STRONG_REJECT = [
    'reject all','reject all cookies','decline all','deny all','refuse all','refuse cookies','reject cookies',
    'only necessary','necessary only','only essential','essential only','strictly necessary','necessary cookies only',
    'use necessary cookies only','continue without accepting','continue without agreeing','without accepting',
    'alle ablehnen','nur notwendige','nur erforderliche','ablehnen und weiter','alles ablehnen',
    'tout refuser','refuser tout','continuer sans accepter','refuser les cookies',
    'rechazar todo','rechazar todas','solo necesarias','seguir sin aceptar',
    'rifiuta tutto','rifiuta tutti','solo essenziali','continua senza accettare',
    'recusar todos','recusar tudo','apenas necessarios',
    'odrzuc wszystko','odrzuc wszystkie','tylko niezbedne','nie zgadzam sie','nie wyrazam zgody',
    'alles afwijzen','weiger alles','alleen noodzakelijk',
    'avvisa alla','endast nodvandiga','avsla alle','kun nodvendige','afvis alle',
    'hylkaa kaikki','vain valttamattomat',
    'odmitnout vse','pouze nezbytne',
    'elutasitom','osszes elutasitasa',
    'respinge tot','doar necesare',
    'tumunu reddet',
    'odbij sve','otkloni sve',
    'отклонить все'
  ];
  var WEAK_REJECT = [
    'reject','decline','deny','refuse','disagree',
    'ablehnen','verweigern','refuser','rechazar','rifiuta','recusar','odrzuc','weigeren',
    'avvisa','avsla','afvis','hylkaa','odmitnout','elutasit','respinge','reddet','otkloni'
  ];
  /* Bare yes/no button wording ("Tak" / "Nie" / "Ja" / "Oui" …). These are
     matched ONLY against the FULL normalized button text — prefix/substring
     matching of 2-3 letter words would misfire wildly ('si' → 'sign in',
     'ja' → 'javascript'). Like WEAK words they additionally require explicit
     cookie evidence, so a lone "Yes" on a newsletter popup is never touched.
     Covers question-style banners: "Do you consent to cookies? [No] [Yes]". */
  var EXACT_ACCEPT = [
    'yes','ok','tak','ja','oui','si','sim','da','ano','igen','evet','kylla','taip','jah','aye'
  ];
  var EXACT_REJECT = [
    'no','nie','nein','non','nej','nee','ne','nem','hayir','ei'
  ];
  /* Words that must NEVER be auto-clicked (they open settings panels or
     navigate away). Authoritative — checked before want-lists. */
  var BLOCK_WORDS = [
    'settings','manage','preferences','customize','customise','options','choose','select','configure','configuration',
    'more info','learn more','more information','read more','find out more','show purposes','purposes','partners','vendors',
    'cookie policy','privacy policy','cookie notice','details','more options','advanced',
    'einstellungen','verwalten','anpassen','zwecke','mehr erfahren','mehr informationen','auswahl',
    'parametres','personnaliser','gerer','en savoir plus','plus d\\'informations',
    'configurar','personalizar','gestionar','mas informacion','preferencias','opciones',
    'preferenze','personalizza','gestisci','maggiori informazioni','impostazioni',
    'definicoes','gerir','saiba mais','mais informacoes',
    'ustawienia','zarzadzaj','preferencje','dostosuj','wiecej informacji','szczegoly','dowiedz sie wiecej',
    'chce wybrac','wybierz','wybieram','zmien ustawienia',
    'instellingen','beheren','aanpassen','meer informatie','voorkeuren',
    'installningar','hantera','anpassa','las mer','indstillinger','tilpas','laes mere',
    'asetukset','lisatietoja',
    'nastaveni','spravovat','vice informaci',
    'beallitasok','tovabbi informacio',
    'setari','mai multe',
    'ayarlar','secenekler',
    'postavke','podesavanja',
    'настройки','подробнее'
  ];
  var CLOSE_WORDS = [
    'close','dismiss','no thanks','not now','schliessen','fermer','cerrar','chiudi','fechar','zamknij',
    'sluiten','stang','luk','lukk','sulje','zavrit','bezaras','inchide','kapat','затвори','закрыть'
  ];
  var CLOSE_CHARS = { 'x': 1, '\\u00d7': 1, '\\u2715': 1, '\\u2716': 1, '\\u2717': 1, '\\u274c': 1 };

  // Explicit cookie/consent vocabulary for id/class names and container text.
  var IDCLASS_RX = /cookie|consent|gdpr|rodo|privacy|cmp|didomi|onetrust|cc-window|cc-banner|qc-cmp|notice|dsgvo/i;
  var COOKIE_TEXT_RX = /cookie|cookies|gdpr|rodo|dsgvo|consent|datenschutz|ciasteczk|prywatno|privacidad|privacidade|confidentialit|informativa|personvern|integritetspolicy|yksityisyy|soukrom|adatvedel|gizlilik|privatnost|конфиденциальн/i;

  function isVisible(el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity || '1') < 0.05) return false;
      return true;
    } catch (_) { return false; }
  }

  function norm(t) {
    var s = (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    // Strip diacritics so 'odrzuć' matches 'odrzuc', then fold the letters
    // NFD can't decompose (ß, ø, ł, æ, œ, đ) so Danish/Polish/German wording
    // matches its ASCII form in the lists above.
    try { s = s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); } catch (_) {}
    s = s.replace(/\\u00df/g, 'ss').replace(/\\u00f8/g, 'o').replace(/\\u0142/g, 'l')
         .replace(/\\u00e6/g, 'ae').replace(/\\u0153/g, 'oe').replace(/\\u0111/g, 'd');
    return s;
  }

  // Token-prefix matching. Splitting into word tokens and testing
  // startsWith(word) tolerates inflection ('akceptuj' matches 'akceptuję'
  // → 'akceptuje') WITHOUT the substring false-positives that plagued plain
  // includes() — e.g. 'ok' is NOT found inside 'cookie', and 'agree' is NOT
  // found inside 'disagree'. Multi-word phrases are matched as a substring
  // anchored on a word boundary. Returns the matched word (for specificity
  // ranking) or null.
  function matchAny(text, words) {
    if (!text) return null;
    var toks = text.split(/[^a-z0-9\\u0400-\\u04ff]+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (text === w) return w;
      if (w.indexOf(' ') !== -1) {
        var idx = text.indexOf(w);
        if (idx !== -1) {
          var before = idx === 0 ? ' ' : text.charAt(idx - 1);
          if (!/[a-z0-9\\u0400-\\u04ff]/.test(before)) return w;
        }
      } else {
        for (var j = 0; j < toks.length; j++) { if (toks[j].indexOf(w) === 0) return w; }
      }
    }
    return null;
  }

  // Full-text equality against a word list (see EXACT_ACCEPT/EXACT_REJECT).
  // The text must BE the word, not merely contain or start with it.
  function matchExact(text, words) {
    if (!text) return null;
    for (var i = 0; i < words.length; i++) { if (text === words[i]) return words[i]; }
    return null;
  }

  // The clickable text of a control — falls back to aria-label/title/value
  // so icon buttons and inputs are classifiable too.
  function clickableText(el) {
    var t = '';
    try { t = el.innerText || el.textContent || ''; } catch (_) {}
    t = (t || '').trim();
    if (!t) {
      try { t = el.getAttribute('aria-label') || el.getAttribute('title') || el.value || ''; } catch (_) {}
    }
    return t;
  }

  /* ── Region evidence ─────────────────────────────────────────────────────
     Walks up to 8 ancestors (following shadow-root hosts) collecting four
     independent signals of "this element sits inside a consent surface":
       idclass     — cookie/consent vocabulary in an ancestor id/class
       textmention — a reasonably-sized ancestor's text talks about cookies
       dialog      — role=dialog / aria-modal ancestor
       overlay     — fixed/sticky ancestor with high z-index, or an
                     edge-pinned full-width bar (classic bottom banner,
                     which often has NO elevated z-index)
     score: idclass/textmention 3 points, dialog/overlay 2 points.        */
  function regionEvidence(el) {
    var ev = { idclass: false, textmention: false, dialog: false, overlay: false, score: 0 };
    var node = el;
    for (var d = 0; d < 8 && node && node !== document.body && node !== document.documentElement; d++) {
      try {
        if (!ev.idclass) {
          var idc = (node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '');
          if (IDCLASS_RX.test(idc)) ev.idclass = true;
        }
        if (!ev.dialog) {
          if (node.getAttribute && (node.getAttribute('role') === 'dialog' || node.getAttribute('role') === 'alertdialog' || node.getAttribute('aria-modal') === 'true')) ev.dialog = true;
        }
        if (!ev.overlay) {
          var cs = getComputedStyle(node);
          if (cs.position === 'fixed' || cs.position === 'sticky') {
            var z = parseInt(cs.zIndex || '0', 10);
            if (z >= 50) ev.overlay = true;
            else {
              // Edge-pinned full-width bar: the classic bottom/top cookie
              // strip frequently sits at z-index auto.
              var r = node.getBoundingClientRect();
              var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
              if (r.width > vw * 0.85 && (r.top < 8 || r.bottom > vh - 8)) ev.overlay = true;
            }
          }
        }
        if (!ev.textmention) {
          // Size-capped so a whole article ABOUT cookies (ancestor near
          // <body>) doesn't count as banner evidence.
          var tc = (node.textContent || '').slice(0, 8000);
          if (tc.length > 0 && tc.length < 6000 && COOKIE_TEXT_RX.test(tc)) ev.textmention = true;
        }
      } catch (_) {}
      node = node.parentElement || (node.getRootNode && node.getRootNode() && node.getRootNode().host) || null;
    }
    ev.score = (ev.idclass ? 3 : 0) + (ev.textmention ? 3 : 0) + (ev.dialog ? 2 : 0) + (ev.overlay ? 2 : 0);
    return ev;
  }

  function isCloseControl(el, txt) {
    if (txt && (CLOSE_CHARS[txt] || matchAny(txt, CLOSE_WORDS))) return true;
    try {
      var aria = norm((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
      if (aria && matchAny(aria, CLOSE_WORDS)) return true;
    } catch (_) {}
    return false;
  }

  return {
    STRONG_ACCEPT: STRONG_ACCEPT, WEAK_ACCEPT: WEAK_ACCEPT,
    STRONG_REJECT: STRONG_REJECT, WEAK_REJECT: WEAK_REJECT,
    EXACT_ACCEPT: EXACT_ACCEPT, EXACT_REJECT: EXACT_REJECT,
    BLOCK_WORDS: BLOCK_WORDS,
    IDCLASS_RX: IDCLASS_RX, COOKIE_TEXT_RX: COOKIE_TEXT_RX,
    isVisible: isVisible, norm: norm, matchAny: matchAny, matchExact: matchExact,
    clickableText: clickableText, regionEvidence: regionEvidence,
    isCloseControl: isCloseControl
  };
})();

function __consentApplyOnce(preference, registryOnly) {
  preference = preference === 'reject' ? 'reject' : 'accept';
  var U = __consentU;
  window.__consentLastMatch__ = null;

  // Cooldown: don't re-fire a click before the banner tears down (also avoids
  // fighting SPA re-renders that re-insert the banner momentarily).
  try {
    var _now = Date.now();
    if (window.__consentLastClick__ && _now - window.__consentLastClick__ < 1500) return null;
  } catch (_) {}

  // Records what the cascade clicked, so the live editor can turn a successful
  // dismissal into a step that targets THAT control instead of re-running the
  // whole cascade on every run. The recorded selector is set only on the registry
  // path, where the selector is hand-written and stable; heuristic hits leave
  // it null and the editor generates one from the element instead.
  var _lastEl = null, _lastSel = null;
  function clickEl(el) {
    if (!el) return false;
    try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (_) {}
    // Signal the selector tool (if present) to ignore this synthetic click.
    window.__consentInProgress__ = true;
    window.__consentLastClick__ = Date.now();
    var ok = false;
    var label = '';
    try { label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60); } catch (_) {}
    try { el.click(); ok = true; } catch (_) {}
    if (ok) window.__consentLastMatch__ = { el: el, selector: _lastSel, text: label };
    setTimeout(function () { window.__consentInProgress__ = false; }, 0);
    return ok;
  }

  // Query a selector across the document AND any open shadow roots.
  function deepQueryOne(selector, root) {
    root = root || document;
    try { var direct = root.querySelector(selector); if (direct) return direct; } catch (_) {}
    var hosts;
    try { hosts = root.querySelectorAll('*'); } catch (_) { return null; }
    for (var i = 0; i < hosts.length; i++) {
      var sr = hosts[i].shadowRoot;
      if (sr) { var f = deepQueryOne(selector, sr); if (f) return f; }
    }
    return null;
  }
  function firstVisible(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = deepQueryOne(selectors[i]);
      // A shadow-root hit is NOT addressable by this selector from the
      // document, so it must not be reported as a learnable one.
      if (el && U.isVisible(el)) {
        var addressable = false;
        try { addressable = document.querySelector(selectors[i]) === el; } catch (_) {}
        _lastSel = addressable ? selectors[i] : null;
        return el;
      }
    }
    _lastSel = null;
    return null;
  }

  // ── Method 1: known-CMP registry (highest precision) ─────────────────────
  var REGISTRY = [
    { name: 'OneTrust',
      sig: function () { return !!(window.OneTrust || document.getElementById('onetrust-banner-sdk') || document.querySelector('.optanon-alert-box-wrapper')); },
      accept: ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler', '.optanon-allow-all'],
      reject: ['#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler'] },
    { name: 'Cookiebot',
      sig: function () { return !!(window.Cookiebot || document.getElementById('CybotCookiebotDialog')); },
      accept: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept', '#CybotCookiebotDialogBodyLevelButtonAccept'],
      reject: ['#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'] },
    { name: 'Didomi',
      sig: function () { return !!(window.Didomi || document.getElementById('didomi-notice')); },
      accept: ['#didomi-notice-agree-button', 'button[aria-label="Agree and close"]'],
      reject: ['.didomi-continue-without-agreeing', '#didomi-notice-disagree-button'] },
    { name: 'Quantcast',
      sig: function () { return !!(document.querySelector('.qc-cmp2-summary-buttons') || document.querySelector('[class*="qc-cmp2"]')); },
      accept: ['.qc-cmp2-summary-buttons button[mode="primary"]', '.qc-cmp2-footer button[mode="primary"]'],
      reject: ['.qc-cmp2-summary-buttons button[mode="secondary"]'] },
    { name: 'Usercentrics',
      sig: function () { return !!(window.UC_UI || document.querySelector('#usercentrics-root, [id^="usercentrics"]')); },
      accept: ['[data-testid="uc-accept-all-button"]', 'button[data-testid="uc-accept-all-button"]'],
      reject: ['[data-testid="uc-deny-all-button"]'],
      api: function (pref) {
        try {
          if (window.UC_UI && window.UC_UI.isInitialized && window.UC_UI.isInitialized()) {
            if (pref === 'reject') window.UC_UI.denyAllConsents(); else window.UC_UI.acceptAllConsents();
            return true;
          }
        } catch (_) {}
        return false;
      } },
    { name: 'Sourcepoint',
      sig: function () { return !!document.querySelector('[id^="sp_message_container"], .sp_choice_type_11'); },
      accept: ['.sp_choice_type_11', 'button[title="Accept"]', 'button[title="Accept all"]', 'button[aria-label="Accept all"]'],
      reject: ['.sp_choice_type_13', 'button[title="Reject all"]'] },
    { name: 'FundingChoices',
      sig: function () { return !!document.querySelector('.fc-consent-root, .fc-dialog-container'); },
      accept: ['.fc-cta-consent', 'button.fc-cta-consent'],
      reject: ['.fc-cta-do-not-consent'] },
    { name: 'ConsentManager',
      sig: function () { return !!(window.__cmp && document.getElementById('cmpbox')) || !!document.getElementById('cmpbox'); },
      accept: ['#cmpwelcomebtnyes', '.cmpboxbtnyes', '#cmpbox .cmpboxbtnyescustomchoices'],
      reject: ['#cmpwelcomebtnno', '.cmpboxbtnno'] },
    { name: 'Iubenda',
      sig: function () { return !!document.getElementById('iubenda-cs-banner'); },
      accept: ['#iubenda-cs-banner .iubenda-cs-accept-btn', '.iubenda-cs-accept-btn'],
      reject: ['#iubenda-cs-banner .iubenda-cs-reject-btn', '.iubenda-cs-reject-btn'] },
    { name: 'Tarteaucitron',
      sig: function () { return !!document.getElementById('tarteaucitronRoot'); },
      accept: ['#tarteaucitronPersonalize2', '#tarteaucitronAllAllowed', '.tarteaucitronAllow'],
      reject: ['#tarteaucitronAllDenied2', '.tarteaucitronDeny'] },
    { name: 'CookieLawInfo',
      sig: function () { return !!document.querySelector('#cookie-law-info-bar, .cli-modal-backdrop'); },
      accept: ['[data-cli_action="accept_all"]', '.wt-cli-accept-all-btn', '#cookie_action_close_header', '[data-cli_action="accept"]'],
      reject: ['.wt-cli-reject-btn', '[data-cli_action="reject"]'] },
    { name: 'CookieNotice',
      sig: function () { return !!document.getElementById('cookie-notice'); },
      accept: ['#cn-accept-cookie'],
      reject: ['#cn-refuse-cookie'] },
    { name: 'MooveGDPR',
      sig: function () { return !!document.getElementById('moove_gdpr_cookie_info_bar'); },
      accept: ['.moove-gdpr-infobar-allow-all'],
      reject: ['.moove-gdpr-infobar-reject-btn'] },
    { name: 'CookieFirst',
      sig: function () { return !!(window.CookieFirst || document.querySelector('[data-cookiefirst-widget], [id^="cookiefirst"]')); },
      accept: ['[data-cookiefirst-action="accept"]', '[data-cookiefirst-button="primary"]'],
      reject: ['[data-cookiefirst-action="reject"]'] },
    { name: 'HubSpot',
      sig: function () { return !!document.getElementById('hs-eu-cookie-confirmation'); },
      accept: ['#hs-eu-confirmation-button'],
      reject: ['#hs-eu-decline-button'] },
    { name: 'Shopify',
      sig: function () { return !!document.getElementById('shopify-pc__banner'); },
      accept: ['#shopify-pc__banner__btn-accept'],
      reject: ['#shopify-pc__banner__btn-decline'] },
    { name: 'Ezoic',
      sig: function () { return !!document.getElementById('ez-cookie-dialog'); },
      accept: ['#ez-accept-all', '#ez-cookie-dialog-wrapper .ez-accept-all'],
      reject: [] },
    { name: 'CivicUK',
      sig: function () { return !!(window.CookieControl || document.getElementById('ccc')); },
      accept: ['#ccc-recommended-settings', '#ccc-accept-settings'],
      reject: ['#ccc-reject-settings'] },
    { name: 'Osano',
      sig: function () { return !!(window.Osano || document.querySelector('.osano-cm-window')); },
      accept: ['.osano-cm-accept-all', '.osano-cm-accept'],
      reject: ['.osano-cm-denyAll', '.osano-cm-deny'] },
    { name: 'CookieYes',
      sig: function () { return !!document.querySelector('.cky-consent-container, [data-cky-tag]'); },
      accept: ['[data-cky-tag="accept-button"]', '.cky-btn-accept'],
      reject: ['[data-cky-tag="reject-button"]', '.cky-btn-reject'] },
    { name: 'Termly',
      sig: function () { return !!document.querySelector('#termly-code-snippet-support, [data-tid^="banner"]'); },
      accept: ['[data-tid="banner-accept"]', 'button[aria-label="Accept All"]'],
      reject: ['[data-tid="banner-decline"]'] },
    { name: 'Complianz',
      sig: function () { return !!document.querySelector('.cmplz-cookiebanner'); },
      accept: ['.cmplz-accept', 'button.cmplz-btn.cmplz-accept'],
      reject: ['.cmplz-deny'] },
    { name: 'Borlabs',
      sig: function () { return !!document.querySelector('#BorlabsCookieBox, ._brlbs-block-content'); },
      accept: ['#CookieBoxSaveButton', 'a[data-cookie-accept-all]', 'a[data-cookie-accept]'],
      reject: ['a[data-cookie-refuse]'] },
    { name: 'TrustArc',
      sig: function () { return !!document.querySelector('#truste-consent-track, .truste_box_overlay'); },
      accept: ['#truste-consent-button'],
      reject: ['#truste-consent-required'] },
    { name: 'CookieConsent',
      sig: function () { return !!document.querySelector('.cc-window, .cc-banner'); },
      accept: ['.cc-allow', '.cc-btn.cc-allow', 'a[aria-label="allow cookies"]', '.cc-dismiss'],
      reject: ['.cc-deny', '.cc-btn.cc-deny'] },
    { name: 'Klaro',
      sig: function () { return !!document.querySelector('.klaro .cookie-modal, .klaro .cn-body'); },
      accept: ['.klaro .cm-btn-success', '.klaro button.cm-btn-accept-all', '.klaro .cm-btn-accept-all'],
      reject: ['.klaro .cm-btn-decline'] },
    { name: 'Axeptio',
      sig: function () { return !!document.querySelector('#axeptio_overlay, .axeptio_mount'); },
      accept: ['#axeptio_btn_acceptAll', 'button[aria-label="Accept all"]'],
      reject: ['#axeptio_btn_dismiss', '#axeptio_btn_rejectAll'] },
    { name: 'StimulusCookiebox',
      // Stimulus-controller cookie form (e.g. lock.me): buttons carry
      // data-action="cookiebox#saveAndClose" with a bitmask value param —
      // 7 = all consents, 1 = essential only. Wording is often a bare
      // localized yes/no ("Tak"/"Nie"), so the registry match is far more
      // reliable than text scoring here.
      sig: function () { return !!document.querySelector('[data-controller~="cookiebox"], #cookiebox[data-controller]'); },
      accept: ['[data-controller~="cookiebox"] button[data-cookiebox-value-param="7"]', '#cookiebox button[data-cookiebox-value-param="7"]', '[data-controller~="cookiebox"] button.btn-primary[data-action*="saveAndClose"]'],
      reject: ['[data-controller~="cookiebox"] button[data-cookiebox-value-param="1"]', '#cookiebox button[data-cookiebox-value-param="1"]'] }
  ];

  for (var r = 0; r < REGISTRY.length; r++) {
    var cmp = REGISTRY[r];
    var present = false;
    try { present = cmp.sig(); } catch (_) {}
    var wantReject = (preference === 'reject' && cmp.reject && cmp.reject.length);
    var btn = firstVisible(wantReject ? cmp.reject : cmp.accept);
    if (btn) { if (clickEl(btn)) return cmp.name; }
    // CMP present but selectors didn't resolve a button → try its JS API.
    if (present && cmp.api) { try { if (cmp.api(preference)) return cmp.name + ' (api)'; } catch (_) {} }
    // Reject requested but no reject control → fall back to accept.
    if (preference === 'reject' && !btn) {
      var acc = firstVisible(cmp.accept || []);
      if (acc) { if (clickEl(acc)) return cmp.name + ' (accept-fallback)'; }
    }
  }

  // In sub-frames we only run the cheap registry pass — the broad heuristic
  // below could mis-fire inside unrelated iframes (ads, embeds).
  if (registryOnly) return null;

  // Past the registry: nothing below has a hand-written selector to learn.
  _lastSel = null;

  // ── Consent containers (for the container-first pass + close fallback) ───
  // Elements that structurally look like a consent surface AND whose text
  // actually talks about cookies. Case-insensitive attribute selectors keep
  // this to a single fast query.
  function findConsentContainers() {
    var out = [];
    function offer(n) {
      if (out.length >= 8 || !n) return;
      if (!U.isVisible(n)) return;
      var tc = (n.textContent || '').slice(0, 8000);
      if (tc.length < 15 || tc.length >= 6000) return;     // too tiny / whole-page
      if (!U.COOKIE_TEXT_RX.test(tc)) return;
      // Skip nested duplicates — keep the outermost matching container.
      for (var j = 0; j < out.length; j++) { if (out[j].contains(n) || n.contains(out[j])) return; }
      out.push(n);
    }
    // Named surfaces: cookie-ish id/class or dialog semantics.
    var sel = '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],' +
              '[id*="gdpr" i],[class*="gdpr" i],[id*="cmp" i],[aria-modal="true"],[role="dialog"],[role="alertdialog"]';
    var nodes;
    try { nodes = document.querySelectorAll(sel); } catch (_) { nodes = []; }
    for (var i = 0; i < nodes.length; i++) offer(nodes[i]);
    // Structural surfaces: fixed/sticky overlays mounted near the root —
    // custom banners often carry no cookie vocabulary in their class names
    // and use plain divs as buttons, so the named query above misses them.
    // Banners virtually always live within a few levels of <body>.
    function structuralScan(node, depth) {
      if (!node || depth > 3 || out.length >= 8) return;
      var kids = node.children || [];
      for (var k = 0; k < kids.length && k < 60; k++) {
        var el = kids[k];
        try {
          var cs = getComputedStyle(el);
          if (cs.position === 'fixed' || cs.position === 'sticky') { offer(el); continue; }
        } catch (_) {}
        structuralScan(el, depth + 1);
      }
    }
    structuralScan(document.body, 0);
    return out;
  }

  // ── Methods 2+3: scored heuristic (covers the long tail) ─────────────────
  var wantStrong = preference === 'reject' ? U.STRONG_REJECT : U.STRONG_ACCEPT;
  var wantWeak   = preference === 'reject' ? U.WEAK_REJECT   : U.WEAK_ACCEPT;
  var wantExact  = preference === 'reject' ? U.EXACT_REJECT  : U.EXACT_ACCEPT;
  var avoid      = preference === 'reject'
    ? U.BLOCK_WORDS.concat(U.STRONG_ACCEPT, U.WEAK_ACCEPT)
    : U.BLOCK_WORDS.concat(U.STRONG_REJECT, U.WEAK_REJECT);
  var avoidExact = preference === 'reject' ? U.EXACT_ACCEPT : U.EXACT_REJECT;

  var best = null;
  function consider(el, containerBoost) {
    if (!U.isVisible(el)) return;
    var txt = U.norm(U.clickableText(el));
    if (!txt || txt.length > 80) return;
    if (U.matchAny(txt, avoid)) return;
    if (U.matchExact(txt, avoidExact)) return;
    var strong = U.matchAny(txt, wantStrong);
    // Bare yes/no wording counts as WEAK evidence (full-text match only).
    var weak   = strong ? null : (U.matchAny(txt, wantWeak) || U.matchExact(txt, wantExact));
    if (!strong && !weak) return;
    var ev = U.regionEvidence(el);
    // STRONG wording clicks on any single evidence signal; WEAK wording
    // ('ok', 'continue', …) demands explicit cookie evidence so newsletter /
    // app-install popups are never touched.
    if (strong) { if (ev.score < 2) return; }
    else if (!(ev.idclass || ev.textmention)) return;
    var score = (strong ? 4 : 1) + ev.score + (containerBoost ? 1 : 0);
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'input' || (el.getAttribute && el.getAttribute('role') === 'button')) score += 1;
    if (!best || score > best.score) best = { el: el, score: score };
  }

  // Pass A — inside detected consent containers: scan ALL clickables,
  // including the pointer-cursor <div>/<span> "buttons" custom banners use.
  var containers = findConsentContainers();
  for (var c = 0; c < containers.length; c++) {
    var kids;
    try { kids = containers[c].querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], [onclick], div, span'); }
    catch (_) { continue; }
    var budget = 0;
    for (var k = 0; k < kids.length && budget < 400; k++) {
      var kid = kids[k];
      var ktag = (kid.tagName || '').toLowerCase();
      if (ktag === 'div' || ktag === 'span') {
        // Only treat generic elements as clickable when they look clickable
        // and are leaf-ish (a wrapper div would swallow the whole banner).
        if (kid.children.length > 2) continue;
        budget++;
        try { if (getComputedStyle(kid).cursor !== 'pointer') continue; } catch (_) { continue; }
        // Skip if a real button ancestor/descendant will be considered anyway.
        if (kid.closest && kid.closest('button, a, [role="button"]')) continue;
      }
      consider(kid, true);
    }
  }

  // Pass B — global button-ish scan (documents + open shadow roots).
  function scanAll(root) {
    var candidates;
    try { candidates = root.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"], a[href="#"]'); }
    catch (_) { return; }
    for (var i = 0; i < candidates.length; i++) consider(candidates[i], false);
    var hosts;
    try { hosts = root.querySelectorAll('*'); } catch (_) { hosts = []; }
    for (var h = 0; h < hosts.length; h++) {
      if (hosts[h].shadowRoot) scanAll(hosts[h].shadowRoot);
    }
  }
  scanAll(document);

  // Reject preference with no reject control anywhere → fall back to accept.
  if (!best && preference === 'reject') {
    wantStrong = U.STRONG_ACCEPT; wantWeak = U.WEAK_ACCEPT; wantExact = U.EXACT_ACCEPT;
    avoid = U.BLOCK_WORDS.concat(U.STRONG_REJECT, U.WEAK_REJECT);
    avoidExact = U.EXACT_REJECT;
    for (var c2 = 0; c2 < containers.length; c2++) {
      var kids2;
      try { kids2 = containers[c2].querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'); }
      catch (_) { continue; }
      for (var k2 = 0; k2 < kids2.length; k2++) consider(kids2[k2], true);
    }
    scanAll(document);
  }

  if (best) { if (clickEl(best.el)) return 'heuristic'; }

  // ── Method 4: close-button last resort ───────────────────────────────────
  // Only inside a container with strong, explicit cookie evidence: a plain
  // ×/close control still unblocks the page (no consent recorded — fine for
  // scraping). Never applied outside detected containers.
  for (var c3 = 0; c3 < containers.length; c3++) {
    var cont = containers[c3];
    var contEv = U.regionEvidence(cont.firstElementChild || cont);
    if (!(contEv.textmention && (contEv.idclass || contEv.overlay || contEv.dialog))) continue;
    var closers;
    try { closers = cont.querySelectorAll('button, a, [role="button"]'); } catch (_) { continue; }
    for (var q = 0; q < closers.length; q++) {
      var cand = closers[q];
      if (!U.isVisible(cand)) continue;
      var ctxt = U.norm(U.clickableText(cand));
      if (ctxt && ctxt.length > 24) continue;
      if (U.matchAny(ctxt, U.BLOCK_WORDS)) continue;
      if (U.isCloseControl(cand, ctxt)) { if (clickEl(cand)) return 'close-button'; }
    }
  }

  return null;
}

/* Classify a USER click as a probable cookie-banner dismissal. Shares the
   cascade's word lists + region evidence so the "click-to-teach" prompt
   (live editor) agrees with what the auto-dismiss would have looked for.
   Returns { el, kind: 'accept'|'reject'|'close', text } or null. */
function __consentClassifyClick(target) {
  var U = __consentU;
  if (!target || !target.closest) return null;
  var el = null;
  try { el = target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]'); } catch (_) {}
  if (!el) {
    // Custom banners often use pointer-cursor divs/spans as buttons.
    var n = target, hops = 0;
    while (n && n !== document.body && hops++ < 4) {
      try { if (getComputedStyle(n).cursor === 'pointer' && n.children.length <= 2) { el = n; break; } } catch (_) {}
      n = n.parentElement;
    }
  }
  if (!el || !U.isVisible(el)) return null;
  var txt = U.norm(U.clickableText(el));
  if (txt.length > 80) return null;
  if (txt && U.matchAny(txt, U.BLOCK_WORDS)) return null;

  var kind = null, strong = false;
  if (U.matchAny(txt, U.STRONG_ACCEPT)) { kind = 'accept'; strong = true; }
  else if (U.matchAny(txt, U.STRONG_REJECT)) { kind = 'reject'; strong = true; }
  else if (U.matchAny(txt, U.WEAK_ACCEPT)) kind = 'accept';
  else if (U.matchAny(txt, U.WEAK_REJECT)) kind = 'reject';
  else if (U.matchExact(txt, U.EXACT_ACCEPT)) kind = 'accept';
  else if (U.matchExact(txt, U.EXACT_REJECT)) kind = 'reject';
  else if (U.isCloseControl(el, txt)) kind = 'close';
  if (!kind) return null;

  var ev = U.regionEvidence(el);
  if (kind === 'close') {
    if (!(ev.textmention && (ev.idclass || ev.overlay || ev.dialog))) return null;
  } else if (strong) {
    if (ev.score < 2) return null;
  } else {
    if (!(ev.idclass || ev.textmention)) return null;
  }
  var label = '';
  try { label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60); } catch (_) {}
  return { el: el, kind: kind, text: label };
}
`;

/**
 * Self-contained script injected into the live editor session via
 * evaluateOnNewDocument. Installs an auto-runner (poll a few times + watch the
 * DOM for late/SPA banners) and exposes window.__dismissConsent__() for manual
 * triggering. Honours window.__CONSENT_PREF__ ('accept' | 'reject' | 'off').
 *
 * Also installs the "click-to-teach" listener: when the USER manually clicks
 * something that classifies as a cookie-banner control (typically because the
 * auto-dismiss missed the banner, or the preference is 'off'), it reports a
 * `consentClickCandidate` event over the sendToNode binding so the frontend
 * can offer to record a "Close cookie banner" workflow step — without the
 * user ever leaving navigation mode. The click itself is never blocked.
 */
function buildInjectedConsentScript() {
  return `(function () {
  if (window.__CONSENT_RUNNER_INSTALLED__) return;
  window.__CONSENT_RUNNER_INSTALLED__ = true;
  if (typeof window.__CONSENT_PREF__ === 'undefined') window.__CONSENT_PREF__ = 'accept';

  ${CONSENT_CASCADE_SRC}

  var _isTop = false;
  try { _isTop = (window.top === window); } catch (_) { _isTop = false; }

  // Deliver a payload over the sendToNode binding, retrying until the node
  // side ACKNOWLEDGES receipt. Right after a navigation the binding can be
  // half-alive: the page-side call "succeeds" but the CDP event is dropped
  // before the node side has re-acquired the new document's context id (see
  // BrowserManager.ensureBinding). The exposed function returns a promise
  // that only resolves once the node callback actually ran — that's the ack.
  // Duplicate deliveries are possible and fine: receivers are idempotent.
  function __reportToNode(payload) {
    var tries = 0, acked = false, timer = null;
    function attempt() {
      tries++;
      try {
        if (typeof window.sendToNode !== 'function') return;
        var p = window.sendToNode(payload);
        if (p && typeof p.then === 'function') {
          p.then(function () { acked = true; if (timer) clearInterval(timer); }, function () {});
        } else {
          acked = true;
          if (timer) clearInterval(timer);
        }
      } catch (_) {}
    }
    attempt();
    timer = setInterval(function () {
      if (acked || tries >= 20) { clearInterval(timer); return; }
      attempt();
    }, 700);
  }

  // Run the FULL cascade (registry + heuristic) in every frame — many CMPs
  // (Sourcepoint, TrustArc, Google Funding Choices, …) render their banner
  // inside a cross-origin iframe with a non-registry button, so a
  // registry-only pass there would miss them. The heuristic's consent-region
  // + block-word guards keep it from mis-clicking unrelated iframe buttons.
  window.__dismissConsent__ = function (pref) {
    try { return __consentApplyOnce(pref || window.__CONSENT_PREF__ || 'accept', false); }
    catch (e) { return null; }
  };

  // Turn the control the cascade just clicked into a selector the generated
  // script can target directly, so an unattended run doesn't have to re-walk
  // the whole registry + heuristic to find the same button. The registry's own
  // hand-written selector wins when there is one (it is stable by design);
  // otherwise we generate one the same way click-to-teach does. Sub-frame
  // selectors are fine — clickIfPresent searches every frame at run time.
  function __learnConsentTarget() {
    var m = null;
    try { m = window.__consentLastMatch__; } catch (_) {}
    if (!m || !m.el) return null;
    var out = { text: m.text || '' };
    if (m.selector) { out.selector = m.selector; out.selectorType = 'css'; out.fallbackSelectors = []; return out; }
    try {
      if (window.SelectorGenerator && window.SelectorGenerator.getSelectorsForElement) {
        var g = window.SelectorGenerator.getSelectorsForElement(m.el, { maxFallbacks: 4, actionType: 'CLICK_ELEMENT' });
        if (g && g.primary && g.primary.value) {
          out.selector = g.primary.value;
          out.selectorType = g.primary.type || 'css';
          out.fallbackSelectors = (g.fallbacks || []).map(function (f) { return { value: f.value, type: f.type || 'css' }; });
          return out;
        }
      }
    } catch (_) {}
    return null;
  }

  // Throttle so a mutation-heavy page can't trigger the full cascade (which
  // walks shadow roots) more than ~2.5x/sec, regardless of mutation volume.
  var _lastRun = 0;
  function tryRun() {
    if (window.__CONSENT_PREF__ === 'off') return;
    var t = Date.now();
    if (t - _lastRun < 400) return;
    _lastRun = t;
    var name = window.__dismissConsent__();
    if (name) {
      window.__consentHandled__ = true;
      // Reported via the sendToNode exposed-function binding (CDP
      // Runtime.addBinding) instead of console.log + page.on('console', ...).
      // The latter only delivers Runtime.consoleAPICalled events once
      // Runtime.enable has been called for the page, and enabling that
      // domain also switches on Chrome's console object-preview machinery —
      // which is exactly what some "devtools/debugger attached" fingerprint
      // checks probe for (they format a trap object via console.log and see
      // if its getter fires), regardless of whether a visible DevTools panel
      // is open. addBinding never touches the Runtime domain, so it can't
      // trip that signal.
      var learned = __learnConsentTarget();
      __reportToNode({
        type: 'consent', name: name,
        selector:          learned ? learned.selector : null,
        selectorType:      learned ? learned.selectorType : 'css',
        fallbackSelectors: learned ? learned.fallbackSelectors : [],
        buttonText:        learned ? learned.text : '',
        inIframe: !_isTop,
        text: '🍪 Consent handled: ' + name
      });
    }
  }

  // Banners often inject after load — poll a handful of times over ~8s
  // (slow pages load their CMP script late), and (top frame only) watch the
  // DOM for late / SPA banners for 30s.
  var attempts = 0;
  var iv = setInterval(function () { attempts++; tryRun(); if (attempts >= 14) clearInterval(iv); }, 600);

  if (_isTop) {
    try {
      var mo = new MutationObserver(function () { tryRun(); });
      var start = function () {
        try { mo.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch (_) {}
      };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
      setTimeout(function () { try { mo.disconnect(); } catch (_) {} }, 30000);
    } catch (_) {}
  }

  if (document.readyState !== 'loading') tryRun();
  else document.addEventListener('DOMContentLoaded', tryRun, { once: true });

  // ── Click-to-teach: detect a manual cookie-banner dismissal ──────────────
  // Editor clicks arrive as TRUSTED events (they're replayed through CDP
  // Input.dispatchMouseEvent), while the cascade's own el.click() is
  // untrusted — so isTrusted cleanly separates "the user clicked" from "we
  // clicked". Capture phase: classify BEFORE the banner's handler removes it
  // from the DOM, so selector generation still sees the real element.
  var _userClicks = 0;
  document.addEventListener('click', function (e) {
    try {
      if (!e.isTrusted) return;
      if (window.__consentInProgress__) return;
      _userClicks++;
      if (window.__SELECTION_MODE__) return;      // selection clicks never reach the page
      if (e.defaultPrevented) return;             // consumed by another tool
      if (window.__consentTeachSent__) return;    // one prompt per page load
      if (_userClicks > 8) return;                // banner clicks happen early
      var res = __consentClassifyClick(e.target);
      if (!res) return;
      var primary = null, primaryType = 'css', fallbacks = [];
      try {
        if (window.SelectorGenerator && window.SelectorGenerator.getSelectorsForElement) {
          var out = window.SelectorGenerator.getSelectorsForElement(res.el, { maxFallbacks: 4, actionType: 'CLICK_ELEMENT' });
          if (out && out.primary) {
            primary = out.primary.value;
            primaryType = out.primary.type || 'css';
            fallbacks = (out.fallbacks || []).map(function (f) { return { value: f.value, type: f.type || 'css' }; });
          }
        }
      } catch (_) {}
      if (!primary) return;
      window.__consentTeachSent__ = true;
      __reportToNode({
        type: 'consentClickCandidate',
        selector: primary,
        selectorType: primaryType,
        fallbackSelectors: fallbacks,
        text: res.text,
        kind: res.kind,
        autoHandled: !!window.__consentHandled__,
        inIframe: !_isTop
      });
    } catch (_) {}
  }, true);
})();`;
}

/**
 * Node-side helper source inlined into generated scrape scripts. Defines an
 * async `dismissConsent(targetPage, preference, opts)` that runs the cascade
 * across every frame, retrying until a wait budget runs out.
 *
 * `opts.waitMs` is that budget (per call — the DISMISS_COOKIE_BANNER step
 * exposes it as "Banner wait"); it defaults to SCRAPER_CONSENT_WAIT_MS or
 * 1.5s, and collapses to ~0.4s once the page reports readyState 'complete',
 * because a finished page has already had its chance to render a banner.
 * Preference comes from the caller or process.env.SCRAPER_CONSENT (default
 * 'accept'); 'off' disables it. Returns true when a banner was handled, false
 * otherwise (absent banner is NOT an error — consent may already be stored in
 * the profile).
 */
function buildCodegenConsentHelper() {
  return `
// ─── Cookie-consent auto-dismiss (CMP banners) ─────────────────────────────
const __CONSENT_SRC = ${JSON.stringify(CONSENT_CASCADE_SRC)};
const __CONSENT_PREF = process.env.SCRAPER_CONSENT || 'accept';
// How long to keep re-checking after a pass finds nothing. The ONLY reason to
// wait at all is a CMP script that hasn't rendered its banner yet, so a page
// that has already reached readyState 'complete' gets a single short second
// look rather than the full budget. Without that, every navigation on a site
// whose consent is already stored pays the whole budget for nothing — once per
// paginated page and once per enriched row, where it dominates the run.
const __CONSENT_WAIT_MS = Number(process.env.SCRAPER_CONSENT_WAIT_MS) || 1500;
const __CONSENT_WAIT_LOADED_MS = 400;
// Resolve how long a consent lookup may keep retrying on THIS page. Shared by
// dismissConsent and by the selector path of the Close Cookie Banner step, so
// both shrink the same way on an already-loaded page.
async function __consentBudget(pg, waitMs) {
  let b = Number.isFinite(waitMs) ? waitMs : __CONSENT_WAIT_MS;
  if (b > __CONSENT_WAIT_LOADED_MS) {
    let complete = false;
    try { complete = await pg.evaluate(() => document.readyState === 'complete'); } catch (_) {}
    if (complete) b = __CONSENT_WAIT_LOADED_MS;
  }
  return Math.max(0, b);
}
async function dismissConsent(targetPage, preference, opts) {
  const pg = targetPage || (typeof page !== 'undefined' ? page : null);
  // Per-call preference (from the step) wins; otherwise fall back to the env
  // default. 'off' = leave the banner alone.
  const __pref = preference || __CONSENT_PREF;
  if (!pg || __pref === 'off') return false;
  const __opts = opts || {};
  const __deadline = Date.now() + await __consentBudget(pg, __opts.waitMs);
  for (;;) {
    let _hit = false;
    let _frames = [];
    try { _frames = pg.frames(); } catch (_) { try { _frames = [pg.mainFrame()]; } catch (_2) { _frames = []; } }
    for (const _frame of _frames) {
      try {
        const _name = await _frame.evaluate((src, pref) => {
          try {
            // eslint-disable-next-line no-new-func
            const fn = new Function('preference', src + '\\n;return __consentApplyOnce(preference, false);');
            return fn(pref);
          } catch (_) { return null; }
        }, __CONSENT_SRC, __pref);
        if (_name) { _hit = true; try { console.log('🍪 Consent handled: ' + _name); } catch (_) {} }
      } catch (_) {}
    }
    if (_hit) return true;
    // Always take at least one retry: a banner that renders a tick after the
    // first pass is exactly the case this loop exists for.
    if (Date.now() >= __deadline) return false;
    await new Promise(r => setTimeout(r, 300));
  }
}
`;
}

module.exports = { CONSENT_CASCADE_SRC, buildInjectedConsentScript, buildCodegenConsentHelper };
