/**
 * Shifting Tiles Gallery
 * Modern Vanilla JS Implementation (Zero Dependencies)
 */
class ShiftingTiles {
  constructor(elementOrSelector, images, options) {
    this.where = typeof elementOrSelector === "string" 
      ? document.querySelector(elementOrSelector) 
      : elementOrSelector;
      
    if (!this.where) {
      console.error("ShiftingTiles: Target element not found", elementOrSelector);
      return;
    }
    
    this.images = images;
    this.settings = Object.assign({
      duration: 5000,
      rows: 2,
      tileSize: 3,
      bounce: 15,
      bounceDuration: 800
    }, options);
    
    this.timeout = null;
    this.TILE_SIZES = {
      1: { single: 16, dual: 8 },  // small
      2: { single: 24, dual: 12 },
      3: { single: 40, dual: 20 }, // medium (default)
      4: { single: 50, dual: 25 },
      5: { single: 80, dual: 40 }  // extra large
    };

    // Save instance reference on the DOM element for external control
    this.where._shiftingtiles = this;

    this.setupListeners();
    this.buildGrid();
    this.start();
  }

  setupListeners() {
    // Native event delegation for animationend
    this.where.addEventListener("animationend", (e) => {
      const target = e.target;
      
      // If a row animation ended inside a leave parent
      if (target.classList.contains("row") && target.parentElement.classList.contains("leave")) {
        target.parentElement.classList.add("left");
        target.parentElement.classList.remove("leave");
      }
      
      // If a tile disappear animation ended
      if (target.classList.contains("disappear")) {
        target.style.display = "none";
        target.remove();
        this.where.dispatchEvent(new CustomEvent("st-animate-after"));
      }
    });

    // Keydown handler on body (Space to shift, Up to leave)
    if (window._stKeyHandler) {
      document.body.removeEventListener("keydown", window._stKeyHandler);
    }
    window._stKeyHandler = (e) => {
      if (e.keyCode === 32) { // Space
        this.frame();
        e.preventDefault();
      }
      if (e.keyCode === 38) { // Up
        this.where.classList.toggle("leave");
      }
    };
    document.body.addEventListener("keydown", window._stKeyHandler);
  }

  source() {
    if (typeof this.images.bottom === "undefined") {
      this.images.bottom = 0;
    }

    const index = this.images.bottom + Math.floor((this.images.length - this.images.bottom) * Math.random());
    const one = this.images.splice(index, 1)[0];
    this.images.unshift(one);

    this.images.bottom++;

    if (this.images.bottom === this.images.length) {
      this.images.bottom = 0;
      this.where.dispatchEvent(new CustomEvent("st-galleryrestart"));
    }

    return one;
  }

  image(element) {
    const item = this.source();
    if (!item) return;
    const src = item.src;
    const focalX = (item.focal && typeof item.focal.x === "number") ? item.focal.x : 0.5;
    const focalY = (item.focal && typeof item.focal.y === "number") ? item.focal.y : 0.5;
    const focalXPct = focalX * 100;
    const focalYPct = focalY * 100;

    element.style.backgroundImage = "url(" + src + ")";
    element.style.backgroundPosition = focalXPct + "% " + focalYPct + "%";
    element.classList.remove("pan-wide");
    element.style.setProperty("--pan-y", focalYPct + "%");
    element.style.setProperty("--pan-start-x", Math.min(100, focalXPct + 25) + "%");
    element.style.setProperty("--pan-end-x", Math.max(0, focalXPct - 25) + "%");

    if (item.aspect && item.aspect > (16 / 9)) {
      element.classList.add("pan-wide");
    }
  }

  addImage(node) {
    if (node.classList.contains("single")) {
      this.image(node);
    } else if (node.classList.contains("dual")) {
      Array.from(node.children).forEach(child => {
        this.image(child);
      });
    } else {
      this.image(node);
    }
    return node;
  }

