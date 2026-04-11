const browserManager = require('../browser/BrowserManager');
const userModes = new Map();

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
          await page.mouse.down(action.x, action.y);
        } else if (action.type === "mouseup") {
          await page.mouse.up(action.x, action.y);
        } else if (action.type === "leave") {
          await page.mouse.move(-1, -1);
          socket.emit("cursorType", { cursor: "default" });
        } else if (action.type === "keydown") {
          await page.keyboard.down(action.key);
        } else if (action.type === "keyup") {
          await page.keyboard.up(action.key);
        }
        // Add support for other types such as keypress, input, etc as needed
      } catch (err) {
        console.error(`Failed to perform action:`, err);
        socket.emit("actionResult", { success: false, error: err.message });
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
    }
  };
};
