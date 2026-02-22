(function () {
  // Ensure socket.io client is loaded
  if (typeof io === "undefined") {
    const script = document.createElement("script");
    script.src = "https://cdn.socket.io/4.7.2/socket.io.min.js"; // latest client
    script.onload = initTracker;
    document.head.appendChild(script);
  } else {
    initTracker();
  }

  function initTracker() {
    const userId = window.__SCRAPER_USER_ID__;

    const socket = io("http://localhost:3001", { 
        transports: ["websocket"], 
        query: { userId } 
    });

    function emitAction(type, details) {
      // console.log(`Emitting action: ${type}`, details);
      socket.emit("userAction", { type, ...details });
    }

    // Click tracking (with navigation detection)
    document.addEventListener("click", (e) => {
      const target = e.target.closest("a, button, [role='button'], [data-id]");

      // If it's a link → also emit navigate action
      if (target && target.getAttribute("href")) {
        e.preventDefault(); // prevent iframe from following link
        try {
          let href = target.getAttribute("href");
          let absoluteUrl;

          if (/^(https?:)?\/\//i.test(href)) {
                absoluteUrl = new URL(href).href;
            } else {
                // Use custom base URL for relative links
                absoluteUrl = new URL(href, window.__SCRAPER_BASE_URL__).href;
            }
          
          socket.emit("command", { action: "navigate", url: absoluteUrl });

        } catch (err) {
          console.warn("Failed to resolve link for navigation:", err);
        }
      } else {
        const xpath = getElementXPath(target);
        emitAction("click", {
          xpath: xpath,
        });
      }
    });

    // Scroll tracking
    window.addEventListener("scroll", () => {
      emitAction("scroll", {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      });
    });

    // Hover tracking
    document.addEventListener("mouseover", (e) => {
      emitAction("hover", {
        tag: e.target.tagName,
        id: e.target.id,
        class: e.target.className,
      });
    });

    // Drag & Drop tracking
    document.addEventListener("dragstart", (e) => {
      emitAction("dragstart", {
        tag: e.target.tagName,
        id: e.target.id,
        class: e.target.className,
      });
    });

    document.addEventListener("drop", (e) => {
      emitAction("drop", {
        tag: e.target.tagName,
        id: e.target.id,
        class: e.target.className,
      });
    });

    // Input tracking (typing)
    document.addEventListener("input", (e) => {
      emitAction("input", {
        tag: e.target.tagName,
        id: e.target.id,
        class: e.target.className,
        value: e.target.value?.slice(0, 50) || "",
      });
    });

    console.log("✅ UserActionTracker injected and running");
  }
})();

function getElementXPath(el) {
  if (el.id) return `//*[@id="${el.id}"]`;
  if (el === document.body) return "/html/body";

  let ix = 0;
  let siblings = el.parentNode ? el.parentNode.childNodes : [];
  for (let i = 0; i < siblings.length; i++) {
    let sibling = siblings[i];
    if (sibling.nodeType === 1 && sibling.tagName === el.tagName) {
      ix++;
      if (sibling === el) {
        return (
          getElementXPath(el.parentNode) +
          "/" +
          el.tagName.toLowerCase() +
          "[" +
          ix +
          "]"
        );
      }
    }
  }
}
