/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// This is the main implementation to show the tab preview panel.
// See also: /siedbar/tab-preview-tooltip.js

// This script can be loaded in three ways:
//  * REGULAR case:
//    loaded into a public webpage
//  * SIDEBAR case:
//    loaded into the TST sidebar

export default class TabPreviewPanel {
  #panel;
  #root;
  #windowId; // for SIDEBAR case
  #lastTimestamp = 0;

  // https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5
  BASE_PANEL_WIDTH  = 280;
  BASE_PANEL_HEIGHT = 140;
  DATA_URI_BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

  // -moz-platform @media rules looks unavailable on Web contents...
  isWindows = /^Win/i.test(navigator.platform);
  isLinux = /Linux/i.test(navigator.platform);
  isMac = /^Mac/i.test(navigator.platform);

  get styleRules() {
    return `
      .tab-preview-root {
        --tab-preview-panel-show-hide-animation: opacity 0.1s ease-out;
        --tab-preview-panel-scale: 1; /* Web contents may be zoomed by the user, and we need to cancel the zoom effect. */
        background: transparent;
        border: 0 none;
        bottom: 0;
        height: 100%;
        left: 0;
        opacity: 1;
        overflow: hidden;
        pointer-events: none;
        position: fixed;
        right: 0;
        top: 0;
        transition: var(--tab-preview-panel-show-hide-animation);
        width: 100%;
        z-index: ${Number.MAX_SAFE_INTEGER};
      }

      .tab-preview-root:hover {
        opacity: 0;
      }

      .tab-preview-panel {
        /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/toolkit/themes/shared/popup.css#11-63 */
        color-scheme: light dark;

        --panel-background: Menu;
        --panel-color: MenuText;
        --panel-padding-block: calc(4px / var(--tab-preview-panel-scale));
        --panel-padding: var(--panel-padding-block) 0;
        --panel-border-radius: calc(4px / var(--tab-preview-panel-scale));
        --panel-border-color: ThreeDShadow;
        --panel-width: initial;

        --panel-shadow-margin: 0px;
        --panel-shadow: 0px 0px var(--panel-shadow-margin) hsla(0,0%,0%,.2);
        -moz-window-input-region-margin: var(--panel-shadow-margin);
        margin: calc(-1 * var(--panel-shadow-margin));

        /* Panel design token theming */
        --background-color-canvas: var(--panel-background);

        /*@media (-moz-platform: linux) {*/
        ${this.isLinux ? '' : '/*'}
          --panel-border-radius: calc(8px / var(--tab-preview-panel-scale));
          --panel-padding-block: calc(3px / var(--tab-preview-panel-scale));

          @media (prefers-contrast) {
            --panel-border-color: color-mix(in srgb, currentColor 60%, transparent);
          }
        ${this.isLinux ? '' : '*/'}
        /*}*/

        /*@media (-moz-platform: linux) or (-moz-platform: windows) {*/
        ${this.isLinux || this.isWindows ? '' : '/*'}
          --panel-shadow-margin: calc(4px / var(--tab-preview-panel-scale));
        ${this.isLinux || this.isWindows ? '' : '*/'}
        /*}*/

        /* On some linux WMs we need to draw square menus because alpha is not available */
        @media /*(-moz-platform: linux) and*/ (not (-moz-gtk-csd-transparency-available)) {
          ${this.isLinux ? '' : '/*'}
          --panel-shadow-margin: 0px !important;
          --panel-border-radius: 0px !important;
          ${this.isLinux ? '' : '*/'}
        }

        /*@media (-moz-platform: macos) {*/
        ${this.isMac ? '' : '/*'}
          appearance: auto;
          -moz-default-appearance: menupopup;
          background-color: Menu;
          --panel-background: white /* https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/browser/themes/shared/browser-colors.css#89 https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/toolkit/themes/shared/global-shared.css#128 */;
          --panel-border-color: transparent;
          --panel-border-radius: calc(6px / var(--tab-preview-panel-scale));
        ${this.isMac ? '' : '*/'}
        /*}*/

        /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5 */
        --panel-width: min(100%, calc(${this.BASE_PANEL_WIDTH}px / var(--tab-preview-panel-scale)));
        --panel-padding: 0;

        /* https://searchfox.org/mozilla-central/rev/b576bae69c6f3328d2b08108538cbbf535b1b99d/toolkit/themes/shared/global-shared.css#111 */
        /* https://searchfox.org/mozilla-central/rev/b576bae69c6f3328d2b08108538cbbf535b1b99d/browser/themes/shared/browser-colors.css#90 */
        --panel-border-color: light-dark(rgb(240, 240, 244), rgb(82, 82, 94));


        @media (prefers-color-scheme: dark) {
          --panel-background: ${this.isMac ? 'rgb(66, 65, 77)' /* https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/browser/themes/shared/browser-colors.css#89 https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/toolkit/themes/shared/global-shared.css#128 */ : 'var(--dark-popup)'};
          --panel-color: var(--dark-popup-text);
          --panel-border-color: var(--dark-popup-border);
        }

        background: var(--panel-background);
        border: var(--panel-border-color) solid calc(1px / var(--tab-preview-panel-scale));
        border-radius: var(--panel-border-radius);
        box-shadow: var(--panel-shadow);
        box-sizing: border-box;
        color: var(--panel-color);
        direction: ltr;
        font: Message-Box;
        left: auto;
        line-height: 1.5;
        margin-block-start: 0px;
        max-width: var(--panel-width);
        min-width: var(--panel-width);
        opacity: 0;
        overflow: hidden; /* clip the preview with the rounded edges */
        padding: 0;
        pointer-events: none;
        position: fixed;
        right: auto;
        z-index: ${Number.MAX_SAFE_INTEGER};
      }
      .tab-preview-panel.rtl {
        direction: rtl;
      }
      .tab-preview-panel.animation {
        transition: var(--tab-preview-panel-show-hide-animation),
                    left 0.1s ease-out,
                    margin-block-start 0.1s ease-out,
                    right 0.1s ease-out;
      }
      .tab-preview-panel.extended {
        max-width: min(100%, calc(var(--panel-width) * 2));
      }
      .tab-preview-panel.open {
        opacity: 1;
      }
      .tab-preview-panel.animation.updating,
      .tab-preview-panel.animation:not(.open) {
        margin-block-start: 1ch; /* The native tab preview panel "popups up" on the vertical tab bar. */
      }
      /*
      .tab-preview-panel[data-align="left"].updating,
      .tab-preview-panel[data-align="left"]:not(.open) {
        left: -1ch !important;
      }
      .tab-preview-panel[data-align="right"].updating,
      .tab-preview-panel[data-align="right"]:not(.open) {
        right: -1ch !important;
      }
      */

      .tab-preview-panel.extended .tab-preview-title,
      .tab-preview-panel.extended .tab-preview-url,
      .tab-preview-panel.extended .tab-preview-image-container,
      .tab-preview-panel:not(.extended) .tab-preview-extended-content {
        display: none;
      }

      .tab-preview-panel-contents,
      .tab-preview-panel-contents-inner-box {
        max-width: calc(var(--panel-width) - (2px / var(--tab-preview-panel-scale)));
        min-width: calc(var(--panel-width) - (2px / var(--tab-preview-panel-scale)));
      }
      .tab-preview-panel.extended .tab-preview-panel-contents,
      .tab-preview-panel.extended .tab-preview-panel-contents-inner-box {
        max-width: calc(min(100%, calc(var(--panel-width) * 2)) - (2px / var(--tab-preview-panel-scale)));
      }

      .tab-preview-panel-contents {
        max-height: calc(var(--panel-max-height) - (2px / var(--tab-preview-panel-scale)));
      }

      .tab-preview-panel.overflow .tab-preview-panel-contents {
        mask-image: linear-gradient(to top, transparent 0, black 2em);
      }

      .tab-preview-title {
        font-size: calc(1em / var(--tab-preview-panel-scale));
        font-weight: bold;
        margin: var(--panel-border-radius) var(--panel-border-radius) 0;
        max-height: 3em; /* -webkit-line-clamp looks unavailable, so this is a workaround */
        overflow: hidden;
        /* text-overflow: ellipsis; */
        -webkit-line-clamp: 2; /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#15-18 */
      }

      .tab-preview-url {
        font-size: calc(1em / var(--tab-preview-panel-scale));
        margin: 0 var(--panel-border-radius);
        opacity: 0.69; /* https://searchfox.org/mozilla-central/rev/234f91a9d3ebef0d514868701cfb022d5f199cb5/toolkit/themes/shared/design-system/tokens-shared.css#182 */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tab-preview-extended-content {
        font-size: calc(1em / var(--tab-preview-panel-scale));
        margin: var(--panel-border-radius);
        white-space: pre;
      }

      .tab-preview-image-container {
        border-block-start: calc(1px / var(--tab-preview-panel-scale)) solid var(--panel-border-color);
        margin-block-start: 0.25em;
        max-height: calc(var(--panel-width) * ${this.BASE_PANEL_HEIGHT / this.BASE_PANEL_WIDTH}); /* use relative value instead of 140px */
        overflow: hidden;
      }

      .tab-preview-image {
        max-width: 100%;
        opacity: 1;
      }
      .tab-preview-panel.animation:not(.updating) .tab-preview-image {
        transition: opacity 0.2s ease-out;
      }
      .tab-preview-image.loading {
        min-height: ${this.BASE_PANEL_HEIGHT}px;
      }

      .tab-preview-panel.blank,
      .tab-preview-panel .blank,
      .tab-preview-panel.hidden,
      .tab-preview-panel .hidden {
        display: none;
      }

      .tab-preview-panel.loading,
      .tab-preview-panel .loading {
        opacity: 0;
      }

      .tab-preview-panel.updating,
      .tab-preview-panel .updating {
        visibility: hidden;
      }


      /* tree */
      .tab-preview-extended-content ul,
      .tab-preview-extended-content ul ul {
        margin-block: 0;
        margin-inline: 1em 0;
        padding: 0;
        list-style: disc;
      }

      .tab-preview-extended-content .title-line {
        display: flex;
        flex-direction: row;
        max-width: 100%;
        white-space: nowrap;
      }
      .tab-preview-extended-content .title-line .title {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tab-preview-extended-content .title-line .cookieStoreName {
        display: flex;
        margin-inline-start: 1ch;
      }
      .tab-preview-extended-content .title-line .cookieStoreName::before {
        content: "- ";
      }
    `;
  }

