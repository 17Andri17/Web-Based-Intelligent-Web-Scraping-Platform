export function enableSelectionMode(socket, doc = document) {
  if (!socket) throw new Error("Socket.IO client instance required");

  doc.__selectionMode = true;

  function getCssPath(el) {
    const path = [];
    while (el.nodeType === Node.ELEMENT_NODE) {
      let selector = el.nodeName.toLowerCase();
      if (el.id) {
        selector += "#" + el.id;
        path.unshift(selector);
        break;
      } else {
        let nth = 1;
        let sib = el;
        while ((sib = sib.previousElementSibling)) {
          if (sib.nodeName.toLowerCase() === selector) nth++;
        }
        if (nth !== 1) selector += `:nth-of-type(${nth})`;
      }
      path.unshift(selector);
      el = el.parentNode;
    }
    return path.join(" > ");
  }

  function getXPath(el) {
    const idx = (sib, name) => {
      let count = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === name) count++;
      }
      return count;
    };
    const path = [];
    while (el.nodeType === Node.ELEMENT_NODE) {
      const name = el.nodeName.toLowerCase();
      const i = idx(el, el.nodeName);
      path.unshift(`${name}[${i}]`);
      el = el.parentNode;
    }
    return "/" + path.join("/");
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!doc.__selectionMode) return;
      e.preventDefault();
      e.stopPropagation();

      const css = getCssPath(e.target);
      const xpath = getXPath(e.target);

      socket.emit("elementSelected", { css, xpath });
    },
    true
  );

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!doc.__selectionMode) return;
      e.target.style.outline = "2px solid red";
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      if (!doc.__selectionMode) return;
      e.target.style.outline = "";
    },
    true
  );
}
