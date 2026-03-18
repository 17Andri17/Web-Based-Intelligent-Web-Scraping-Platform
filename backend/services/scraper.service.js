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
        return false;
      }

      try {
        if (action.type === "click") {
          if (!typeof action.x === "number" && typeof action.y === "number") {
            // Click by coordinates
            await page.mouse.click(action.x, action.y);
            await page.evaluate(({ x, y }) => {
              // Remove previous marker if present
              const old = document.getElementById('__scraper_click_marker__');
              if (old) old.remove();

              const marker = document.createElement('div');
              marker.id = '__scraper_click_marker__';
              marker.style.position = 'absolute';
              marker.style.left = `${x - 10}px`;
              marker.style.top = `${y - 10}px`;
              marker.style.width = '20px';
              marker.style.height = '20px';
              marker.style.background = 'rgba(255,0,0,0.7)';
              marker.style.borderRadius = '50%';
              marker.style.zIndex = 99999;
              marker.style.pointerEvents = 'none';

              document.body.appendChild(marker);

              setTimeout(() => marker.remove(), 1500); // Remove after 1.5s
            }, { x: action.x, y: action.y });
            socket.emit("actionResult", { success: true });
            return true;
          } else {
            console.warn("Click action missing XPath or coordinates.");
            socket.emit("actionResult", { success: false });
            return false;
          }
        } else if (action.type === "hover") {
          await page.mouse.move(action.x, action.y);
        } else if (action.type === "mousedown") {
          await page.mouse.down(action.x, action.y);
        } else if (action.type === "mouseup") {
          await page.mouse.up(action.x, action.y);
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
