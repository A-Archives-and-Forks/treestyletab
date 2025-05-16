/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// Overview of the tab preview tooltip:
//
// Tab preview tooltips are processed by the combination of this script
// and content scripts. Players are:
//
// * This script (CONTROLLER)
// * The content script of the active tab to load tab preview provider
//   (LOADER): injected by prepareUIInTab()
// * The content script of the tab preview implementation (IMPL): loaded
//   from `/resources/TabPreviewPanel.js` and injected by prepareUIInTab()
// * The tab A: a tab to be shown in the preview tooltip.
// * The tab B: the active tab which is used to show the preview tooltip.
//
// When we need to show a tab preview:
//
// 1. The CONTROLLER detects `tab-item-substance-enter` (`mouseenter`) event
//    on a tab substance.
// 2. The CONTROLLER sends a message to the LOADER of the active tab,
//    like "do you have already prepared panel in your paeg?"
//    1. If no response, the CONTROLLER loads a content script LOADER
//       (and IMPL) into the active tab.
//    2. The LOADER of the active tab responds to the CONTROLLER, like
//       "OK, I'm ready!"
//    3. If these operation is not finished until some seconds, the
//       CONTROLLER gives up to show the preview.
// 3. The CONTROLLER receives the "I'm ready" response from the LOADER of
//    the active tab.
// 4. The CONTROLLER generates a thumbnail image for the tab A, and sends
//    a message to the IMPL in the active tab, like "show a preview with a
//    thumbnail image 'data:image/png,...' at the position (x,y)"
// 5. The IMPL shows the preview.
//
// When we need to hide a tab preview:
//
// 1. The CONTROLLER detects `tab-item-substance-leave` (`mouseleave`) event
//    on a tab substance.
// 2. The CONTROLLER sends a message to the LOADER of the active tab, like
//    "do you have already prepared panel in your paeg?"
//    1. If no response, the CONTROLLER gives up to hide the preview.
//       We have nothing to do.
// 3. The CONTROLLER receives the "I'm ready" response from the LOADER of
//    the active tab.
// 4. The CONTROLLER sends a message to the IMPL in the active tab, like
//    "hide a preview"
// 5. The IMPL hides the preview.

import {
  configs,
  shouldApplyAnimation,
  log as internalLogger,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab } from '/common/TreeItem.js';

import InContentPanelController from '/resources/module/InContentPanelController.js';
import TabPreviewPanel from '/resources/module/TabPreviewPanel.js'; // the IMPL

import * as EventUtils from './event-utils.js';
import * as Sidebar from './sidebar.js';

import { kEVENT_TREE_ITEM_SUBSTANCE_ENTER, kEVENT_TREE_ITEM_SUBSTANCE_LEAVE } from './components/TreeItemElement.js';

const CAPTURABLE_URLS_MATCHER         = /^(https?|data):/;
const PREVIEW_WITH_HOST_URLS_MATCHER  = /^(https?|moz-extension):/;
const PREVIEW_WITH_TITLE_URLS_MATCHER = /^file:/;

document.addEventListener(kEVENT_TREE_ITEM_SUBSTANCE_ENTER, onTabSubstanceEnter);
document.addEventListener(kEVENT_TREE_ITEM_SUBSTANCE_LEAVE, onTabSubstanceLeave);

function log(...args) {
  internalLogger('sidebar/tab-preview-tooltip', ...args);
}

const mTabPreviewPanel = new TabPreviewPanel(document.querySelector('#tabPreviewRoot'));
const mController = new InContentPanelController({
  type:    TabPreviewPanel.TYPE,
  logger:  log,
  shouldLog() {
    return configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug;
  },
  UIClass: TabPreviewPanel,
  inSidebarUI: mTabPreviewPanel,
  initializerCode: `
    const root = document.createElement('div');
    appendClosedContents(root);
    let tabPreviewPanel = new TabPreviewPanel(root);

    let destroy;

    const onMouseMove = () => {
      if (logging)
        console.log('mouse move on the content area, destroy tab preview container');
      browser.runtime.sendMessage({
        type: 'treestyletab:${TabPreviewPanel.TYPE}:hide',
        timestamp: Date.now(),
      });
      destroyClosedContents(destroy);
    };
    document.documentElement.addEventListener('mousemove', onMouseMove, { once: true });

    destroy = createClosedContentsDestructor(root, '${TabPreviewPanel.TYPE}', () => {
      if (tabPreviewPanel) {
        tabPreviewPanel.destroy();
        tabPreviewPanel = null;
      }
      window.removeEventListener('mousemove', onMouseMove);
    });
  `,
  sendMessage: sendTabPreviewMessage,
});

const hoveringTabIds = new Set();

function shouldMessageSend(message) {
  return (
    message.type != `treestyletab:${TabPreviewPanel.TYPE}:show` ||
    hoveringTabIds.has(message.targetId)
  );
}

