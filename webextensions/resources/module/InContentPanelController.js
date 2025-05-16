/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  shouldApplyAnimation,
  isRTL,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';

import { Tab } from '/common/TreeItem.js';

import InContentPanel from './InContentPanel.js';

export default class InContentPanelController {
  constructor({ type, logger, shouldLog, UIClass, inSidebarUI, initializerCode, sendMessage }) {
    this.type            = type;
    this.log             = logger;
    this.shouldLog       = shouldLog;
    this.UIClass         = UIClass;
    this.inSidebarUI     = inSidebarUI;
    this.initializerCode = initializerCode;
    this.sendMessage     = sendMessage;

    browser.tabs.onActivated.addListener(activeInfo => {
      const timestamp = Date.now();

      if (activeInfo.windowId != TabsStore.getCurrentWindowId())
        return;

      this.sendInSidebarMessage({
        type: `treestyletab:${this.type}:hide`,
        timestamp,
      });
      this.sendMessage(activeInfo.tabId, {
        type: `treestyletab:${this.type}:hide`,
        timestamp,
      });
      this.sendMessage(activeInfo.previousTabId, {
        type: `treestyletab:${this.type}:hide`,
        timestamp,
      });
    });
  }

  // Generates a custom element name at random. This mainly aims to avoid
  // conflicting of custom element names defined by webpage scripts.
  // The generated name is user-unfriendly, this aims to guard your privacy.
  generateOneTimeCustomElementName() {
    const alphabets = 'abcdefghijklmnopqrstuvwxyz';
    const prefix = alphabets[Math.floor(Math.random() * alphabets.length)];
    return prefix + '-' + Date.now() + '-' + Math.round(Math.random() * 65000);
  }

  async prepareUIInTab(tabId) {
    const tab = Tab.get(tabId);
    if (!tab)
      return;

    this.log(`prepareUIInTab (${this.type}): insert container to the tab contents `, tab.url);
    await browser.tabs.executeScript(tabId, {
      matchAboutBlank: true,
      runAt: 'document_start',
      code: `(() => { // the LOADER
        const logging = ${!!this.shouldLog()};

        ${InContentPanel.toString()}
        ${this.UIClass.toString()}

        // We cannot use multiple custom element types with contents scripts -
        // otherwise second custom type must fail its construction ("super()" in
        // its constructor raises unexpected error), so we just use only one
        // custom element type and recycle it for multiple purposes.
        window.closedContainerType = window.closedContainerType || '${this.generateOneTimeCustomElementName()}';

        const version = '${browser.runtime.getManifest().version}';
        if (window.lastClosedContainerVersion &&
            window.lastClosedContainerVersion != version) {
          window.clearClosedContents();
        }
        window.lastClosedContainerVersion = version;

        // We cannot undefine custom element types, so we define it just one time.
        if (!window.customElements.get(window.closedContainerType)) {
          window.closedContentsDestructors = new Set();
          // We use a wrapper custom element to enclose all preview elements
          // which can contain privacy information.
          // It should guard them from accesses by webpage scripts.
          class ClosedContainer extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'closed' });
              window.appendClosedContents = element => shadow.appendChild(element);
              window.removeClosedContents = element => shadow.removeChild(element);
              window.clearClosedContents = () => {
                for (const destructor of window.closedContentsDestructors) {
                  try {
                    destructor();
                  }
                  catch(error) {
                    console.error(error);
                  }
                }
                for (const element of shadow.childNodes) {
                  removeClosedContents(element);
                }
                closedContentsDestructors.clear();
                lastClosedContainer.parentNode.removeChild(lastClosedContainer);
                window.lastClosedContainer = null;
              };
            }
          }
          window.customElements.define(window.closedContainerType, ClosedContainer);
          window.destroyClosedContents = destructor => {
            try{
              destructor();
            }
            catch(error) {
              console.error(error);
            }
            window.closedContentsDestructors.delete(destructor);
            if (window.closedContentsDestructors.size > 0) {
              return;
            }
            window.lastClosedContainer.parentNode.removeChild(window.lastClosedContainer);
            window.lastClosedContainer = null;
          };
          window.createClosedContentsDestructor = (root, type, onDestroy) => {
            let destructor;

            const onMessage = (message, _sender) => {
              switch (message?.type) {
                case 'treestyletab:' + type + ':ask-container-ready':
                  return Promise.resolve(true);

                case '${Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW}':
                  window.destroyClosedContents(destructor);
                  break;
              }
            };
            browser.runtime.onMessage.addListener(onMessage);

            destructor = () => {
              onDestroy();
              browser.runtime.onMessage.removeListener(onMessage);
              window.removeEventListener('unload', destructor);
              window.removeEventListener('pagehide', destructor);
              window.removeClosedContents(root);
            };
            window.addEventListener('unload', destructor, { once: true });
            window.addEventListener('pagehide', destructor, { once: true });

            window.closedContentsDestructors.add(destructor);

            return destructor;
          };
        }

        if (!window.lastClosedContainer) {
          window.lastClosedContainer = document.createElement(window.closedContainerType);
          document.documentElement.appendChild(window.lastClosedContainer);
        }

        ${this.initializerCode}
      })()`,
    });
  }

