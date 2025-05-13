/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// This script can be loaded in three ways:
//  * REGULAR case:
//    loaded into a public webpage
//  * SIDEBAR case:
//    loaded into the TST sidebar

export default class TabGroupMenuPanel {
  #panel;
  #root;
  #windowId; // for SIDEBAR case
  #lastTimestamp = 0;
  #lastTimestampForGroup= new Map();
  #i18n;

  // https://searchfox.org/mozilla-central/source/browser/themes/shared/tabbrowser/tabs.css#1143
  BASE_PANEL_WIDTH = '22em';

  // -moz-platform @media rules looks unavailable on Web contents...
  isWindows = /^Win/i.test(navigator.platform);
  isLinux = /Linux/i.test(navigator.platform);
  isMac = /^Mac/i.test(navigator.platform);

  get styleRules() {
    return `
      .tab-group-menu-root {
        --tab-group-menu-panel-show-hide-animation: opacity 0.1s ease-out;
        --tab-group-menu-panel-scale: 1; /* Web contents may be zoomed by the user, and we need to cancel the zoom effect. */
        --max-32bit-integer: 2147483647;
        background: transparent;
        border: 0 none;
        height: 0;
        left: 0;
        opacity: 1;
        overflow: visible;
        position: fixed;
        right: 0;
        top: 0;
        transition: var(--tab-group-menu-panel-show-hide-animation);
        width: 0;
        z-index: var(--max-32bit-integer);
      }

      .tab-group-menu-panel {
        /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/toolkit/themes/shared/popup.css#11-63 */
        color-scheme: light dark;

        --panel-background: Menu;
        --panel-color: MenuText;
        --panel-padding-block: calc(4px / var(--tab-group-menu-panel-scale));
        --panel-padding: var(--panel-padding-block) 0;
        --panel-border-radius: calc(4px / var(--tab-group-menu-panel-scale));
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
          --panel-border-radius: calc(8px / var(--tab-group-menu-panel-scale));
          --panel-padding-block: calc(3px / var(--tab-group-menu-panel-scale));

          @media (prefers-contrast) {
            --panel-border-color: color-mix(in srgb, currentColor 60%, transparent);
          }
        ${this.isLinux ? '' : '*/'}
        /*}*/

        /*@media (-moz-platform: linux) or (-moz-platform: windows) {*/
        ${this.isLinux || this.isWindows ? '' : '/*'}
          --panel-shadow-margin: calc(4px / var(--tab-group-menu-panel-scale));
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
          --panel-border-radius: calc(6px / var(--tab-group-menu-panel-scale));
        ${this.isMac ? '' : '*/'}
        /*}*/

        /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5 */
        --panel-width: min(100%, calc(${this.BASE_PANEL_WIDTH} / var(--tab-group-menu-panel-scale)));
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
        border: var(--panel-border-color) solid calc(1px / var(--tab-group-menu-panel-scale));
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
        padding: 0;
        position: fixed;
        right: auto;
        z-index: var(--max-32bit-integer);

        &:not(.open) {
          pointer-events: none;
        }
        &.rtl {
          direction: rtl;
        }
        &.animation {
          transition: var(--tab-group-menu-panel-show-hide-animation),
                      left 0.1s ease-out,
                      margin-block-start 0.1s ease-out,
                      right 0.1s ease-out;
        }
        &.open {
          opacity: 1;
        }

        &.updating,
        & .updating {
          visibility: hidden;
        }
      }

      .tab-group-menu-panel-contents/*,
      .tab-group-menu-panel-contents-inner-box*/ {
        max-width: calc(var(--panel-width) - (2px / var(--tab-group-menu-panel-scale)));
        min-width: calc(var(--panel-width) - (2px / var(--tab-group-menu-panel-scale)));
      }

      .tab-group-menu-panel-contents {
        max-height: calc(var(--panel-max-height) - (2px / var(--tab-group-menu-panel-scale)));
      }


      /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/browser/themes/shared/tabbrowser/tabs.css#1145 */
      .tab-group-menu-panel {
        /* https://searchfox.org/mozilla-central/rev/7d73613454bfe426fdceb635b33cd3061a69def4/toolkit/themes/shared/design-system/tokens-shared.css#266 */
        /** Size **/
        --size-item-small: 16px;
        --size-item-medium: 28px;
        --size-item-large: 32px;

        /* https://searchfox.org/mozilla-central/rev/7d73613454bfe426fdceb635b33cd3061a69def4/toolkit/themes/shared/design-system/tokens-shared.css#271 */
        /** Space **/
        --space-xxsmall: calc(0.5 * var(--space-xsmall)); /* 2px */
        --space-xsmall: 0.267rem; /* 4px */
        --space-small: calc(2 * var(--space-xsmall)); /* 8px */
        --space-medium: calc(3 * var(--space-xsmall)); /* 12px */
        --space-large: calc(4 * var(--space-xsmall)); /* 16px */
        --space-xlarge: calc(6 * var(--space-xsmall)); /* 24px */
        --space-xxlarge: calc(8 * var(--space-xsmall)); /* 32px */

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/browser/themes/shared/customizableui/panelUI-shared.css#20 */
        --panel-separator-margin-vertical: 4px;

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-shared.css#107 */
        /** Color **/
        --color-blue-20: oklch(83% 0.17 260);
        --color-blue-60: oklch(55% 0.24 260);
        --color-blue-70: oklch(48% 0.2 260);
        --color-blue-80: oklch(41% 0.17 260);
        --color-cyan-10: oklch(90% 0.07 205);
        --color-cyan-20: oklch(83% 0.11 205);
        --color-cyan-30: oklch(76% 0.14 205);
        --color-cyan-70: oklch(48% 0.2 205);
        --color-gray-05: #fbfbfe;
        --color-gray-100: #15141a;
        --color-green-20: oklch(83% 0.14 145);
        --color-green-70: oklch(48% 0.2 145);
        --color-orange-20: oklch(86% 0.14 50);
        --color-orange-70: oklch(48% 0.20 50);
        --color-pink-20: oklch(83% 0.14 360);
        --color-pink-70: oklch(48% 0.2 360);
        --color-purple-20: oklch(83% 0.14 315);
        --color-purple-70: oklch(48% 0.2 315);
        --color-red-20: oklch(83% 0.14 15);
        --color-red-70: oklch(48% 0.2 15);
        --color-white: #ffffff;
        --color-yellow-20: oklch(86% 0.14 90);
        --color-yellow-70: oklch(51% 0.23 90);

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-platform.css#31 */
        --color-accent-primary: AccentColor;

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-shared.css#226 */
        /** Focus Outline **/
        --focus-outline: var(--focus-outline-width) solid var(--focus-outline-color);
        --focus-outline-color: var(--color-accent-primary);
        --focus-outline-inset: calc(-1 * var(--focus-outline-width));
        --focus-outline-offset: 2px;
        --focus-outline-width: 2px;

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-shared.css#20 */
        /** Border **/
        --border-color-card: color-mix(in srgb, currentColor 10%, transparent);
        --border-color-interactive-hover: var(--border-color-interactive);
        --border-color-interactive-active: var(--border-color-interactive);
        --border-color-interactive-disabled: var(--border-color-interactive);
        --border-radius-circle: 9999px;
        --border-radius-small: 4px;
        --border-radius-medium: 8px;
        --border-width: 1px;

        /* https://searchfox.org/mozilla-central/rev/7d73613454bfe426fdceb635b33cd3061a69def4/browser/themes/shared/tabbrowser/tabs.css#79 */
        --tab-group-color-blue: var(--color-blue-70);
        --tab-group-color-blue-invert: var(--color-blue-20);
        --tab-group-color-purple: var(--color-purple-70);
        --tab-group-color-purple-invert: var(--color-purple-20);
        --tab-group-color-cyan: var(--color-cyan-70);
        --tab-group-color-cyan-invert: var(--color-cyan-20);
        --tab-group-color-orange: var(--color-orange-70);
        --tab-group-color-orange-invert: var(--color-orange-20);
        --tab-group-color-yellow: var(--color-yellow-70);
        --tab-group-color-yellow-invert: var(--color-yellow-20);
        --tab-group-color-pink: var(--color-pink-70);
        --tab-group-color-pink-invert: var(--color-pink-20);
        --tab-group-color-green: var(--color-green-70);
        --tab-group-color-green-invert: var(--color-green-20);
        --tab-group-color-red: var(--color-red-70);
        --tab-group-color-red-invert: var(--color-red-20);
        --tab-group-color-gray: #5E6A77;
        --tab-group-color-gray-invert: #99A6B4;

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-shared.css#286 */
        --text-color-error: light-dark(var(--color-red-70), var(--color-red-20));

        input[value="blue"] {
          --tabgroup-swatch-color: var(--tab-group-color-blue);
          --tabgroup-swatch-color-invert: var(--tab-group-color-blue-invert);
        }
        input[value="purple"] {
          --tabgroup-swatch-color: var(--tab-group-color-purple);
          --tabgroup-swatch-color-invert: var(--tab-group-color-purple-invert);
        }
        input[value="cyan"] {
          --tabgroup-swatch-color: var(--tab-group-color-cyan);
          --tabgroup-swatch-color-invert: var(--tab-group-color-cyan-invert);
        }
        input[value="orange"] {
          --tabgroup-swatch-color: var(--tab-group-color-orange);
          --tabgroup-swatch-color-invert: var(--tab-group-color-orange-invert);
        }
        input[value="yellow"] {
          --tabgroup-swatch-color: var(--tab-group-color-yellow);
          --tabgroup-swatch-color-invert: var(--tab-group-color-yellow-invert);
        }
        input[value="pink"] {
          --tabgroup-swatch-color: var(--tab-group-color-pink);
          --tabgroup-swatch-color-invert: var(--tab-group-color-pink-invert);
        }
        input[value="green"] {
          --tabgroup-swatch-color: var(--tab-group-color-green);
          --tabgroup-swatch-color-invert: var(--tab-group-color-green-invert);
        }
        input[value="red"] {
          --tabgroup-swatch-color: var(--tab-group-color-red);
          --tabgroup-swatch-color-invert: var(--tab-group-color-red-invert);
        }
        input[value="gray"] {
          --tabgroup-swatch-color: var(--tab-group-color-gray);
          --tabgroup-swatch-color-invert: var(--tab-group-color-gray-invert);
        }

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/popup.css#63 */
        .tab-group-menu-panel-contents-inner-box {
          padding: var(--panel-padding);
        }

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/browser/themes/shared/tabbrowser/tabs.css#37 */
        --tab-hover-background-color: color-mix(in srgb, currentColor 11%, transparent);

        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-brand.css#23 */
        --button-background-color: color-mix(in srgb, currentColor 7%, transparent);
        --button-background-color-hover: color-mix(in srgb, currentColor 14%, transparent);
        --button-background-color-active: color-mix(in srgb, currentColor 21%, transparent);
        --button-text-color: light-dark(var(--color-gray-100), var(--color-gray-05));
        --button-text-color-primary: light-dark(var(--color-white), var(--color-gray-100));
        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-brand.css#30 */
        --color-accent-primary: light-dark(var(--color-blue-60), var(--color-cyan-30));
        --color-accent-primary-hover: light-dark(var(--color-blue-70), var(--color-cyan-20));
        --color-accent-primary-active: light-dark(var(--color-blue-80), var(--color-cyan-10));
        /* https://searchfox.org/mozilla-central/rev/126697140e711e04a9d95edae537541c3bde89cc/toolkit/themes/shared/design-system/tokens-shared.css#99 */
        --button-text-color-primary-hover: var(--button-text-color-primary);
        --button-text-color-primary-active: var(--button-text-color-primary-hover);
        --button-text-color-primary-disabled: var(--button-text-color-primary);


        --panel-width: 22em;
        --panel-padding: var(--space-large);
        --panel-separator-margin: var(--panel-separator-margin-vertical) 0;
        font: menu;

        .panel-header {
          min-height: auto;
          > h1 {
            text-align: center;
            font: menu;
            font-weight: bold;

            margin-top: 0;
          }
        }

        hr /*toolbarseparator*/ {
          margin-block: var(--space-medium);
          border: 1px solid;
          border-width: 1px 0 0 0;
          opacity: 0.5;
        }

        .panel-body {
          padding-block: var(--space-medium);
        }

        &.tab-group-editor-mode-create .tab-group-edit-mode-only,
        &:not(.tab-group-editor-mode-create) .tab-group-create-mode-only {
          display: none;
        }

        .tab-group-editor-name > label {
          display: flex;
          flex-direction: column;
          > label {
            margin-inline: 0;
            margin-bottom: var(--space-small);
          }
          > input[type="text"] {
            padding: var(/*--space-medium*/--space-xsmall);
          }
        }

        .tab-group-editor-swatches {
          display: flex;
          flex-flow: row nowrap;
          justify-content: space-between;

          #tabGroupContextMenuRoot & {
            flex-flow: row wrap;
            justify-content: flex-start;
          }
        }

        .tab-group-editor-swatch {
          appearance: none;
          box-sizing: content-box;
          margin: 0;

          font-size: 0;
          width: 16px;
          height: 16px;
          padding: var(--focus-outline-offset);
          border: var(--focus-outline-width) solid transparent;
          border-radius: var(--border-radius-medium);
          background-clip: content-box;
          background-color: light-dark(var(--tabgroup-swatch-color), var(--tabgroup-swatch-color-invert));

          &:checked {
            border-color: var(--focus-outline-color);
          }

          &:disabled {
            opacity: 0.5;
          }

          &:focus-visible {
            outline: 1px solid var(--focus-outline-color);
            outline-offset: 1px;
          }

          + .label-text {
            font-size: 0;
          }
        }

        .tab-group-edit-actions,
        .tab-group-delete {
          padding-block: 0;
          > button /*toolbarbutton*/ {
           appearance: none;
           background: transparent;
           border: none;
           border-radius: var(--space-xsmall);
           display: block;
           font: menu;
           margin: 0;
           padding: var(--space-small);
           text-align: start;
           width: 100%;

           justify-content: flex-start;

           &:hover {
             background-color: var(--tab-hover-background-color);
           }

           &:focus {
             box-shadow: none;
           }
          }
        }

        /* cancel /resources/base.css */
        input:focus {
          box-shadow: none;
        }
      }

      .tab-group-editor-panel.tab-group-editor-panel-expanded {
        --panel-width: 25em;
      }

      @media not (prefers-contrast) {
        .tabGroupEditor_deleteGroup {
          .label-text {
            color: var(--text-color-error);
          }
        }
      }

      .tab-group-create-actions {
        text-align: right;

        button {
          appearance: none;
          border-radius: var(--space-xsmall);
          margin-inline: var(--space-small);
          padding: var(--space-small);

          &.primary {
            color: var(--button-text-color-primary);
            background-color: var(--color-accent-primary);
            &:hover {
              color: var(--button-text-color-primary-hover);
              background-color: var(--color-accent-primary-hover);
            }
            &:hover:active,
            &[open] {
              color: var(--button-text-color-primary-active);
              background-color: var(--color-accent-primary-active);
            }
          }

          &:focus {
            box-shadow: none;
          }
        }
      }
    `;
  }

