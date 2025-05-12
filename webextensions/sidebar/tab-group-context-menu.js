/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// Overview of the tab group context menu:
//
// Tab group context menu is processed by the combination of this script
// and content scripts. Players are:
//
// * This script (CONTROLLER)
// * The content script of the active tab to load panel provider
//   (LOADER): injected by prepareMenu()
// * The content script of the tab group menu panel implementation (IMPL):
//   loaded from `/resources/TabGroupMenuPanel.js` and injected by prepareMenu()
// * The tab B: the active tab which is used to show the tab group menu panel.
//
// When we need to show the tab group menu:
//
// 1. The CONTROLLER sends a message to the LOADER of the active tab,
//    like "do you have already prepared panel in your paeg?"
//    1. If no response, the CONTROLLER loads a content script LOADER
//       (and IMPL) into the active tab.
//    2. The LOADER of the active tab responds to the CONTROLLER, like
//       "OK, I'm ready!"
//    3. If these operation is not finished until some seconds, the
//       CONTROLLER gives up to show the menu.
// 2. The CONTROLLER receives the "I'm ready" response from the LOADER of
//    the active tab.
// 3. The IMPL shows the tab group menu panel.
//
// When we need to hide the tab group menu:
//
// 1. The CONTROLLER sends a message to the LOADER of the active tab, like
//    "do you have already prepared panel in your paeg?"
//    1. If no response, the CONTROLLER gives up to hide the panel.
//       We have nothing to do.
// 3. The CONTROLLER receives the "I'm ready" response from the LOADER of
//    the active tab.
// 4. The CONTROLLER sends a message to the IMPL in the active tab, like
//    "hide the panel"
// 5. The IMPL hides the panel.

import {
  configs,
  shouldApplyAnimation,
  log as internalLogger,
  isRTL,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab } from '/common/TreeItem.js';

import TabGroupMenuPanel from '/resources/module/TabGroupMenuPanel.js'; // the IMPL
import * as InContentClosedContainer from '/resources/module/in-content-closed-container.js';

function log(...args) {
  internalLogger('sidebar/tab-group-context-menu', ...args);
}

const TAB_GROUP_MENU_LABELS = Object.fromEntries(`
  tabGroupMenu_tab-group-editor-title-create
  tabGroupMenu_tab-group-editor-title-edit
  tabGroupMenu_tab-group-editor-name-label
  tabGroupMenu_tab-group-editor-name-field_placeholder
  tabGroupMenu_tab-group-editor-cancel_label
  tabGroupMenu_tab-group-editor-cancel_accesskey
  tabGroupMenu_tab-group-editor-color-selector_aria-label
  tabGroupMenu_tab-group-editor-color-selector2-blue
  tabGroupMenu_tab-group-editor-color-selector2-blue_title
  tabGroupMenu_tab-group-editor-color-selector2-purple
  tabGroupMenu_tab-group-editor-color-selector2-purple_title
  tabGroupMenu_tab-group-editor-color-selector2-cyan
  tabGroupMenu_tab-group-editor-color-selector2-cyan_title
  tabGroupMenu_tab-group-editor-color-selector2-orange
  tabGroupMenu_tab-group-editor-color-selector2-orange_title
  tabGroupMenu_tab-group-editor-color-selector2-yellow
  tabGroupMenu_tab-group-editor-color-selector2-yellow_title
  tabGroupMenu_tab-group-editor-color-selector2-pink
  tabGroupMenu_tab-group-editor-color-selector2-pink_title
  tabGroupMenu_tab-group-editor-color-selector2-green
  tabGroupMenu_tab-group-editor-color-selector2-green_title
  tabGroupMenu_tab-group-editor-color-selector2-gray
  tabGroupMenu_tab-group-editor-color-selector2-gray_title
  tabGroupMenu_tab-group-editor-color-selector2-red
  tabGroupMenu_tab-group-editor-color-selector2-red_title
  tabGroupMenu_tab-group-editor-action-new-tab_label
  tabGroupMenu_tab-group-editor-action-new-window_label
  tabGroupMenu_tab-group-editor-action-save_label
  tabGroupMenu_tab-group-editor-action-ungroup_label
  tabGroupMenu_tab-group-editor-action-delete_label
  tabGroupMenu_tab-group-editor-done_label
  tabGroupMenu_tab-group-editor-done_accesskey
`.trim().split(/\s+/).map(key => [key.replace(/-/g, '_'), browser.i18n.getMessage(key)]));
const TAB_GROUP_MENU_LABELS_CODE = JSON.stringify(TAB_GROUP_MENU_LABELS);

