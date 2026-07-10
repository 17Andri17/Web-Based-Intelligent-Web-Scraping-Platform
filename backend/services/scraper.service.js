const browserManager = require('../browser/BrowserManager');
const userModes = new Map();

// Modifier keys we currently believe are held down per user. Puppeteer's Mouse
// stamps every click with the Keyboard's live modifier bitmask, so if a keyup
// is ever lost — Alt+Tab away, focus leaving the canvas, or a keyup swallowed
// during a navigation — the modifier stays "down" and turns every plain
// left-click into Alt/Ctrl/Shift+click. An Alt+click in particular makes Chrome
// download the link ("Save page as", named after the URL) instead of navigating.
const userHeldModifiers = new Map();
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Shift', 'Meta']);

function heldModifiers(userId) {
  let set = userHeldModifiers.get(userId);
  if (!set) { set = new Set(); userHeldModifiers.set(userId, set); }
  return set;
}

// Before a click, drop any modifier we think is held but the click says is NOT
// pressed — reconciling the remote keyboard state to the real one and so
// guaranteeing a stuck modifier can never leak into a click. Missing flags
// (older clients) are treated as "no modifier", which is the correct default
// for this tool's plain left-clicks.
async function reconcileModifiers(userId, page, action) {
  const held = userHeldModifiers.get(userId);
  if (!held || held.size === 0) return;
  const stillDown = {
    Alt:      !!action.altKey,
    AltGraph: !!action.altKey,
    Control:  !!action.ctrlKey,
    Shift:    !!action.shiftKey,
    Meta:     !!action.metaKey,
  };
  for (const key of Array.from(held)) {
    if (stillDown[key] === false) {
      try { await page.keyboard.up(key); } catch (_) {}
      held.delete(key);
    }
  }
}

module.exports = (io) => {
  return {
    async navigate(userId, url) {
      console.log(`Navigating user ${userId} to ${url}`);
      if (!url || typeof url !== 'string' || !/^https?:\/\/.+/.test(url)) {
        console.error('Navigation error: Invalid URL');
        throw new Error('Invalid URL');
      }

      const page = await browserManager.getPage(userId);

      try {
        await page.goto(url, { waitUntil: 'networkidle2' });
        await page.addStyleTag({
          content: `
            * { scrollbar-width: auto !important; }
            ::-webkit-scrollbar { 
              display: block !important; 
              width: 12px !important; 
              height: 12px !important; 
            }
            ::-webkit-scrollbar-thumb { 
              background: #888 !important; 
              border-radius: 6px !important; 
            }
            ::-webkit-scrollbar-track { 
              background: #f1f1f1 !important; 
            }
          `
        });
        console.log(`User ${userId} navigated to ${url}`);
        // No need to send content—server.js streams screenshots
        if (io) {
          io.to(userId).emit("message", { msg: `Navigation complete: ${url}` });
        }
      } catch (err) {
        console.error('Navigation error:', err.message);
        throw err;
      }
      return true;
    },

    async performAction(userId, action, socket) {
      const page = await browserManager.getPage(userId);
      if (!page) {
        console.warn(`No page found for user ${userId}`);
        socket.emit("actionResult", { success: false, error: "Page not found" });
        return false;
      }

      try {
        if (action.type === "hover") {
          await page.mouse.move(action.x, action.y);

          const cursor = await page.evaluate(({x, y}) => {
            const el = document.elementFromPoint(x, y);
            return el ? window.getComputedStyle(el).cursor || 'default' : 'default';
          }, { x: action.x, y: action.y });
          
          // Send to frontend
          socket.emit("cursorType", { cursor });
          
        } else if (action.type === "mousedown") {
          // Clear any stuck modifier first so a plain click can't arrive as
          // Alt/Ctrl/Shift+click (which would download the link or open a new
          // tab instead of navigating).
          await reconcileModifiers(userId, page, action);
          await page.mouse.down(action.x, action.y);
        } else if (action.type === "mouseup") {
          await page.mouse.up(action.x, action.y);
        } else if (action.type === "leave") {
          await page.mouse.move(-1, -1);
          socket.emit("cursorType", { cursor: "default" });
        } else if (action.type === "wheel") {
          // Position the virtual mouse first so the wheel applies to the
          // right place (matters for nested scrollable containers).
          if (typeof action.x === "number" && typeof action.y === "number") {
            await page.mouse.move(action.x, action.y);
          }
          await page.mouse.wheel({
            deltaX: action.deltaX || 0,
            deltaY: action.deltaY || 0,
          });
        } else if (action.type === "paste") {
          // Ctrl/Cmd+V forwarded from the frontend with the HOST clipboard's
          // text — the remote browser has its own (empty) clipboard, so a
          // plain forwarded keystroke would paste nothing. sendCharacter
          // inserts the text via CDP Input.insertText, no key events needed.
          if (typeof action.text === "string" && action.text) {
            await page.keyboard.sendCharacter(action.text);
          }
        } else if (action.type === "keydown") {
          if (MODIFIER_KEYS.has(action.key)) heldModifiers(userId).add(action.key);
          await page.keyboard.down(action.key);
        } else if (action.type === "keyup") {
          const held = userHeldModifiers.get(userId);
          if (held) held.delete(action.key);
          await page.keyboard.up(action.key);
        }
        // Add support for other types such as keypress, input, etc as needed
      } catch (err) {
        // These are benign races that happen when the user moves the cursor
        // while a page is navigating away — the JS execution context dies
        // mid-evaluate. Don't spam stack traces or report failure to the UI.
        const msg = err && err.message ? err.message : String(err);
        const isNavRace =
          /Execution context was destroyed/i.test(msg) ||
          /Target closed/i.test(msg) ||
          /Session closed/i.test(msg) ||
          /Cannot find context/i.test(msg);
        if (!isNavRace) {
          console.error(`Failed to perform action:`, err);
          socket.emit("actionResult", { success: false, error: msg });
        }
        return false;
      }
    },

    setMode(userId, mode) {
      console.log(`Setting mode for ${userId} → ${mode}`);
      userModes.set(userId, mode);
    },

    getMode(userId) {
      return userModes.get(userId) || 'navigation';
    },

    clearUser(userId) {
      userModes.delete(userId);
      userHeldModifiers.delete(userId);
    }
  };
};
