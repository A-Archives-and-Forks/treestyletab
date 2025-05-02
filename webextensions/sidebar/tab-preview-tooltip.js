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
//   (LOADER): injected by preparePreview()
// * The content script of the tab preview implementation (IMPL): loaded
//   from `/resources/TabPreviewPanel.js` and injected by preparePreview()
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
  isRTL,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import Tab from '/common/Tab.js';

import TabPreviewPanel from '/resources/module/TabPreviewPanel.js'; // the IMPL

import * as EventUtils from './event-utils.js';
import * as Sidebar from './sidebar.js';

import { kEVENT_TAB_SUBSTANCE_ENTER, kEVENT_TAB_SUBSTANCE_LEAVE } from './components/TabElement.js';

const CAPTURABLE_URLS_MATCHER         = /^(https?|data):/;
const PREVIEW_WITH_HOST_URLS_MATCHER  = /^(https?|moz-extension):/;
const PREVIEW_WITH_TITLE_URLS_MATCHER = /^file:/;

document.addEventListener(kEVENT_TAB_SUBSTANCE_ENTER, onTabSubstanceEnter);
document.addEventListener(kEVENT_TAB_SUBSTANCE_LEAVE, onTabSubstanceLeave);

function log(...args) {
  internalLogger('sidebar/tab-preview-tooltip', ...args);
}

// Generates a custom element name at random. This mainly aims to avoid
// conflicting of custom element names defined by webpage scripts.
// The generated name is user-unfriendly, this aims to guard your privacy.
function generateOneTimeCustomElementName() {
  const alphabets = 'abcdefghijklmnopqrstuvwxyz';
  const prefix = alphabets[Math.floor(Math.random() * alphabets.length)];
  return prefix + '-' + Date.now() + '-' + Math.round(Math.random() * 65000);
}

const mTabPreviewPanel = new TabPreviewPanel(document.querySelector('#tabPreviewRoot'));

async function preparePreview(tabId) {
  const tab = Tab.get(tabId);
  if (!tab)
    return;

  log('preparePreview: insert container to the tab contents ', tab.url);
  const logging = configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug;
  await browser.tabs.executeScript(tabId, {
    matchAboutBlank: true,
    runAt: 'document_start',
    code: `(() => { // the LOADER
      ${TabPreviewPanel.toString()}
      window.lastTabPreviewPanel = TabPreviewPanel;

      const logging = ${!!logging};

      window.closedContainerType = window.closedContainerType || '${generateOneTimeCustomElementName()}';

      // cleanup!
      for (const oldConatiner of document.querySelectorAll(window.closedContainerType)) {
        oldContainer.parentNode.removeChild(oldContainer);
      }

      let tabPreviewPanel;

      // We cannot undefine custom element types, so we define it just one time.
      if (!window.customElements.get(window.closedContainerType)) {
        // We use a wrapper custom element to enclose all preview elements
        // which can contain privacy information.
        // It should guard them from accesses by webpage scripts.
        class ClosedContainer extends HTMLElement {
          constructor() {
            super();
            const shadow = this.attachShadow({ mode: 'closed' });
            const root = document.createElement('div');
            shadow.appendChild(root);
            tabPreviewPanel = new window.lastTabPreviewPanel(root); // don't touch "TabPreviewPanel" directly - it can be a reference to the obsolete one.
          }
        }
        window.customElements.define(window.closedContainerType, ClosedContainer);
      }
      const container = document.createElement(window.closedContainerType);
      document.documentElement.appendChild(container);

      const onMessage = (message, _sender) => {
        switch (message?.type) {
          case 'treestyletab:ask-tab-preview-container-ready':
            return Promise.resolve(true);

          case '${Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW}':
            if (logging)
              console.log('tab detached from window, destroy tab preview container');
            destroy();
            break;
        }
      };
      browser.runtime.onMessage.addListener(onMessage);

      const onMouseMove = () => {
        if (logging)
          console.log('mouse move on the content area, destroy tab preview container');
        browser.runtime.sendMessage({
          type: 'treestyletab:hide-tab-preview',
          timestamp: Date.now(),
        });
        destroy();
      };
      document.documentElement.addEventListener('mousemove', onMouseMove, { once: true });

      const destroy = () => {
        if (tabPreviewPanel) {
          tabPreviewPanel.destroy();
          tabPreviewPanel = null;
        }
        if (!container.parentNode)
          return;
        container.parentNode.removeChild(container);
        browser.runtime.onMessage.removeListener(onMessage);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('unload', destroy);
        window.removeEventListener('pagehide', destroy);
      };
      window.addEventListener('unload', destroy, { once: true });
      window.addEventListener('pagehide', destroy, { once: true });
    })()`,
  });
}