  constructor(givenRoot, i18n) {
    try {
      this.destroy = this.#destroy.bind(this);
      this.onMessage = this.#onMessage.bind(this);

      this.#i18n = i18n;

      this.#root = givenRoot || document.documentElement;
      this.#root.classList.add('tab-group-menu-root');

      const style = document.createElement('style');
      style.setAttribute('type', 'text/css');
      style.textContent = this.styleRules;
      this.#root.appendChild(style);

      browser.runtime.onMessage.addListener(this.onMessage);
      window.addEventListener('unload', this.destroy, { once: true });
      window.addEventListener('pagehide', this.destroy, { once: true });

      browser.runtime.sendMessage({
        type: 'treestyletab:tab-group-menu:ready',
      });
    }
    catch (error) {
      console.log('TST Tab Group Menu Panel fatal error: ', error);
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
      case 'treestyletab:tab-group-menu:show':
        return (async () => {
          if (message.timestamp < this.#lastTimestamp ||
              message.timestamp < (this.#lastTimestampForGroup.get(message.groupId) || 0)) {
            if (message?.logging)
              console.log(`show tab group menu(${message.groupId}): expired, give up to show/update menu `, message.timestamp);
            return true;
          }
          if (message?.logging)
            console.log(`show tab group menu(${message.groupId}): invoked, let's show/update menu `, message.timestamp);
          this.#lastTimestamp = message.timestamp;
          this.#lastTimestampForGroup.set(message.groupId, message.timestamp);
          this.prepareUI();
          this.updateUI(message);
          this.#panel.classList.add('open');
          return true;
        })();

      case 'treestyletab:tab-group-menu:hide-if-shown':
        if (!this.#panel ||
            (message.groupId &&
             this.#panel.dataset.groupId != message.groupId) ||
            !this.#panel.classList.contains('open')) {
          return;
        }
      case 'treestyletab:tab-group-menu:hide':
        return (async () => {
          // Ensure the order of messages: "show" for newly hovered tab =>
          // "hide" for previously hovered tab.
          await new Promise(requestAnimationFrame);
          if (!this.#panel ||
              (message.groupId &&
               this.#panel.dataset.groupId != message.groupId)) {
            if (message?.logging)
              console.log(`hide tab group menu(${message.groupId}): already hidden, nothing to do `, message.timestamp);
            if (!this.#panel && !message.groupId) { // on initial case
              this.#lastTimestamp = message.timestamp;
            }
            if (message.groupId) {
              this.#lastTimestampForGroup.set(message.groupId, message.timestamp);
            }
            return;
          }
          if (message.timestamp < this.#lastTimestamp ||
              (message.groupId &&
               message.timestamp < (this.#lastTimestampForGroup.get(message.groupId) || 0))) {
            if (message?.logging)
              console.log(`hide tab group menu(${message.groupId}): expired, give up to hide menu `, message.timestamp);
            return true;
          }
          if (message?.logging)
            console.log(`hide tab group menu(${message.groupId}): invoked, let's hide menu `, message.timestamp);
          this.#lastTimestamp = message.timestamp;
          if (message.groupId) {
            this.#lastTimestampForGroup.set(message.groupId, message.timestamp);
          }
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

    this.#lastTimestampForGroup.clear();
    this.#root = this.onMessage = this.destroy = this.#i18n = null;
  }

  prepareUI() {
    if (this.#panel)
      return;

    const i18n = this.#i18n;
    const range = document.createRange();
    range.selectNodeContents(this.#root);
    const panelFragment = range.createContextualFragment(`
      <div class="tab-group-menu-panel">
        <div class="tab-group-menu-panel-contents">
          <div class="tab-group-menu-panel-contents-inner-box">
            <div class="tab-group-default-header">
              <div class="panel-header">
                <h1 class="tab-group-editor-title-create tab-group-create-mode-only"
                   >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_title_create)}</h1>
                <h1 class="tab-group-editor-title-edit tab-group-edit-mode-only"
                   >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_title_edit)}</h1>
              </div>
            </div>
            <hr/>
            <div class="panel-body tab-group-editor-name">
              <label>
                <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_name_label)}</span>
                <input class="tab-group-menu-title-field" type="text"
                       placeholder=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_name_field_placeholder)}/>
              </label>
            </div>
            <div class="tab-group-main">
              <div class="panel-body tab-group-editor-swatches" role="radiogroup"
                   aria-label=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector_aria_label)}>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_blue_title)}>
                  <input type="radio" name="tab-group-color" value="blue" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_blue)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_purple_title)}>
                  <input type="radio" name="tab-group-color" value="purple" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_purple)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_cyan_title)}>
                  <input type="radio" name="tab-group-color" value="cyan" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_cyan)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_orange_title)}>
                  <input type="radio" name="tab-group-color" value="orange" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_orange)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_yellow_title)}>
                  <input type="radio" name="tab-group-color" value="yellow" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_yellow)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_pink_title)}>
                  <input type="radio" name="tab-group-color" value="pink" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_pink)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_green_title)}>
                  <input type="radio" name="tab-group-color" value="green" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_green)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_gray_title)}>
                  <input type="radio" name="tab-group-color" value="gray" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_gray)}</span>
                </label>
                <label title=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_color_selector2_red_title)}>
                  <input type="radio" name="tab-group-color" value="red" class="tab-group-editor-swatch"/>
                  <span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_color_selector2_red)}</span>
                </label>
              </div>
              <hr/>
              <div class="panel-body tab-group-edit-actions tab-group-edit-mode-only">
                <button tabindex="0" class="tabGroupEditor_addNewTabInGroup subviewbutton"
                       >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_action_new_tab_label)}</button>
                <button tabindex="0" class="tabGroupEditor_moveGroupToNewWindow subviewbutton"
                       >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_action_new_window_label)}</button>
                <button tabindex="0" class="tabGroupEditor_saveAndCloseGroup subviewbutton"
                       >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_action_save_label)}</button>
                <button tabindex="0" class="tabGroupEditor_ungroupTabs subviewbutton"
                       >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_action_ungroup_label)}</button>
              </div>
              <hr class="tab-group-edit-mode-only"/>
              <div class="tab-group-edit-mode-only panel-body tab-group-delete">
                <button tabindex="0" class="tabGroupEditor_deleteGroup subviewbutton"
                       ><span class="label-text">${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_action_delete_label)}</span></button>
              </div>
              <!-hr class="tab-group-create-mode-only"/>
              <div class="tab-group-create-actions tab-group-create-mode-only">
                <button class="primary tab-group-editor-button-done"
                        accesskey=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_done_accesskey)}
                       >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_done_label)}</button>
                <button class="tab-group-editor-button-cancel"
                        accesskey=${JSON.stringify(i18n.tabGroupMenu_tab_group_editor_cancel_accesskey)}
                       >${this.sanitizeForHTMLText(i18n.tabGroupMenu_tab_group_editor_cancel_label)}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `.trim().replace(/>\s+</g, '><'));
    range.detach();
    const titleField = panelFragment.querySelector('.tab-group-menu-title-field');
    titleField.addEventListener('input', event => {
      browser.runtime.sendMessage({
        type:    'treestyletab:update-native-tab-group',
        groupId: parseInt(this.#panel.dataset.groupId),
        title:   event.target.value,
      });
    });
    const colorRadioGroup = panelFragment.querySelector('.tab-group-editor-swatches');
    colorRadioGroup.addEventListener('change', event => {
      if (!event.target.checked) {
        return;
      }
      browser.runtime.sendMessage({
        type:    'treestyletab:update-native-tab-group',
        groupId: parseInt(this.#panel.dataset.groupId),
        color:   event.target.value,
      });
    });
    const panel = panelFragment.querySelector('.tab-group-menu-panel');
    panel.addEventListener('click', event => {
    });
    panel.addEventListener('keydown', event => {
    });
    this.#root.appendChild(panelFragment);

    this.#panel = this.#root.querySelector('.tab-group-menu-panel');
  }
  sanitizeForHTMLText(text) {
    return (text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  updateUI({ groupId, groupTitle, groupColor, creating, anchorTabRect, offsetTop, align, rtl, scale, logging, animation, backgroundColor, borderColor, color, widthInOuterWorld, fixedOffsetTop } = {}) {
    if (!this.#panel)
      return;

    const startAt = this.lastStartedAt = Date.now();

    if (logging)
      console.log('updateUI ', { panel: this.#panel, groupId, groupTitle, groupColor, creating, anchorTabRect, offsetTop, align, rtl, scale, widthInOuterWorld, fixedOffsetTop });

    this.#panel.classList.add('updating');
    this.#panel.classList.toggle('animation', animation);
    this.#panel.classList.toggle('tab-group-editor-mode-create', creating);

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
    this.#root.style.setProperty('--tab-group-menu-panel-scale', scale);
    this.#panel.style.setProperty('--panel-width', `min(${window.innerWidth}px, calc(${this.BASE_PANEL_WIDTH} / ${scale}))`);

    const offsetFromWindowEdge = isResistFingerprintingMode ?
      0 :
      (window.mozInnerScreenY - window.screenY) * scale;
    const sidebarContentsOffset = isResistFingerprintingMode ?
      (fixedOffsetTop || 0) :
      (offsetTop - offsetFromWindowEdge) / scale;

    this.#panel.dataset.groupId = groupId;
    if (align)
      this.#panel.dataset.align = align;

    this.#panel.classList.toggle('rtl', !!rtl);

    const titleField = this.#panel.querySelector('.tab-group-menu-title-field');
    titleField.value = groupTitle || '';

    const colorRadio = this.#panel.querySelector(`.tab-group-editor-swatches input[value="${groupColor}"]`)
    if (colorRadio) {
      colorRadio.checked = true;
    }

    const completeUpdate = () => {
      if (this.#panel.dataset.groupId != groupId ||
          this.lastStartedAt != startAt) {
        return;
      }

      if (!anchorTabRect) {
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

      const contentsHeight = this.#panel.querySelector('.tab-group-menu-panel-contents-inner-box').getBoundingClientRect().height;

      let top;
      if (this.#windowId) { // in-sidebar
        if (logging)
          console.log('updateUI/completeUpdate: in-sidebar, alignment calculating: ', { half: window.innerHeight, maxY, scale, anchorTabRect });
        if (anchorTabRect.top > (window.innerHeight / 2)) { // align to bottom edge of the tab
          top = `${Math.min(maxY, anchorTabRect.bottom / scale) - panelHeight - anchorTabRect.height}px`;
          if (logging)
            console.log(' => align to bottom edge of the tab, top=', top);
        }
        else { // align to top edge of the tab
          top = `${Math.max(0, anchorTabRect.top / scale) + anchorTabRect.height}px`;
          if (logging)
            console.log(' => align to top edge of the tab, top=', top);
        }

        if (logging)
          console.log(' => top=', top);
      }
      else { // in-content
      // We need to shift the position with the height of the sidebar header.
        const alignToTopPosition = Math.max(0, anchorTabRect.top / scale) + sidebarContentsOffset;
        const alignToBottomPosition = Math.min(maxY, anchorTabRect.bottom + sidebarContentsOffset / scale) - panelHeight;

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

      titleField.focus();
    };
    completeUpdate.retryCount = 0;

    if (logging)
      console.log('updateUI: complete now');
    completeUpdate();
  }

  // for SIDEBAR case
  set windowId(id) {
    return this.#windowId = id;
  }
  get windowId() {
    return this.#windowId;
  }

  get open() {
    return !!this.#panel?.classList.contains('open');
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