  buildGrid() {
    this.where.innerHTML = "";
    this.where.classList.add("shiftingtiles");

    const sizeConfig = this.TILE_SIZES[this.settings.tileSize || 3];
    const disappearDuration = Math.min(1.5, Math.max(0.3, this.settings.duration / 5000)) + 's';

    this.where.style.setProperty('--row-height', (100 / this.settings.rows) + '%');
    this.where.style.setProperty('--single-width', (sizeConfig.single / 2) + '%');
    this.where.style.setProperty('--dual-width', (sizeConfig.dual / 2) + '%');
    this.where.style.setProperty('--disappear-duration', disappearDuration);
    this.where.style.setProperty('--bounce-size', this.settings.bounce + 'px');
    this.where.style.setProperty('--bounce-size-small', Math.round(this.settings.bounce / 2) + 'px');
    this.where.style.setProperty('--bounce-duration', (this.settings.bounceDuration / 1000) + 's');

    for (let r = 0; r < this.settings.rows; r++) {
      const row = document.createElement("div");
      row.className = "row";
      this.where.appendChild(row);

      let currentWidth = 0;
      const singlePercent = sizeConfig.single / 2;
      const dualPercent = sizeConfig.dual / 2;

      while (currentWidth < 60) {
        const isSingle = Math.random() > 0.4;
        if (isSingle) {
          const singleTile = document.createElement("div");
          singleTile.className = "single";
          row.appendChild(singleTile);
          currentWidth += singlePercent;
        } else {
          const dualTile = document.createElement("div");
          dualTile.className = "dual";
          dualTile.innerHTML = "<div></div><div></div>";
          row.appendChild(dualTile);
          currentWidth += dualPercent;
        }
      }
    }

    const loading = document.createElement("div");
    loading.className = "loading";
    loading.textContent = "Loading Photos...";
    this.where.appendChild(loading);

    // Add images to all tiles
    const tiles = this.where.querySelectorAll(".single, .dual > div");
    tiles.forEach(tile => {
      this.addImage(tile);
    });
  }

  frame() {
    clearTimeout(this.timeout);
    
    // Select all single (not last-child) and dual (not last-child) elements natively
    const rows = this.where.querySelectorAll(".row");
    const eligibleBoxes = [];
    
    rows.forEach(row => {
      const children = Array.from(row.children);
      if (children.length > 1) {
        for (let i = 0; i < children.length - 1; i++) {
          const child = children[i];
          if (child.classList.contains("single") || child.classList.contains("dual")) {
            eligibleBoxes.push(child);
          }
        }
      }
    });

    if (eligibleBoxes.length === 0) {
      this.timeout = setTimeout(() => this.frame(), this.settings.duration);
      return;
    }

    const disappear = eligibleBoxes[Math.floor(Math.random() * eligibleBoxes.length)];
    const parentRow = disappear.parentElement;

    // Trigger before event
    this.where.dispatchEvent(new CustomEvent("st-animate-before", { detail: { element: disappear } }));

    // Clone element, fill it with new images, and append to the parent row
    const clone = disappear.cloneNode(true);
    this.addImage(clone);
    parentRow.appendChild(clone);

    // Add disappear class
    disappear.classList.add("disappear");

    // Trigger animate event
    this.where.dispatchEvent(new CustomEvent("st-animate", { detail: { element: disappear } }));

    this.timeout = setTimeout(() => this.frame(), this.settings.duration);
  }

  start() {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.frame(), this.settings.duration);
  }

  update(newOptions) {
    const oldRows = this.settings.rows;
    const oldSize = this.settings.tileSize;
    const oldDuration = this.settings.duration;

    Object.assign(this.settings, newOptions);

    const sizeConfig = this.TILE_SIZES[this.settings.tileSize || 3];
    const disappearDuration = Math.min(1.5, Math.max(0.3, this.settings.duration / 5000)) + 's';

    this.where.style.setProperty('--row-height', (100 / this.settings.rows) + '%');
    this.where.style.setProperty('--single-width', (sizeConfig.single / 2) + '%');
    this.where.style.setProperty('--dual-width', (sizeConfig.dual / 2) + '%');
    this.where.style.setProperty('--disappear-duration', disappearDuration);
    this.where.style.setProperty('--bounce-size', this.settings.bounce + 'px');
    this.where.style.setProperty('--bounce-size-small', Math.round(this.settings.bounce / 2) + 'px');
    this.where.style.setProperty('--bounce-duration', (this.settings.bounceDuration / 1000) + 's');

    if (this.settings.rows !== oldRows || this.settings.tileSize !== oldSize) {
      this.buildGrid();
    }

    if (this.settings.duration !== oldDuration) {
      this.start();
    }
  }
}