  constructor(givenRoot) {
    try {
      this.destroy = this.#destroy.bind(this);
      this.onMessage = this.#onMessage.bind(this);

      this.#root = givenRoot || document.documentElement;
      this.#root.classList.add('tab-preview-root');

      const style = document.createElement('style');
      style.setAttribute('type', 'text/css');
      style.textContent = this.styleRules;
      this.#root.appendChild(style);

      browser.runtime.onMessage.addListener(this.onMessage);
      window.addEventListener('unload', this.destroy, { once: true });
      window.addEventListener('pagehide', this.destroy, { once: true });

      browser.runtime.sendMessage({
        type: 'treestyletab:tab-preview-ready',
      });
    }
    catch (error) {
      console.log('TST Tab Preview Frame fatal error: ', error);
      this.#root = this.onMessage = this.destroy = null;
    }
  }

  #onMessage(message, _sender) {
    if ((this.#windowId &&
     message?.windowId != this.#windowId))
      return;

    if (message?.logging)
      console.log('on message: ', message);

    switch (message?.type) {
      case 'treestyletab:show-tab-preview':
        return (async () => {
          // Simulate the behavior: show tab preview panel with delay
          // only when the panel is not shown yet.
          if (typeof message.waitInitialShowUntil == 'number' &&
          (!this.#panel ||
           !this.#panel.classList.contains('open'))) {
            const delay = Math.max(0, message.waitInitialShowUntil - Date.now());
            if (delay > 0) {
              await new Promise((resolve, _reject) => {
                setTimeout(resolve, delay);
              });
            }
          }
          if (message.timestamp < this.#lastTimestamp) {
            if (message?.logging)
              console.log(`show tab preview(${message.previewTabId}): expired, give up to show/update preview `, message.timestamp);
            return true;
          }
          if (message?.logging)
            console.log(`show tab preview(${message.previewTabId}): invoked, let's show/update preview `, message.timestamp);
          this.#lastTimestamp = message.timestamp;
          this.prepareUI();
          this.updateUI(message);
          this.#panel.classList.add('open');
          return true;
        })();

      case 'treestyletab:hide-tab-preview':
        return (async () => {
          // Ensure the order of messages: "show" for newly hovered tab =>
          // "hide" for previously hovered tab.
          await new Promise(requestAnimationFrame);
          if (!this.#panel ||
          (message.previewTabId &&
           this.#panel.dataset.tabId != message.previewTabId)) {
            if (message?.logging)
              console.log(`hide tab preview(${message.previewTabId}): already hidden, nothing to do `, message.timestamp);
            if (!this.#panel && !message.previewTabId) // on initial case
              this.#lastTimestamp = message.timestamp;
            return;
          }
          if (message.timestamp < this.#lastTimestamp) {
            if (message?.logging)
              console.log(`hide tab preview(${message.previewTabId}): expired, give up to hide preview `, message.timestamp);
            return true;
          }
          if (message?.logging)
            console.log(`hide tab preview(${message.previewTabId}): invoked, let's hide preview `, message.timestamp);
          this.#lastTimestamp = message.timestamp;
          this.#panel.classList.remove('open');
          return true;
        })();

      case 'treestyletab:notify-sidebar-closed':
        if (this.#panel) {
          this.#panel.classList.remove('open');
        }
        break;
    }
  }

  #destroy() {
    if (!this.onMessage)
      return;

    if (this.#panel) {
      this.#panel.parentNode.removeChild(this.#panel);
      this.#panel = null;
    }

    browser.runtime.onMessage.removeListener(this.onMessage);
    window.removeEventListener('unload', this.destroy);
    window.removeEventListener('pagehide', this.destroy);

    this.#root = this.onMessage = this.destroy = null;
  }

  prepareUI() {
    if (this.#panel)
      return;

    const range = document.createRange();
    range.selectNodeContents(this.#root);
    const panelFragment = range.createContextualFragment(`
      <div class="tab-preview-panel">
        <div class="tab-preview-panel-contents">
          <div class="tab-preview-panel-contents-inner-box">
            <div class="tab-preview-title"></div>
            <div class="tab-preview-url"></div>
            <div class="tab-preview-extended-content"></div>
            <div class="tab-preview-image-container">
              <img class="tab-preview-image"/>
            </div>
          </div>
        </div>
      </div>
    `.trim().replace(/>\s+</g, '><'));
    range.detach();
    const preview = panelFragment.querySelector('.tab-preview-image');
    preview.addEventListener('load', () => {
      if (preview.src)
        preview.classList.remove('loading');
    });
    this.#root.appendChild(panelFragment);

    this.#panel = this.#root.querySelector('.tab-preview-panel');
  }

  updateUI({ previewTabId, title, url, tooltipHtml, hasPreview, previewURL, previewTabRect, offsetTop, align, rtl, scale, logging, animation, backgroundColor, borderColor, color, widthInOuterWorld, fixedOffsetTop } = {}) {
    if (!this.#panel)
      return;

    const startAt = this.lastStartedAt = Date.now();

    const hasLoadablePreviewURL = previewURL && /^((https?|moz-extension):|data:image\/[^,]+,.+)/.test(previewURL);
    if (previewURL)
      hasPreview = hasLoadablePreviewURL;

    if (logging)
      console.log('updateUI ', { panel: this.#panel, previewTabId, title, url, tooltipHtml, hasPreview, previewURL, previewTabRect, offsetTop, align, rtl, scale, widthInOuterWorld, fixedOffsetTop });

    this.#panel.classList.add('updating');
    this.#panel.classList.toggle('animation', animation);

    if (backgroundColor) {
      this.#panel.style.setProperty('--panel-background', backgroundColor);
    }
    if (borderColor) {
      this.#panel.style.setProperty('--panel-border-color', borderColor);
    }
    if (color) {
      this.#panel.style.setProperty('--panel-color', color);
    }

    // This cancels the zoom effect by the user.
    // We need to calculate the scale with two devicePixelRatio values
    // from both the sidebar and the content area, because all contents
    // of the browser window can be scaled on a high-DPI display by the
    // platform.
    const isResistFingerprintingMode = window.mozInnerScreenY == window.screenY;
    const devicePixelRatio = window.devicePixelRatio != 1 ?
      window.devicePixelRatio : // devicePixelRatio is always available on macOS with Retina
      ((widthInOuterWorld || window.innerWidth) / window.innerWidth);
    if (logging)
      console.log('updateUI: isResistFingerprintingMode ', isResistFingerprintingMode, { devicePixelRatio });
    // But window.devicePixelRatio is not available if privacy.resistFingerprinting=true,
    // thus we need to calculate it based on tabs.Tab.width.
    scale = devicePixelRatio * (scale || 1);
    this.#root.style.setProperty('--tab-preview-panel-scale', scale);
    const panelWidth = Math.min(window.innerWidth, this.BASE_PANEL_WIDTH / scale);
    this.#panel.style.setProperty('--panel-width', `${panelWidth}px`);

    const offsetFromWindowEdge = isResistFingerprintingMode ?
      0 :
      (window.mozInnerScreenY - window.screenY) * scale;
    const sidebarContentsOffset = isResistFingerprintingMode ?
      (fixedOffsetTop || 0) :
      (offsetTop - offsetFromWindowEdge) / scale;

    if (previewTabRect) {
      const panelTopEdge = this.#windowId ? previewTabRect.bottom : previewTabRect.top;
      const panelBottomEdge = this.#windowId ? previewTabRect.bottom : previewTabRect.top;
      const panelMaxHeight = Math.max(window.innerHeight - panelTopEdge - sidebarContentsOffset, panelBottomEdge);
      this.#panel.style.maxHeight = `${panelMaxHeight}px`;
      this.#panel.style.setProperty('--panel-max-height', `${panelMaxHeight}px`);
      if (logging)
        console.log('updateUI: limit panel height to ', this.#panel.style.maxHeight, { previewTabRect, maxHeight: window.innerHeight, sidebarContentsOffset, offsetFromWindowEdge, fixedOffsetTop });
    }

    this.#panel.dataset.tabId = previewTabId;
    if (align)
      this.#panel.dataset.align = align;

    this.#panel.classList.toggle('rtl', !!rtl);

    const previewImage = this.#panel.querySelector('.tab-preview-image');
    previewImage.classList.toggle('blank', !hasPreview && !hasLoadablePreviewURL);
    if (!previewURL ||
      (previewURL &&
       previewURL != previewImage.src)) {
      previewImage.classList.add('loading');
      previewImage.src = previewURL || this.DATA_URI_BLANK_PNG;
    }

    if (tooltipHtml) {
      const extendedContent = this.#panel.querySelector('.tab-preview-extended-content');
      extendedContent.innerHTML = tooltipHtml;
      this.#panel.classList.add('extended');
    }

    if (typeof title == 'string' ||
      typeof url == 'string') {
      const titleElement = this.#panel.querySelector('.tab-preview-title');
      titleElement.textContent = title;
      const urlElement = this.#panel.querySelector('.tab-preview-url');
      urlElement.textContent = url;
      urlElement.classList.toggle('blank', !url);
      this.#panel.classList.remove('extended');
    }

    const completeUpdate = () => {
      previewImage.removeEventListener('load', completeUpdate);
      previewImage.removeEventListener('error', completeUpdate);

      if (this.#panel.dataset.tabId != previewTabId ||
        this.lastStartedAt != startAt)
        return;

      if (!previewTabRect) {
        this.#panel.classList.remove('updating');
        if (logging)
          console.log('updateUI/completeUpdate: no tab rect, no need to update the position');
        return;
      }

      const panelBox = this.#panel.getBoundingClientRect();
      if (!panelBox.height &&
        completeUpdate.retryCount++ < 10) {
        if (logging)
          console.log('updateUI/completeUpdate: panel size is zero, retrying ', completeUpdate.retryCount);
        requestAnimationFrame(completeUpdate);
        return;
      }

      const maxY = window.innerHeight / scale;
      const panelHeight = panelBox.height;

      const contentsHeight = this.#panel.querySelector('.tab-preview-panel-contents-inner-box').getBoundingClientRect().height;
      this.#panel.classList.toggle('overflow', contentsHeight > panelHeight);
      if (logging)
        console.log('updateUI/completeUpdate: overflow: ', contentsHeight, '>', panelHeight);

      let top;
      if (this.#windowId) { // in-sidebar
        if (logging)
          console.log('updateUI/completeUpdate: in-sidebar, alignment calculating: ', { half: window.innerHeight, maxY, scale, previewTabRect });
        if (previewTabRect.top > (window.innerHeight / 2)) { // align to bottom edge of the tab
          top = `${Math.min(maxY, previewTabRect.bottom / scale) - panelHeight - previewTabRect.height}px`;
          if (logging)
            console.log(' => align to bottom edge of the tab, top=', top);
        }
        else { // align to top edge of the tab
          top = `${Math.max(0, previewTabRect.top / scale) + previewTabRect.height}px`;
          if (logging)
            console.log(' => align to top edge of the tab, top=', top);
        }

        if (logging)
          console.log(' => top=', top);
      }
      else { // in-content
      // We need to shift the position with the height of the sidebar header.
        const alignToTopPosition = Math.max(0, previewTabRect.top / scale) + sidebarContentsOffset;
        const alignToBottomPosition = Math.min(maxY, previewTabRect.bottom + sidebarContentsOffset / scale) - panelHeight;

        if (logging)
          console.log('updateUI/completeUpdate: in-content, alignment calculating: ', { offsetFromWindowEdge, sidebarContentsOffset, alignToTopPosition, panelHeight, maxY, scale });
        if (alignToTopPosition + panelHeight >= maxY &&
          alignToBottomPosition >= 0) { // align to bottom edge of the tab
          top = `${alignToBottomPosition}px`;
          if (logging)
            console.log(' => align to bottom edge of the tab, top=', top);
        }
        else { // align to top edge of the tab
          top = `${alignToTopPosition}px`;
          if (logging)
            console.log(' => align to top edge of the tab, top=', top);
        }
      }
      // updateUI() may be called multiple times for a target tab
      // (with/without previewURL), so we should not set positions again
      // if not needed. Otherwise the animation may be canceled in middle.
      if (top &&
        this.#panel.style.top != top) {
        this.#panel.style.top = top;
      }

      let left, right;
      if (align == 'left') {
        left  = 'var(--panel-shadow-margin)';
        right = '';
      }
      else {
        left  = '';
        right = 'var(--panel-shadow-margin)';
      }
      if (this.#panel.style.left != left) {
        this.#panel.style.left = left;
      }
      if (this.#panel.style.right != right) {
        this.#panel.style.right = right;
      }

      this.#panel.classList.remove('updating');
    };
    completeUpdate.retryCount = 0;

    if (!hasPreview) {
      if (logging)
        console.log('updateUI: no preview, complete now');
      completeUpdate();
      return;
    }

    try {
      const { width, height } = !previewImage.src || previewImage.src == this.DATA_URI_BLANK_PNG ?
        { width: this.BASE_PANEL_WIDTH, height: this.BASE_PANEL_HEIGHT } :
        this.getPngDimensionsFromDataUri(previewURL);
      if (logging)
        console.log('updateUI: determined preview size: ', { width, height });
      const imageWidth = Math.min(window.innerWidth, Math.min(width, this.BASE_PANEL_WIDTH) / scale);
      const imageHeight = imageWidth / width * height;
      previewImage.style.width = previewImage.style.maxWidth = `min(100%, ${imageWidth}px)`;
      previewImage.style.height = previewImage.style.maxHeight = `${imageHeight}px`;
      requestAnimationFrame(completeUpdate);
      return;
    }
    catch (error) {
      if (logging)
        console.log('updateUI: could not detemine preview size ', error, previewURL);
    }

    // failsafe: if it is not a png or failed to get dimensions, give up to determine the image size before loading.
    previewImage.style.width =
    previewImage.style.height =
    previewImage.style.maxWidth =
    previewImage.style.maxHeight = '';
    previewImage.addEventListener('load', completeUpdate, { once: true });
    previewImage.addEventListener('error', completeUpdate, { once: true });
  }

  getPngDimensionsFromDataUri(uri) {
    if (!/^data:image\/png;base64,/i.test(uri))
      throw new Error('impossible to parse as PNG image data ', uri);

    const base64Data = uri.split(',')[1];
    const binaryData = atob(base64Data);
    const byteArray = new Uint8Array(binaryData.length);
    const requiredScanSize = Math.min(binaryData.length, 24);
    for (let i = 0; i < requiredScanSize; i++) {
      byteArray[i] = binaryData.charCodeAt(i);
    }
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < pngSignature.length; i++) {
      if (byteArray[i] !== pngSignature[i])
        throw new Error('invalid PNG header');
    }
    const width =
    (byteArray[16] << 24) |
    (byteArray[17] << 16) |
    (byteArray[18] << 8) |
    byteArray[19];
    const height =
    (byteArray[20] << 24) |
    (byteArray[21] << 16) |
    (byteArray[22] << 8) |
    byteArray[23];
    return { width, height };
  }


  // for SIDEBAR case
  set windowId(id) {
    return this.#windowId = id;
  }
  get windowId() {
    return this.#windowId;
  }

  // for SIDEBAR case
  handleMessage(message) {
    return this.onMessage(message);
  }

  getColors() {
    this.prepareUI();

    const style = window.getComputedStyle(this.#panel, null);
    try {
    // Computed style's colors may be unexpected value if the element
    // is not rendered on the screen yet and it has colors for light
    // and dark schemes. So we need to get preferred colors manually.
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      return {
        backgroundColor: this.getPreferredColor(style.getPropertyValue('--panel-background'), { isDark }),
        borderColor: this.getPreferredColor(style.getPropertyValue('--panel-border-color'), { isDark }),
        color: this.getPreferredColor(style.getPropertyValue('--panel-color'), { isDark }),
      };
    }
    catch(_error) {
    }
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
    };
  }

  // Parse light-dark(<light color>, <dark color>) and return preferred color
  getPreferredColor(color, { isDark } = {}) {
    if (!color.startsWith('light-dark('))
      return color;

    const values = [];
    let buffer = '';
    let inParenCount = 0;
    color = color.substring(11); // remove "light-dark(" prefix
    ColorParse:
    for (let i = 0, maxi = color.length; i < maxi; i++) {
      const character = color.charAt(i);
      switch (character) {
        case '(':
          inParenCount++;
          buffer += character;
          break;

        case ')':
          inParenCount--;
          if (inParenCount < 0) {
            values.push(buffer);
            buffer = '';
            break ColorParse;
          }
          buffer += character;
          break;

        case ',':
          if (inParenCount > 0) {
            buffer += character;
          }
          else {
            values.push(buffer);
            buffer = '';
          }
          break;

        default:
          buffer += character;
          break;
      }
    }

    if (typeof isDark != 'boolean')
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return isDark ? values[1] : values[0];
  }
}