const hoveringTabIds = new Set();

function shouldMessageSend(message) {
  return (
    message.type != 'treestyletab:show-tab-preview' ||
    hoveringTabIds.has(message.previewTabId)
  );
}

// returns succeeded or not (boolean)
async function sendTabPreviewMessage(tabId, message, deferredResultResolver) {
  const canRenderInSidebar = !!(configs.tabPreviewTooltipRenderIn & Constants.kTAB_PREVIEW_PANEL_RENDER_IN_SIDEBAR);
  if (!tabId ||
      !(configs.tabPreviewTooltipRenderIn & Constants.kTAB_PREVIEW_PANEL_RENDER_IN_CONTENT)) { // in-sidebar mode
    if (canRenderInSidebar &&
        !message.hasCustomTooltip) {
      log(`sendTabPreviewMessage(${message.type}): no tab specified or sidebar only mode, fallback to in-sidebar preview`);
      return sendInSidebarTabPreviewMessage(message);
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

  let ready;
  let rawTab;
  try {
    const [gotReady, gotRawTab] = await Promise.all([
      browser.tabs.sendMessage(tabId, {
        type: 'treestyletab:ask-tab-preview-container-ready',
      }).catch(_error => {}),
      browser.tabs.get(tabId),
    ]);
    ready = gotReady;
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
        return sendInSidebarTabPreviewMessage(message)
          .then(() => {
            deferredResultResolver(true);
            return true;
          });
      }

      if (!shouldMessageSend(message)) {
        log(` => no response, already canceled, give up to send`);
        return false;
      }

      // We prepare tab preview panel now, and retry sending after that.
      log(` => no response, retry`);
      let resultResolver;
      const promisedResult = new Promise((resolve, _reject) => {
        resultResolver = resolve;
      });
      waitUntilPreviewContainerReadyInTab(tabId).then(() => {
        sendTabPreviewMessage(tabId, message, resultResolver);
      });
      await preparePreview(tabId);
      return promisedResult;
    }
  }
  catch (error) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): failed to ask to the tab `, error);
    // We cannot show tab preview tooltip in a tab with privileged contents.
    // Let's fall back to the in-sidebar tab preview.
    await sendInSidebarTabPreviewMessage(message);
    if (deferredResultResolver)
      deferredResultResolver(true);
    return true;
  }

  // hide in-sidebar tab preview if in-content tab preview is available
  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
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
      return sendInSidebarTabPreviewMessage(message)
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
    waitUntilPreviewContainerReadyInTab(tabId).then(() => {
      sendTabPreviewMessage(tabId, message, resultResolver);
    });
    await preparePreview(tabId);
    return promisedResult;
  }

  if (typeof response != 'boolean' &&
      shouldMessageSend(message)) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): got invalid response, fallback to in-sidebar preview`);
    // Failed to send message to the in-content tab preview panel, so
    // now we fall back to the in-sidebar tab preview.
    return sendInSidebarTabPreviewMessage(message);
  }

  // Everything is OK!
  return !!response;
}

async function waitUntilPreviewContainerReadyInTab(tabId) {
  let resolver;
  const promisedLoaded = new Promise((resolve, _reject) => {
    resolver = resolve;
  });
  let timeout;
  const onMessage = (message, sender) => {
    if (message?.type != 'treestyletab:tab-preview-ready' ||
        sender.tab?.id != tabId)
      return;
    log('waitUntilPreviewContainerReadyInTab: ready in the tab ', tabId);
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
    log('waitUntilPreviewContainerReadyInTab: timeout for the tab ', tabId);
    timeout = null;
    browser.runtime.onMessage.removeListener(onMessage);
    resolver();
  }, 1000);
  return promisedLoaded;
}


async function sendInSidebarTabPreviewMessage(message) {
  const startAt = message.startAt || Date.now();
  log(`sendInSidebarTabPreviewMessage(${message.type}})`);
  if (typeof message.previewURL == 'function')
    message.previewURL = await message.previewURL();
  await mTabPreviewPanel.handleMessage({
    timestamp: startAt,
    ...message,
    windowId: TabsStore.getCurrentWindowId(),
    animation: shouldApplyAnimation(),
    logging: configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug,
  });
  return true;
}