const mTabGroupMenuPanel = new TabGroupMenuPanel(document.querySelector('#tabGroupContextMenuRoot'), TAB_GROUP_MENU_LABELS);

async function prepareMenu(tabId) {
  const tab = Tab.get(tabId);
  if (!tab)
    return;

  log('prepareMenu: insert container to the tab contents ', tab.url);
  const logging = configs.logFor['sidebar/tab-group-context-menu'] && configs.debug;
  await browser.tabs.executeScript(tabId, {
    matchAboutBlank: true,
    runAt: 'document_start',
    code: `(() => { // the LOADER
      ${TabGroupMenuPanel.toString()}

      const logging = ${!!logging};

      ${InContentClosedContainer.getProviderCode()};

      const root = document.createElement('div');
      appendClosedContents(root);
      let tabGroupMenuPanel = new TabGroupMenuPanel(root, ${TAB_GROUP_MENU_LABELS_CODE});

      const onMessage = (message, _sender) => {
        switch (message?.type) {
          case 'treestyletab:ask-tab-group-menu-container-ready':
            return Promise.resolve(true);

          case '${Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW}':
            if (logging)
              console.log('tab detached from window, destroy tab group menu container');
            destroyClosedContents(destroy);
            break;
        }
      };
      browser.runtime.onMessage.addListener(onMessage);

      const onMouseDown = event => {
        if (event.target?.closest(window.closedContainerType)) {
          return;
        }
        if (logging)
          console.log('mouse down on out of tab group menu panel, destroy tab group menu container');
        browser.runtime.sendMessage({
          type: 'treestyletab:tab-group-menu:hide',
          timestamp: Date.now(),
        });
        destroyClosedContents(destroy);
      };
      document.documentElement.addEventListener('mousedown', onMouseDown, { captuer: true });

      const destroy = () => {
        if (tabGroupMenuPanel) {
          tabGroupMenuPanel.destroy();
          tabGroupMenuPanel = null;
        }
        browser.runtime.onMessage.removeListener(onMessage);
        window.removeEventListener('unload', destroy);
        window.removeEventListener('pagehide', destroy);
      };
      window.addEventListener('unload', destroy, { once: true });
      window.addEventListener('pagehide', destroy, { once: true });
      closedContentsDestructors.add(destroy);
    })()`,
  });
}

function shouldMessageSend(message) {
  return message.type != 'treestyletab:tab-group-menu:show';
}