// returns succeeded or not (boolean)
async function sendTabPreviewMessage(tabId, message, deferredResultResolver) {
  const canRenderInSidebar = !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  if (!tabId ||
      !(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT)) { // in-sidebar mode
    if (canRenderInSidebar &&
        !message.hasCustomTooltip) {
      log(`sendTabPreviewMessage(${message.type}): no tab specified or sidebar only mode, fallback to in-sidebar preview`);
      return mController.sendInSidebarMessage(message);
    }
    else {
      log(`sendTabPreviewMessage(${message.type}): no tab specified or not allowed, cancel`);
      return false;
    }
  }

  const retrying = !!deferredResultResolver;
  const tab = Tab.get(tabId);
  if (!tab)
    return false;

  const promisedPreviewURL = typeof message.previewURL == 'function' && message.previewURL();
  const shouldFallbackToSidebar = canRenderInSidebar && !message.hasCustomTooltip;

  let rawTab;
  try {
    const [ready, gotRawTab] = await Promise.all([
      browser.tabs.sendMessage(tabId, {
        type: `treestyletab:${TabPreviewPanel.TYPE}:ask-container-ready`,
      }).catch(_error => {}),
      browser.tabs.get(tabId),
    ]);
    rawTab = gotRawTab;
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): response from the tab: `, { ready });
    if (!ready) {
      if (!message.canRetry) {
        log(` => no response, give up to send`);
        return false;
      }

      if (retrying) {
        // Retried to init tab preview panel, but failed, so
        // now we fall back to the in-sidebar tab preview.
        if (!shouldFallbackToSidebar ||
            !shouldMessageSend(message)) {
          log(` => no response after retrying, give up to send`);
          deferredResultResolver(false);
          return false;
        }
        log(` => no response after retrying, fall back to in-sidebar previes`);
        return mController.sendInSidebarMessage(message)
          .then(() => {
            deferredResultResolver(true);
            return true;
          });
      }

      // We prepare tab preview panel now, and retry sending after that.
      log(` => no response, retry`);
      let resultResolver;
      const promisedResult = new Promise((resolve, _reject) => {
        resultResolver = resolve;
      });
      mController.waitUntilUIContainerReadyInTab(tabId).then(() => {
        sendTabPreviewMessage(tabId, message, resultResolver);
      });
      await mController.prepareUIInTab(tabId);
      return promisedResult;
    }
  }
  catch (error) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): failed to ask to the tab `, error);
    // We cannot show tab preview tooltip in a tab with privileged contents.
    // Let's fall back to the in-sidebar tab preview.
    await mController.sendInSidebarMessage(message);
    if (deferredResultResolver)
      deferredResultResolver(true);
    return true;
  }

  // hide in-sidebar tab preview if in-content tab preview is available
  mController.sendInSidebarMessage({
    type: `treestyletab:${TabPreviewPanel.TYPE}:hide`,
  });

  let response;
  try {
    const timestamp = Date.now();
    response = await browser.tabs.sendMessage(tabId, {
      tabId,
      timestamp,
      ...message,
      ...mTabPreviewPanel.getColors(),
      ...(promisedPreviewURL ? { previewURL: null } : {}),
      widthInOuterWorld: rawTab.width,
      fixedOffsetTop: configs.tabPreviewTooltipOffsetTop,
      animation: shouldApplyAnimation(),
      logging: configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug,
    });
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): message was sent, response=`, response, ', promisedPreviewURL=', promisedPreviewURL);
    if (deferredResultResolver)
      deferredResultResolver(!!response);

    if (response && promisedPreviewURL) {
      log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}, with previewURL): trying to get preview URL`);
      promisedPreviewURL.then(async previewURL => {
        const response = await browser.tabs.sendMessage(tabId, {
          tabId,
          timestamp,
          ...message,
          previewURL,
          ...mTabPreviewPanel.getColors(),
          widthInOuterWorld: rawTab.width,
          fixedOffsetTop: configs.tabPreviewTooltipOffsetTop,
          animation: shouldApplyAnimation(),
          logging: configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug,
        });
        log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}, with previewURL): message was sent again, response=`, response);
      });
    }
  }
  catch (error) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): failed to send message `, error);
    if (!message.canRetry) {
      log(` => no response, give up to send`);
      return false;
    }

    if (retrying) {
      // Retried to initialize tab preview panel, but failed, so
      // now we fall back to the in-sidebar tab preview.
      if (!shouldFallbackToSidebar ||
          !shouldMessageSend(message)) {
        log(` => no response after retrying, give up to send`);
        deferredResultResolver(false);
        return false;
      }
      log(` => no response after retrying, fall back to in-sidebar previes`);
      return mController.sendInSidebarMessage(message)
        .then(() => {
          deferredResultResolver(true);
          return true;
        });
    }

    if (!shouldMessageSend(message)) {
      log(` => no response, already canceled, give up to send`);
      return false;
    }

    // the panel was destroyed unexpectedly, so we re-prepare it.
    log(` => no response, retry`);
    let resultResolver;
    const promisedResult = new Promise((resolve, _reject) => {
      resultResolver = resolve;
    });
    mController.waitUntilUIContainerReadyInTab(tabId).then(() => {
      sendTabPreviewMessage(tabId, message, resultResolver);
    });
    await mController.prepareUIInTab(tabId);
    return promisedResult;
  }

  if (typeof response != 'boolean' &&
      shouldMessageSend(message)) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): got invalid response, fallback to in-sidebar preview`);
    // Failed to send message to the in-content tab preview panel, so
    // now we fall back to the in-sidebar tab preview.
    return mController.sendInSidebarMessage(message);
  }

  // Everything is OK!
  return !!response;
}

async function onTabSubstanceEnter(event) {
  const timestamp = Date.now();

  const canCaptureTab = Permissions.isGrantedSync(Permissions.ALL_URLS);
  if (!canCaptureTab)
    return;

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());

  if (!configs.tabPreviewTooltip ||
      !(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_ANYWHERE)) {;
    sendTabPreviewMessage(activeTab.id, {
      type: `treestyletab:${TabPreviewPanel.TYPE}:hide`,
    });
    return;
  }

  if (!event.target.tab ||
      document.documentElement.classList.contains(Constants.kTABBAR_STATE_TAB_DRAGGING)) {
    return;
  }

  const active = event.target.tab?.id == activeTab.id;
  const url = PREVIEW_WITH_HOST_URLS_MATCHER.test(event.target.tab?.url) ? new URL(event.target.tab?.url).host :
    PREVIEW_WITH_TITLE_URLS_MATCHER.test(event.target.tab?.url) ? null :
      event.target.tab?.url;
  const hasCustomTooltip = !!event.target.hasCustomTooltip;
  const hasPreview = (
    !active &&
    !event.target.tab?.discarded &&
    CAPTURABLE_URLS_MATCHER.test(event.target.tab?.url) &&
    !hasCustomTooltip
  );
  const previewURL = (
    hasPreview &&
    canCaptureTab &&
    configs.tabPreviewTooltip &&
    (async () => { // We just define a getter function for now, because further operations may contain async operations and we can call this at there for more optimization.
      try {
        return await browser.tabs.captureTab(event.target.tab?.id);
      }
      catch (_error) {
      }
      return null;
    })
  ) || null;

  if (!event.target.tab)
    return;

  log(`onTabSubstanceEnter(${event.target.tab.id}}) start `, timestamp);

  hoveringTabIds.add(event.target.tab.id);

  const succeeded = await mController.show({
    anchorItem: event.target.tab,
    targetItem: event.target.tab,
    sendMessage: sendTabPreviewMessage,
    messageParams: {
      hasCustomTooltip,
      ...(hasCustomTooltip ?
        {
          tooltipHtml: event.target.appliedTooltipHtml,
        } :
        {
          title: event.target.tab.title,
          url,
        }
      ),
      hasPreview,
      previewURL,
      // This is required to simulate the behavior:
      // show tab preview panel with delay only when the panel is not shown yet.
      waitInitialShowUntil: timestamp + Math.max(configs.tabPreviewTooltipDelayMsec, 0),
    },
  });

  if (!event.target.tab) // the tab may be destroyied while we capturing tab preview
    return;

  if (event.target.tab.$TST.element &&
      succeeded)
    event.target.tab.$TST.element.invalidateTooltip();
}
onTabSubstanceEnter = EventUtils.wrapWithErrorHandler(onTabSubstanceEnter);

async function onTabSubstanceLeave(event) {
  const timestamp = Date.now();
  if (!event.target.tab)
    return;

  hoveringTabIds.delete(event.target.tab.id);

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  const targetTabId = await Permissions.canInjectScriptToTab(activeTab) ?
    activeTab.id :
    null;

  if (!event.target.tab) // the tab was closed while waiting
    return;

  log(`onTabSubstanceLeave(${event.target.tab.id}}) hide tab preview in ${targetTabId || 'sidebar'} `, timestamp);
  sendTabPreviewMessage(targetTabId, {
    type: `treestyletab:${TabPreviewPanel.TYPE}:hide`,
    targetId: event.target.tab.id,
    timestamp,
  });
}
onTabSubstanceLeave = EventUtils.wrapWithErrorHandler(onTabSubstanceLeave);

Sidebar.onReady.addListener(() => {
  const windowId = TabsStore.getCurrentWindowId();
  mTabPreviewPanel.windowId = windowId;
});

document.querySelector('#tabbar').addEventListener('mouseleave', async () => {
  const timestamp = Date.now();
  log('mouse is left from the tab bar ', timestamp);

  hoveringTabIds.clear();

  mController.sendInSidebarMessage({
    type: `treestyletab:${TabPreviewPanel.TYPE}:hide`,
    timestamp,
  });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  if (activeTab) {
    sendTabPreviewMessage(activeTab.id, {
      type: `treestyletab:${TabPreviewPanel.TYPE}:hide`,
      timestamp,
    });
  }
});