  async waitUntilUIContainerReadyInTab(tabId) {
    let resolver;
    const promisedLoaded = new Promise((resolve, _reject) => {
      resolver = resolve;
    });
    let timeout;
    const onMessage = (message, sender) => {
      if (message?.type != `treestyletab:${this.type}:ready` ||
          sender.tab?.id != tabId)
        return;
      this.log(`waitUntilUIContainerReadyInTab(${this.type}): ready in the tab `, tabId);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      resolver();
    };
    browser.runtime.onMessage.addListener(onMessage);
    timeout = setTimeout(() => {
      if (!timeout)
        return;
      this.log(`waitUntilUIContainerReadyInTab(${this.type}): timeout for the tab `, tabId);
      timeout = null;
      browser.runtime.onMessage.removeListener(onMessage);
      resolver();
    }, 1000);
    return promisedLoaded;
  }

  async sendInSidebarMessage(message) {
    const timestamp = message.timestamp || Date.now();
    this.log(`sendInSidebarMessage(${message.type}})`);
    await this.inSidebarUI.handleMessage({
      timestamp,
      ...message,
      windowId: TabsStore.getCurrentWindowId(),
      animation: shouldApplyAnimation(),
      logging: this.shouldLog(),
    });
    return true;
  }

  async show({ timestamp, anchorItem, targetItem, messageParams }) {
    if (!timestamp) {
      timestamp = Date.now();
    }

    const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
    const playgroundTabId = Permissions.canInjectScriptToTabSync(activeTab) ?
      activeTab.id :
      null;

    const anchorTabRawRect = anchorItem?.$TST.element?.substanceElement?.getBoundingClientRect();
    const anchorTabRect = {
      bottom: anchorTabRawRect?.bottom || 0,
      height: anchorTabRawRect?.height || 0,
      left:   anchorTabRawRect?.left || 0,
      right:  anchorTabRawRect?.right || 0,
      top:    anchorTabRawRect?.top || 0,
      width:  anchorTabRawRect?.width || 0,
    };

    // This calculation logic is buggy for a window in a screen placed at
    // left of the primary display and scaled. As the result, a sidebar
    // placed at left can be mis-detected as placed at right. For safety
    // I ignore such cases and always treat such cases as "left side placed".
    // See also: https://github.com/piroor/treestyletab/issues/2984#issuecomment-901907503
    const mayBeRight = window.screenX < 0 && window.devicePixelRatio > 1 ?
      false :
      window.mozInnerScreenX - window.screenX > (window.outerWidth - window.innerWidth) / 2;

    this.log(`show (${this.type}, ${targetItem.id}}) [${Date.now() - timestamp}msec from start]: show in ${playgroundTabId || 'sidebar'} `, messageParams);
    const succeeded = await this.sendMessage(playgroundTabId, {
      type:     `treestyletab:${this.type}:show`,
      targetId: targetItem.id,
      ...(messageParams || {}),
      anchorTabRect,
      /* These information is used to calculate offset of the sidebar header */
      offsetTop: window.mozInnerScreenY - window.screenY,
      offsetLeft: window.mozInnerScreenX - window.screenX,
      align: mayBeRight ? 'right' : 'left',
      rtl: isRTL(),
      scale: 1 / window.devicePixelRatio,
      // Don't call Date.now() here, because it can become larger than
      // the timestamp on mouseleave.
      timestamp,
      canRetry: !!playgroundTabId,
    }).catch(error => {
      this.log(`show (${this.type}$, {targetItem.id}}) failed: `, error);
    });
    this.log(` => ${succeeded ? 'succeeded' : 'failed'}`);
    return succeeded;
  }
}