// returns succeeded or not (boolean)
async function sendTabGroupMenuMessage(tabId, message, deferredResultResolver) {
  const canRenderInSidebar = !!(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  if (!tabId ||
      !(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT)) { // in-sidebar mode
    if (canRenderInSidebar) {
      log(`sendTabGroupMenuMessage(${message.type}): no tab specified or sidebar only mode, fallback to in-sidebar preview`);
      return sendInSidebarTabGroupMenuMessage(message);
    }
    else {
      log(`sendTabGroupMenuMessage(${message.type}): no tab specified or not allowed, cancel`);
      return false;
    }
  }

  const retrying = !!deferredResultResolver;
  const tab = Tab.get(tabId);
  if (!tab)
    return false;

  const shouldFallbackToSidebar = canRenderInSidebar;

  let ready;
  let rawTab;
  try {
    const [gotReady, gotRawTab] = await Promise.all([
      browser.tabs.sendMessage(tabId, {
        type: 'treestyletab:ask-tab-group-menu-container-ready',
      }).catch(_error => {}),
      browser.tabs.get(tabId),
    ]);
    ready = gotReady;
    rawTab = gotRawTab;
    log(`sendTabGroupMenuMessage(${message.type}${retrying ? ', retrying' : ''}): response from the tab: `, { ready });
    if (!ready) {
      if (!message.canRetry) {
        log(` => no response, give up to send`);
        return false;
      }

      if (retrying) {
        // Retried to init tab group menu panel, but failed, so
        // now we fall back to the in-sidebar tab group menu.
        if (!shouldFallbackToSidebar ||
            !shouldMessageSend(message)) {
          log(` => no response after retrying, give up to send `, shouldFallbackToSidebar, message.type, message.type == 'treestyletab:tab-group-menu:show');
          deferredResultResolver(false);
          return false;
        }
        log(` => no response after retrying, fall back to in-sidebar previes`);
        return sendInSidebarTabGroupMenuMessage(message)
          .then(() => {
            deferredResultResolver(true);
            return true;
          });
      }

      // We prepare tab group menu panel now, and retry sending after that.
      log(` => no response, retry`);
      let resultResolver;
      const promisedResult = new Promise((resolve, _reject) => {
        resultResolver = resolve;
      });
      waitUntilTabGroupMenuPanelContainerReadyInTab(tabId).then(() => {
        sendTabGroupMenuMessage(tabId, message, resultResolver);
      });
      await prepareMenu(tabId);
      return promisedResult;
    }
  }
  catch (error) {
    log(`sendTabGroupMenuMessage(${message.type}${retrying ? ', retrying' : ''}): failed to ask to the tab `, error);
    // We cannot show tab group menu tooltip in a tab with privileged contents.
    // Let's fall back to the in-sidebar tab group menu.
    await sendInSidebarTabGroupMenuMessage(message);
    if (deferredResultResolver)
      deferredResultResolver(true);
    return true;
  }

  // hide in-sidebar tab group menu if in-content tab group menu is available
  sendInSidebarTabGroupMenuMessage({
    type: 'treestyletab:tab-group-menu:hide',
  });

  let response;
  try {
    const timestamp = Date.now();
    response = await browser.tabs.sendMessage(tabId, {
      tabId,
      timestamp,
      ...message,
      ...mTabGroupMenuPanel.getColors(),
      widthInOuterWorld: rawTab.width,
      fixedOffsetTop: configs.tabGroupMenuPanelOffsetTop,
      animation: shouldApplyAnimation(),
      logging: configs.logFor['sidebar/tab-group-context-menu'] && configs.debug,
    });
    if (deferredResultResolver)
      deferredResultResolver(!!response);
  }
  catch (error) {
    log(`sendTabGroupMenuMessage(${message.type}${retrying ? ', retrying' : ''}): failed to send message `, error);
    if (!message.canRetry) {
      log(` => no response, give up to send`);
      return false;
    }

    if (retrying) {
      // Retried to initialize tab group menu panel, but failed, so
      // now we fall back to the in-sidebar tab group menu.
      if (!shouldFallbackToSidebar ||
          !shouldMessageSend(message)) {
        log(` => no response after retrying, give up to send`, message.type, message.type == 'treestyletab:tab-group-menu:show');
        deferredResultResolver(false);
        return false;
      }
      log(` => no response after retrying, fall back to in-sidebar previes`);
      return sendInSidebarTabGroupMenuMessage(message)
        .then(() => {
          deferredResultResolver(true);
          return true;
        });
    }

    // the panel was destroyed unexpectedly, so we re-prepare it.
    log(` => no response, retry`);
    let resultResolver;
    const promisedResult = new Promise((resolve, _reject) => {
      resultResolver = resolve;
    });
    waitUntilTabGroupMenuPanelContainerReadyInTab(tabId).then(() => {
      sendTabGroupMenuMessage(tabId, message, resultResolver);
    });
    await prepareMenu(tabId);
    return promisedResult;
  }

  if (typeof response != 'boolean' &&
      shouldMessageSend(message)) {
    log(`sendTabGroupMenuMessage(${message.type}${retrying ? ', retrying' : ''}): got invalid response, fallback to in-sidebar preview`);
    // Failed to send message to the in-content tab group menu panel, so
    // now we fall back to the in-sidebar tab group menu.
    return sendInSidebarTabGroupMenuMessage(message);
  }

  // Everything is OK!
  return !!response;
}

async function waitUntilTabGroupMenuPanelContainerReadyInTab(tabId) {
  let resolver;
  const promisedLoaded = new Promise((resolve, _reject) => {
    resolver = resolve;
  });
  let timeout;
  const onMessage = (message, sender) => {
    if (message?.type != 'treestyletab:tab-group-menu:ready' ||
        sender.tab?.id != tabId)
      return;
    log('waitUntilTabGroupMenuPanelContainerReadyInTab: ready in the tab ', tabId);
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
    log('waitUntilTabGroupMenuPanelContainerReadyInTab: timeout for the tab ', tabId);
    timeout = null;
    browser.runtime.onMessage.removeListener(onMessage);
    resolver();
  }, 1000);
  return promisedLoaded;
}