async function onTabSubstanceEnter(event) {
  const startAt = Date.now();

  const canCaptureTab = Permissions.isGrantedSync(Permissions.ALL_URLS);
  if (!canCaptureTab)
    return;

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());

  if (!configs.tabPreviewTooltip ||
      !(configs.tabPreviewTooltipRenderIn & Constants.kTAB_PREVIEW_PANEL_RENDER_IN_ANYWHERE)) {;
    sendTabPreviewMessage(activeTab.id, {
      type: 'treestyletab:hide-tab-preview',
    });
    return;
  }

  if (document.documentElement.classList.contains(Constants.kTABBAR_STATE_TAB_DRAGGING)) {
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

  log(`onTabSubstanceEnter(${event.target.tab.id}}) start `, startAt);

  hoveringTabIds.add(event.target.tab.id);
  const tooltipText = event.target.appliedTooltipText;
  const tooltipHtml = event.target.appliedTooltipHtml;
  const targetTabId = Permissions.canInjectScriptToTabSync(activeTab) ?
    activeTab.id :
    null;

  const previewTabRawRect = event.target.tab.$TST.element?.substanceElement?.getBoundingClientRect();
  const previewTabRect = {
    bottom: previewTabRawRect?.bottom || 0,
    height: previewTabRawRect?.height || 0,
    left:   previewTabRawRect?.left || 0,
    right:  previewTabRawRect?.right || 0,
    top:    previewTabRawRect?.top || 0,
    width:  previewTabRawRect?.width || 0,
  };

  // This calculation logic is buggy for a window in a screen placed at
  // left of the primary display and scaled. As the result, a sidebar
  // placed at left can be mis-detected as placed at right. For safety
  // I ignore such cases and always treat such cases as "left side placed".
  // See also: https://github.com/piroor/treestyletab/issues/2984#issuecomment-901907503
  const mayBeRight = window.screenX < 0 && window.devicePixelRatio > 1 ?
    false :
    window.mozInnerScreenX - window.screenX > (window.outerWidth - window.innerWidth) / 2;

  log(`onTabSubstanceEnter(${event.target.tab.id}}) [${Date.now() - startAt}msec from start]: show tab preview in ${targetTabId || 'sidebar'} `, { hasCustomTooltip, tooltipText, hasPreview });
  const succeeded = await sendTabPreviewMessage(targetTabId, {
    type: 'treestyletab:show-tab-preview',
    previewTabId: event.target.tab.id,
    previewTabRect,
    /* These information is used to calculate offset of the sidebar header */
    offsetTop: window.mozInnerScreenY - window.screenY,
    offsetLeft: window.mozInnerScreenX - window.screenX,
    align: mayBeRight ? 'right' : 'left',
    rtl: isRTL(),
    scale: 1 / window.devicePixelRatio,
    hasCustomTooltip,
    ...(hasCustomTooltip ?
      {
        tooltipHtml,
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
    waitInitialShowUntil: startAt + Math.max(configs.tabPreviewTooltipDelayMsec, 0),
    // Don't call Date.now() here, because it can become larger than
    // the timestamp on mouseleave.
    timestamp: startAt,
    canRetry: !!targetTabId,
  }).catch(error => {
    log(`onTabSubstanceEnter(${event.target.tab.id}}) failed: `, error);
  });
  log(` => ${succeeded ? 'succeeded' : 'failed'}`);

  if (!event.target.tab) // the tab may be destroyied while we capturing tab preview
    return;

  if (event.target.tab.$TST.element &&
      succeeded)
    event.target.tab.$TST.element.invalidateTooltip();
}
onTabSubstanceEnter = EventUtils.wrapWithErrorHandler(onTabSubstanceEnter);

async function onTabSubstanceLeave(event) {
  const startAt = Date.now();
  if (!event.target.tab)
    return;

  hoveringTabIds.delete(event.target.tab.id);

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  const targetTabId = await Permissions.canInjectScriptToTab(activeTab) ?
    activeTab.id :
    null;

  if (!event.target.tab) // the tab was closed while waiting
    return;

  log(`onTabSubstanceLeave(${event.target.tab.id}}) hide tab preview in ${targetTabId || 'sidebar'} `, startAt);
  sendTabPreviewMessage(targetTabId, {
    type: 'treestyletab:hide-tab-preview',
    previewTabId: event.target.tab.id,
    timestamp: startAt,
  });
}
onTabSubstanceLeave = EventUtils.wrapWithErrorHandler(onTabSubstanceLeave);


browser.tabs.onActivated.addListener(activeInfo => {
  const startAt = Date.now();

  if (activeInfo.windowId != TabsStore.getCurrentWindowId())
    return;

  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
  sendTabPreviewMessage(activeInfo.tabId, {
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
  sendTabPreviewMessage(activeInfo.previousTabId, {
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
});

Sidebar.onReady.addListener(() => {
  const windowId = TabsStore.getCurrentWindowId();
  mTabPreviewPanel.windowId = windowId;
});

document.querySelector('#tabbar').addEventListener('mouseleave', async () => {
  const startAt = Date.now();
  log('mouse is left from the tab bar ', startAt);

  hoveringTabIds.clear();

  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  sendTabPreviewMessage(activeTab.id, {
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
});