async function sendInSidebarTabGroupMenuMessage(message) {
  const startAt = message.startAt || Date.now();
  log(`sendInSidebarTabGroupMenuMessage(${message.type}})`);
  await mTabGroupMenuPanel.handleMessage({
    timestamp: startAt,
    ...message,
    windowId: TabsStore.getCurrentWindowId(),
    animation: shouldApplyAnimation(),
    logging: configs.logFor['sidebar/tab-group-context-menu'] && configs.debug,
  });
  return true;
}

export async function show(group) {
  if (!group?.id) {
    return;
  }

  if (!mTabGroupMenuPanel.windowId) {
    const windowId = TabsStore.getCurrentWindowId();
    mTabGroupMenuPanel.windowId = windowId;
  }

  const startAt = Date.now();

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  const targetTabId = Permissions.canInjectScriptToTabSync(activeTab) ?
    activeTab.id :
    null;

  const anchorTabRawRect = group.$TST.element?.substanceElement?.getBoundingClientRect();
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

  const succeeded = await sendTabGroupMenuMessage(targetTabId, {
    type: 'treestyletab:tab-group-menu:show',
    groupId:    group.id,
    groupTitle: group.title,
    groupColor: group.color,
    anchorTabRect,
    /* These information is used to calculate offset of the sidebar header */
    offsetTop: window.mozInnerScreenY - window.screenY,
    offsetLeft: window.mozInnerScreenX - window.screenX,
    align: mayBeRight ? 'right' : 'left',
    rtl: isRTL(),
    scale: 1 / window.devicePixelRatio,
    // Don't call Date.now() here, because it can become larger than
    // the timestamp on mouseleave.
    timestamp: startAt,
    canRetry: !!targetTabId,
  }).catch(error => {
    log(`show(${group.id}}) failed: `, error);
  });
  log(` => ${succeeded ? 'succeeded' : 'failed'}`);
}

/*
async function onTabSubstanceLeave(event) {
  const startAt = Date.now();
  if (!event.target.tab)
    return;

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  const targetTabId = await Permissions.canInjectScriptToTab(activeTab) ?
    activeTab.id :
    null;

  if (!event.target.tab) // the tab was closed while waiting
    return;

  sendTabGroupMenuMessage(targetTabId, {
    type: 'treestyletab:tab-group-menu:hide',
    groupId: event.target.groupId,
    timestamp: startAt,
  });
}
onTabSubstanceLeave = EventUtils.wrapWithErrorHandler(onTabSubstanceLeave);
*/


browser.tabs.onActivated.addListener(activeInfo => {
  const startAt = Date.now();

  if (activeInfo.windowId != TabsStore.getCurrentWindowId())
    return;

  sendInSidebarTabGroupMenuMessage({
    type: 'treestyletab:tab-group-menu:hide',
    timestamp: startAt,
  });
  sendTabGroupMenuMessage(activeInfo.tabId, {
    type: 'treestyletab:tab-group-menu:hide',
    timestamp: startAt,
  });
  sendTabGroupMenuMessage(activeInfo.previousTabId, {
    type: 'treestyletab:tab-group-menu:hide',
    timestamp: startAt,
  });
});

document.querySelector('#tabbar').addEventListener('mousedown', event => {
  if (event.target?.closest('#tabGroupContextMenuRoot')) {
    return;
  }

  /*
  if (mTabGroupMenuPanel.open) {
    event.stopPropagation();
    event.preventDefault();
  }
  */

  const startAt = Date.now();
  sendInSidebarTabGroupMenuMessage({
    type: 'treestyletab:tab-group-menu:hide',
    timestamp: startAt,
  });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  sendTabGroupMenuMessage(activeTab.id, {
    type: 'treestyletab:tab-group-menu:hide-if-shown',
    timestamp: startAt,
  });
}, { capture: true });
