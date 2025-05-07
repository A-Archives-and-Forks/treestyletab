/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Tree Style Tab.
 *
 * The Initial Developer of the Original Code is YUKI "Piro" Hiroshi.
 * Portions created by the Initial Developer are Copyright (C) 2011-2025
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 wanabe <https://github.com/wanabe>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *                 Xidorn Quan <https://github.com/upsuper> (Firefox 40+ support)
 *                 lv7777 (https://github.com/lv7777)
 *
 * ***** END LICENSE BLOCK ******/
'use strict';

/* ***** IMPORTANT NOTE FOR BETTER PERFORMANCE *****
   Functions in this module will be called very frequently while
   scrolling. We should not do operations causing style computation
   like calling getBoundingClientRect() or accessing to
   offsetWidth/Height/Top/Left. Instead use Size.getXXXXX() methods
   which return statically calculated sizes. If you need to get
   something more new size, add a logic to calculate it to
   Size.updateTabs() or Size.updateContainers().
   ************************************************* */

import EventListenerManager from '/extlib/EventListenerManager.js';
import { SequenceMatcher } from '/extlib/diff.js';

import {
  log as internalLogger,
  wait,
  nextFrame,
  configs,
  shouldApplyAnimation,
  watchOverflowStateChange,
  mapAndFilter,
} from '/common/common.js';

import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TSTAPI from '/common/tst-api.js';

import { Tab, TabGroup, TreeItem } from '/common/TreeItem.js';

import * as BackgroundConnection from './background-connection.js';
import * as CollapseExpand from './collapse-expand.js';
import * as EventUtils from './event-utils.js';
import * as RestoringTabCount from './restoring-tab-count.js';
import * as SidebarTabs from './sidebar-tabs.js';
import * as Size from './size.js';

export const onPositionUnlocked = new EventListenerManager();
export const onVirtualScrollViewportUpdated = new EventListenerManager();
export const onNormalTabsOverflow = new EventListenerManager();
export const onNormalTabsUnderflow = new EventListenerManager();

function log(...args) {
  internalLogger('sidebar/scroll', ...args);
}


export const LOCK_REASON_REMOVE   = 'remove';
export const LOCK_REASON_COLLAPSE = 'collapse';

const mPinnedScrollBox  = document.querySelector('#pinned-tabs-container');
const mNormalScrollBox  = document.querySelector('#normal-tabs-container');
const mTabBar           = document.querySelector('#tabbar');
const mOutOfViewTabNotifier = document.querySelector('#out-of-view-tab-notifier');

let mTabbarSpacerSize = 0;

let mScrollingInternallyCount = 0;

export function init(scrollPosition) {
  // We should cached scroll positions, because accessing to those properties is slow.
  mPinnedScrollBox.$scrollTop    = 0;
  mPinnedScrollBox.$scrollTopMax = mPinnedScrollBox.scrollTopMax;
  mPinnedScrollBox.$offsetHeight = mPinnedScrollBox.offsetHeight;
  mNormalScrollBox.$scrollTop    = 0;
  mNormalScrollBox.$scrollTopMax = mNormalScrollBox.scrollTopMax;
  mNormalScrollBox.$offsetHeight = mNormalScrollBox.offsetHeight;

  // We need to register the lister as non-passive to cancel the event.
  // https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener#Improving_scrolling_performance_with_passive_listeners
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  mPinnedScrollBox.addEventListener('scroll', onScroll);
  mNormalScrollBox.addEventListener('scroll', onScroll);
  startObserveOverflowStateChange();
  browser.runtime.onMessage.addListener(onMessage);
  BackgroundConnection.onMessage.addListener(onBackgroundMessage);
  TSTAPI.onMessageExternal.addListener(onMessageExternal);
  SidebarTabs.onNormalTabsChanged.addListener(_tab => {
    reserveToRenderVirtualScrollViewport({ trigger: 'tabsChanged' });
  });
  Tab.onNativeGroupModified.addListener(_tab => {
    reserveToRenderVirtualScrollViewport({ trigger: 'tabsChanged' });
  });
  Size.onUpdated.addListener(() => {
    mPinnedScrollBox.$scrollTopMax = mPinnedScrollBox.scrollTopMax;
    mPinnedScrollBox.$offsetHeight = mPinnedScrollBox.offsetHeight;
    mNormalScrollBox.$scrollTopMax = mNormalScrollBox.scrollTopMax;
    mNormalScrollBox.$offsetHeight = mNormalScrollBox.offsetHeight;
    reserveToRenderVirtualScrollViewport({ trigger: 'resized', force: true });
  });

  reserveToRenderVirtualScrollViewport({ trigger: 'initialize' });
  if (typeof scrollPosition != 'number')
    return;

  if (scrollPosition <= mNormalScrollBox.$scrollTopMax) {
    mNormalScrollBox.scrollTop =
      mNormalScrollBox.$scrollTop = Math.max(0, scrollPosition);
    return;
  }

  mScrollingInternallyCount++;
  restoreScrollPosition.scrollPosition = scrollPosition;
  onNormalTabsOverflow.addListener(onInitialOverflow);
  onVirtualScrollViewportUpdated.addListener(onInitialUpdate);
  wait(1000).then(() => {
    onNormalTabsOverflow.removeListener(onInitialOverflow);
    onVirtualScrollViewportUpdated.removeListener(onInitialUpdate);
    if (restoreScrollPosition.scrollPosition != -1 &&
        mScrollingInternallyCount > 0)
      mScrollingInternallyCount--;
    restoreScrollPosition.scrollPosition = -1;
    log('timeout: give up to restore scroll position');
  });
}

function startObserveOverflowStateChange() {
  watchOverflowStateChange({
    target: mNormalScrollBox,
    vertical: true,
    moreResizeTargets: [
      // We need to watch resizing of the virtual scroll container to detect the changed state correctly.
      mNormalScrollBox.querySelector('.virtual-scroll-container'),
    ],
    onOverflow() { onNormalTabsOverflow.dispatch(); },
    onUnderflow() { onNormalTabsUnderflow.dispatch(); },
  });

  onNormalTabsOverflow.addListener(() => {
    reserveToUpdateScrolledState(mNormalScrollBox);
  });
  onNormalTabsUnderflow.addListener(() => {
    reserveToUpdateScrolledState(mNormalScrollBox);
  });
}

function onInitialOverflow() {
  onNormalTabsOverflow.removeListener(onInitialOverflow);
  onInitialOverflow.done = true;
  if (onInitialUpdate.done)
    restoreScrollPosition();
}
function onInitialUpdate() {
  onVirtualScrollViewportUpdated.removeListener(onInitialUpdate);
  onInitialUpdate.done = true;
  if (onInitialOverflow.done)
    restoreScrollPosition();
}
function restoreScrollPosition() {
  if (restoreScrollPosition.retryCount < 10 &&
      restoreScrollPosition.scrollPosition > mNormalScrollBox.$scrollTopMax) {
    restoreScrollPosition.retryCount++;
    return window.requestAnimationFrame(restoreScrollPosition);
  }

  if (restoreScrollPosition.scrollPosition <= mNormalScrollBox.$scrollTopMax)
    mNormalScrollBox.scrollTop =
      mNormalScrollBox.$scrollTop = Math.max(
        0,
        restoreScrollPosition.scrollPosition
      );
  restoreScrollPosition.scrollPosition = -1;
  if (mScrollingInternallyCount > 0) {
    window.requestAnimationFrame(() => {
      if (mScrollingInternallyCount > 0)
        mScrollingInternallyCount--;
    });
  }
}
restoreScrollPosition.retryCount = 0;
restoreScrollPosition.scrollPosition = -1;


/* virtual scrolling */

export function reserveToRenderVirtualScrollViewport({ trigger, force } = {}) {
  if (!force &&
      mScrollingInternallyCount > 0)
    return;

  if (trigger)
    renderVirtualScrollViewport.triggers.add(trigger);

  if (renderVirtualScrollViewport.invoked)
    return;
  renderVirtualScrollViewport.invoked = true;
  window.requestAnimationFrame(() => renderVirtualScrollViewport());
}

let mLastRenderableItems;
let mLastDisappearingItems;
let mLastRenderedVirtualScrollItemIds = [];
const STICKY_SPACER_MATCHER = /^tab:(\d+):sticky$/;
let mScrollPosition = 0;

function getRenderableTreeItems(windowId = null) {
  if (TabsStore.nativelyGroupedTabsInWindow.get(windowId).size == 0) {
    log('getRenderableTreeItems: no native tab group');
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.virtualScrollRenderableTabsInWindow, windowId),
      skipMatching: true,
      ordered: true,
    });
  }

  const mixedItems = TreeItem.sort([
    ...TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.virtualScrollRenderableTabsInWindow, windowId),
      skipMatching: true,
    }),
    ...mapAndFilter(
      [...TabsStore.windows.get(windowId).tabGroups.values()],
      group => {
        const firstMember = TabGroup.getFirstMemberTab({ windowId, groupId: group.id });
        if (!firstMember) {
          return undefined;
        }
        group.index = firstMember.index;
        return group;
      }
    )
  ]);
  log('getRenderableTreeItems: mixedItems = ', mixedItems);

  return mixedItems;
};

renderVirtualScrollViewport.triggers = new Set();

function renderVirtualScrollViewport(scrollPosition = undefined) {
  renderVirtualScrollViewport.invoked = false;
  const triggers = new Set([...renderVirtualScrollViewport.triggers]);
  renderVirtualScrollViewport.triggers.clear();

  const startAt = Date.now();

  const windowId = TabsStore.getCurrentWindowId();
  const win      = TabsStore.windows.get(windowId);
  if (!win ||
      !win.containerElement)
    return; // not initialized yet


  const outOfScreenPages = configs.outOfScreenTabsRenderingPages;
  const staticRendering  = outOfScreenPages < 0;
  const skipRefreshItems = staticRendering && triggers.size == 1 && triggers.has('scroll');

  const itemSize           = Size.getRenderedTabHeight();
  const renderableItems   = skipRefreshItems && mLastRenderableItems || getRenderableTreeItems(windowId);
  const disappearingItems = skipRefreshItems && mLastDisappearingItems || renderableItems.filter(item => item.$TST.removing || item.$TST.states.has(Constants.kTAB_STATE_COLLAPSING));
  const totalRenderableItemsSize = Size.getTabMarginBlockStart() + (itemSize * (renderableItems.length - disappearingItems.length)) + Size.getTabMarginBlockEnd();
  const viewPortSize = Size.getNormalTabsViewPortSize();

  if (staticRendering) {
    mLastRenderableItems = renderableItems;
    mLastDisappearingItems = disappearingItems;
  }

  // For underflow case, we need to unset min-height to put the "new tab"
  // button next to the last tab immediately.
  // We need to set the style value directly instead of using custom properties, to reduce needless style computation.
  mNormalScrollBox.querySelector('.virtual-scroll-container').style.minHeight = `${viewPortSize < totalRenderableItemsSize ? totalRenderableItemsSize : 0}px`;

  const totalItemsSizeHolder = win.containerElement.parentNode;
  const resized              = totalItemsSizeHolder.$lastHeight != totalRenderableItemsSize;
  totalItemsSizeHolder.$lastHeight = totalRenderableItemsSize;
  if (resized) {
    mNormalScrollBox.$offsetHeight = mNormalScrollBox.offsetHeight;
    mNormalScrollBox.$scrollTopMax = /*mNormalScrollBox.scrollTopMax*/Math.max(0, totalRenderableItemsSize - viewPortSize);
  }

  const renderablePaddingSize = staticRendering ?
    totalRenderableItemsSize :
    viewPortSize * outOfScreenPages;
  scrollPosition = Math.max(
    0,
    Math.min(
      totalRenderableItemsSize + mTabbarSpacerSize - viewPortSize,
      typeof scrollPosition == 'number' ?
        scrollPosition :
        restoreScrollPosition.scrollPosition > -1 ?
          restoreScrollPosition.scrollPosition :
          mNormalScrollBox.$scrollTop
    )
  );
  mScrollPosition = scrollPosition;

  const firstRenderableIndex = Math.max(
    0,
    Math.floor((scrollPosition - renderablePaddingSize) / itemSize)
  );
  const lastRenderableIndex = Math.max(
    0,
    Math.min(
      renderableItems.length - 1,
      Math.ceil((scrollPosition + viewPortSize + renderablePaddingSize) / itemSize)
    )
  );
  const renderedOffset = itemSize * firstRenderableIndex;
  // We need to set the style value directly instead of using custom properties, to reduce needless style computation.
  mNormalScrollBox.querySelector('.tabs').style.transform = staticRendering ?
    '' :
    `translateY(${renderedOffset}px)`;
  // We need to shift contents one more, to cover the reduced height due to the sticky tab.

  if (resized) {
    reserveToUpdateScrolledState(mNormalScrollBox)
    onVirtualScrollViewportUpdated.dispatch(resized);
  }

  const stickyItems = updateStickyItems(renderableItems, { staticRendering, skipRefreshItems });

  if (skipRefreshItems) {
    log('renderVirtualScrollViewport: skip re-rendering of tabs, rendered = ', renderableItems);
    if (mLastRenderedVirtualScrollItemIds.length != renderableItems.length) {
      mLastRenderedVirtualScrollItemIds = renderableItems.map(tab => tab.$TST.renderingId);
    }
  }
  else {
    const toBeRenderedItems = renderableItems.slice(firstRenderableIndex, lastRenderableIndex + 1);
    const toBeRenderedItemIds = toBeRenderedItems.map(item => item.$TST.renderingId);
    const toBeRenderedItemIdsSet = new Set(toBeRenderedItemIds);
    for (const stickyItem of stickyItems) {
      const id = stickyItem.$TST.renderingId;
      if (toBeRenderedItemIdsSet.has(id)) {
        toBeRenderedItemIds.splice(toBeRenderedItemIds.indexOf(id), 1, `${id}:sticky`);
      }
    }

    const renderOperations = (new SequenceMatcher(mLastRenderedVirtualScrollItemIds, toBeRenderedItemIds)).operations();
    log('renderVirtualScrollViewport ', {
      firstRenderableIndex,
      firstRenderableItemIndex: renderableItems[firstRenderableIndex]?.index,
      lastRenderableIndex,
      lastRenderableItemIndex: renderableItems[lastRenderableIndex]?.index,
      old: mLastRenderedVirtualScrollItemIds.slice(0),
      new: toBeRenderedItemIds.slice(0),
      renderOperations,
      scrollPosition,
      viewPortSize,
      totalRenderableItemsSize,
    });

    const toBeRenderedItemIdSet = new Set(toBeRenderedItemIds);
    for (const operation of renderOperations) {
      const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
      switch (tag) {
        case 'equal':
          break;

        case 'delete': {
          const ids = mLastRenderedVirtualScrollItemIds.slice(fromStart, fromEnd);
          //log('delete: ', { fromStart, fromEnd, toStart, toEnd }, ids);
          for (const id of ids) {
            if (STICKY_SPACER_MATCHER.test(id)) {
              const spacer = win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${RegExp.$1}"]`);
              if (spacer)
                spacer.parentNode.removeChild(spacer);
              continue;
            }
            const item = getRenderableItemById(id);
            if (item?.$TST.element?.parentNode != win.containerElement) // already sticky
              continue;
            // We don't need to remove already rendered item,
            // because it is automatically moved by insertBefore().
            if (toBeRenderedItemIdSet.has(id) ||
                !item ||
                !mNormalScrollBox.contains(item.$TST.element))
              continue;
            SidebarTabs.unrenderTab(item);
          }
        }; break;

        case 'insert':
        case 'replace': {
          const deleteIds = mLastRenderedVirtualScrollItemIds.slice(fromStart, fromEnd);
          const insertIds = toBeRenderedItemIds.slice(toStart, toEnd);
          //log('insert or replace: ', { fromStart, fromEnd, toStart, toEnd }, deleteIds, ' => ', insertIds);
          for (const id of deleteIds) {
            if (STICKY_SPACER_MATCHER.test(id)) {
              const spacer = win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${RegExp.$1}"]`);
              if (spacer)
                spacer.parentNode.removeChild(spacer);
              continue;
            }
            const item = getRenderableItemById(id);
            if (item?.$TST.element?.parentNode != win.containerElement) // already sticky
              continue;
            // We don't need to remove already rendered tab,
            // because it is automatically moved by insertBefore().
            if (toBeRenderedItemIdSet.has(id) ||
                !item ||
                !mNormalScrollBox.contains(item.$TST.element))
              continue;
            SidebarTabs.unrenderTab(item);
          }
          const referenceItem = fromEnd < mLastRenderedVirtualScrollItemIds.length ?
            getRenderableItemById(mLastRenderedVirtualScrollItemIds[fromEnd]) :
            null;
          const referenceItemHasValidReferenceElement = referenceItem?.$TST.element?.parentNode == win.containerElement;
          for (const id of insertIds) {
            if (STICKY_SPACER_MATCHER.test(id)) {
              const spacer = document.createElement('li');
              spacer.classList.add('sticky-tab-spacer');
              spacer.setAttribute('data-tab-id', RegExp.$1);
              win.containerElement.insertBefore(
                spacer,
                (referenceItem && win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${referenceItem.id}"]`)) ||
                (referenceItemHasValidReferenceElement &&
                 referenceItem.$TST.element) ||
                null
              );
              continue;
            }
            const item = getRenderableItemById(id);
            SidebarTabs.renderTab(item, {
              insertBefore: referenceItemHasValidReferenceElement ? referenceItem :
                (referenceItem && win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${referenceItem.id}"]`)) ||
                null,
            });
          }
        }; break;
      }
    }
    mLastRenderedVirtualScrollItemIds = toBeRenderedItemIds;
  }

  log(`${Date.now() - startAt} msec, offset = ${renderedOffset}`);
}
function getRenderableItemById(id) {
  if (STICKY_SPACER_MATCHER.test(id)) {
    return Tab.get(parseInt(RegExp.$1));
  }

  const [type, rawId] = id.split(':');
  switch (type) {
    case 'group':
      return TabGroup.get({
        windowId: TabsStore.getCurrentWindowId(),
        groupId:  parseInt(rawId),
      });

    case 'tab':
    default:
      return Tab.get(parseInt(rawId));
  }

  return null;
}

let mLastStickyItemIdsAbove = new Set();
let mLastStickyItemIdsBelow = new Set();
let mLastCanBeStickyItems;

function updateStickyItems(renderableItems, { staticRendering, skipRefreshItems } = {}) {
  const itemSize       = Size.getRenderedTabHeight();
  const windowId       = TabsStore.getCurrentWindowId();
  const scrollPosition = mScrollPosition;
  const viewPortSize   = Size.getNormalTabsViewPortSize();

  const firstInViewportIndex = Math.ceil(scrollPosition / itemSize);
  const lastInViewportIndex  = Math.floor((scrollPosition + viewPortSize - itemSize) / itemSize);

  const stickyItemIdsAbove = new Set();
  const stickyItemIdsBelow = new Set();
  const stickyItems = [];

  const canBeStickyItems = skipRefreshItems && mLastCanBeStickyItems || renderableItems.filter(item => item.$TST.canBecomeSticky);
  log('canBeStickyItems ', canBeStickyItems);
  if (staticRendering)
    mLastCanBeStickyItems = canBeStickyItems;

  const removedOrCollapsedTabsCount = parseInt(mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`).dataset.removedOrCollapsedTabsCount || 0);
  for (const item of canBeStickyItems.slice(0).reverse()) { // first try: find bottom sticky tabs from bottom
    const index = renderableItems.indexOf(item);
    if (index > -1 &&
        index > (lastInViewportIndex - stickyItemIdsBelow.size) &&
        mNormalScrollBox.$scrollTop < mNormalScrollBox.$scrollTopMax &&
        (index - (lastInViewportIndex - stickyItemIdsBelow.size) > 1 ||
         removedOrCollapsedTabsCount == 0)) {
      stickyItemIdsBelow.add(item.id);
      continue;
    }
    if (stickyItemIdsBelow.size > 0)
      break;
  }

  for (const item of canBeStickyItems) { // second try: find top sticky tabs and set bottom sticky tabs
    const index = renderableItems.indexOf(item);
    if (index > -1 &&
        index < (firstInViewportIndex + stickyItemIdsAbove.size) &&
        mNormalScrollBox.$scrollTop > 0) {
      stickyItems.push(item);
      stickyItemIdsAbove.add(item.id);
      continue;
    }
    if (stickyItemIdsBelow.has(item.id)) {
      stickyItems.push(item);
      continue;
    }
    if (item.$TST.element &&
        item.$TST.element.parentNode != TabsStore.windows.get(windowId).containerElement) {
      SidebarTabs.unrenderTab(item);
      continue;
    }
  }

  for (const [lastIds, currentIds, place] of [
    [[...mLastStickyItemIdsAbove], [...stickyItemIdsAbove], 'above'],
    [[...mLastStickyItemIdsBelow].reverse(), [...stickyItemIdsBelow].reverse(), 'below'],
  ]) {
    const renderOperations = (new SequenceMatcher(lastIds, currentIds)).operations();
    for (const operation of renderOperations) {
      const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
      switch (tag) {
        case 'equal':
          break;

        case 'delete': {
          const ids = lastIds.slice(fromStart, fromEnd);
          for (const id of ids) {
            if (!stickyItemIdsAbove.has(id) &&
                !stickyItemIdsBelow.has(id))
              SidebarTabs.unrenderTab(Tab.get(id));
          }
        }; break;

        case 'insert':
        case 'replace': {
          const deleteIds = lastIds.slice(fromStart, fromEnd);
          for (const id of deleteIds) {
            if (!stickyItemIdsAbove.has(id) &&
                !stickyItemIdsBelow.has(id))
              SidebarTabs.unrenderTab(Tab.get(id));
          }
          const insertIds = currentIds.slice(toStart, toEnd);
          const referenceItem = (fromEnd < lastIds.length && currentIds.includes(lastIds[fromEnd])) ?
            Tab.get(lastIds[fromEnd]) :
            null;
          for (const id of insertIds) {
            SidebarTabs.renderTab(Tab.get(id), {
              containerElement: document.querySelector(`.sticky-tabs-container.${place}`),
              insertBefore:     referenceItem,
            });
          }
        }; break;
      }
    }
  }

  log('updateStickyItems ', stickyItems, { above: [...stickyItemIdsAbove], below: [...stickyItemIdsBelow] });
  mLastStickyItemIdsAbove = stickyItemIdsAbove;
  mLastStickyItemIdsBelow = stickyItemIdsBelow;

  return stickyItems;
}

function getScrollBoxFor(item, { allowFallback } = {}) {
  if (!item || !item.pinned)
    return mNormalScrollBox; // the default
  if (allowFallback &&
      mPinnedScrollBox.$scrollTopMax == 0) {
    log('pinned tabs are not scrollable, fallback to normal tabs');
    return mNormalScrollBox;
  }
  return mPinnedScrollBox;
}

export function getItemRect(item) {
  if (item.pinned)
    return item.$TST.element.getBoundingClientRect();

  const renderableItems = getRenderableTreeItems(item.windowId).map(item => item.id);
  const itemSize       = Size.getTabHeight();
  const scrollBox      = getScrollBoxFor(item);
  const scrollBoxRect  = Size.getScrollBoxRect(scrollBox);

  let index = renderableItems.indexOf(item.id);
  if (index < 0) { // the item is not renderable yet, so we calculate the index based on other items.
    const following = item.$TST.nearestVisibleFollowingTab;
    if (following) {
      index = renderableItems.indexOf(following.id);
    }
    else {
      const preceding = item.$TST.nearestVisiblePrecedingTab;
      if (preceding) {
        index = renderableItems.indexOf(preceding.id);
        if (index > -1)
          index++;
      }
    }
    if (index < -1) // no nearest visible item: treat as a last item
      index = renderableItems.length;
  }
  const itemTop = Size.getRenderedTabHeight() * index + scrollBoxRect.top - scrollBox.$scrollTop;
  /*
  console.log('coordinates of tab rect ', {
    index,
    renderableItemHeight: Size.getRenderedTabHeight(),
    scrollBox_rectTop: scrollBoxRect.top,
    scrollBox_$scrollTop: scrollBox.$scrollTop,
  });
  */
  return {
    top:    itemTop,
    bottom: itemTop + itemSize,
    height: itemSize,
  };
}

configs.$addObserver(key => {
  switch (key) {
    case 'outOfScreenTabsRenderingPages':
      mLastRenderableItems   = null;
      mLastDisappearingItems = null;
      mLastCanBeStickyItems  = null;
      break;
  }
});


/* basic operations */

function scrollTo(params = {}) {
  log('scrollTo ', params);
  if (!params.justNow &&
      shouldApplyAnimation(true) &&
      configs.smoothScrollEnabled)
    return smoothScrollTo(params);

  //cancelPerformingAutoScroll();
  const scrollBox = getScrollBoxFor(params.tab, { allowFallback: true });
  const scrollTop = params.tab ?
    scrollBox.$scrollTop + calculateScrollDeltaForTab(params.tab) :
    typeof params.position == 'number' ?
      params.position :
      typeof params.delta == 'number' ?
        mNormalScrollBox.$scrollTop + params.delta :
        undefined;
  if (scrollTop === undefined)
    throw new Error('No parameter to indicate scroll position');

  // render before scroll, to prevent showing blank area
  mScrollingInternallyCount++;
  renderVirtualScrollViewport(scrollTop);
  scrollBox.scrollTop =
    scrollBox.$scrollTop = Math.min(
      scrollBox.$scrollTopMax,
      Math.max(0, scrollTop)
    );
  window.requestAnimationFrame(() => {
    if (mScrollingInternallyCount > 0)
      mScrollingInternallyCount--;
  });
}

function cancelRunningScroll() {
  scrollToTab.stopped = true;
  stopSmoothScroll();
}

function calculateScrollDeltaForTab(tab, { over } = {}) {
  tab = Tab.get(tab && tab.id);
  if (!tab)
    return 0;

  tab = tab.$TST.collapsed && tab.$TST.nearestVisibleAncestorOrSelf || tab;

  const tabRect       = getItemRect(tab);
  const scrollBoxRect = Size.getScrollBoxRect(getScrollBoxFor(tab, { allowFallback: true }));
  const overScrollOffset = over === false ?
    0 :
    Math.ceil(tabRect.height / 2);
  let delta = 0;
  if (scrollBoxRect.bottom < tabRect.bottom) { // should scroll down
    delta = tabRect.bottom - scrollBoxRect.bottom + overScrollOffset;
    if (mLastStickyItemIdsBelow.has(tab.id) &&
        mLastStickyItemIdsBelow.size > 0)
      delta += tabRect.height * (mLastStickyItemIdsBelow.size - 1);
    else
      delta += tabRect.height * mLastStickyItemIdsBelow.size;
  }
  else if (scrollBoxRect.top > tabRect.top) { // should scroll up
    delta = tabRect.top - scrollBoxRect.top - overScrollOffset;
    if (mLastStickyItemIdsAbove.has(tab.id) &&
        mLastStickyItemIdsAbove.size > 0)
      delta -= tabRect.height * (mLastStickyItemIdsAbove.size - 1);
    else
      delta -= tabRect.height * mLastStickyItemIdsAbove.size;
  }
  log('calculateScrollDeltaForTab ', tab.id, {
    delta,
    tabTop:          tabRect.top,
    tabBottom:       tabRect.bottom,
    scrollBoxBottom: scrollBoxRect.bottom
  });
  return delta;
}

export function isTabInViewport(tab, { allowPartial } = {}) {
  tab = Tab.get(tab && tab.id);
  if (!TabsStore.ensureLivingTab(tab))
    return false;

  if (tab.pinned)
    return true;

  const tabRect       = getItemRect(tab);
  const allowedOffset = allowPartial ? (tabRect.height / 2) : 0;
  const scrollBoxRect = Size.getScrollBoxRect(getScrollBoxFor(tab));
  log('isTabInViewport ', tab.id, {
    allowedOffset,
    tabTop:         tabRect.top + allowedOffset,
    tabBottom:      tabRect.bottom - allowedOffset,
    viewPortTop:    scrollBoxRect.top,
    viewPortBottom: scrollBoxRect.bottom,
  });
  return (
    tabRect.top + allowedOffset >= scrollBoxRect.top &&
    tabRect.bottom - allowedOffset <= scrollBoxRect.bottom
  );
}

async function smoothScrollTo(params = {}) {
  log('smoothScrollTo ', params, new Error().stack);
  //cancelPerformingAutoScroll(true);

  smoothScrollTo.stopped = false;

  const scrollBox = params.scrollBox || getScrollBoxFor(params.tab, { allowFallback: true });

  let delta, startPosition, endPosition;
  if (params.tab) {
    startPosition = scrollBox.$scrollTop;
    delta       = calculateScrollDeltaForTab(params.tab);
    endPosition = startPosition + delta;
  }
  else if (typeof params.position == 'number') {
    startPosition = scrollBox.$scrollTop;
    endPosition = params.position;
    delta       = endPosition - startPosition;
  }
  else if (typeof params.delta == 'number') {
    startPosition = scrollBox.$scrollTop;
    endPosition = startPosition + params.delta;
    delta       = params.delta;
  }
  else {
    throw new Error('No parameter to indicate scroll position');
  }
  smoothScrollTo.currentOffset = delta;

  const duration  = Math.max(0, typeof params.duration == 'number' ? params.duration : configs.smoothScrollDuration);
  const startTime = Date.now();

  return new Promise((resolve, _reject) => {
    const radian = 90 * Math.PI / 180;
    const scrollStep = () => {
      if (smoothScrollTo.stopped) {
        smoothScrollTo.currentOffset = 0;
        //reject('smooth scroll is canceled');
        resolve();
        return;
      }
      const nowTime = Date.now();
      const spentTime = nowTime - startTime;
      if (spentTime >= duration) {
        scrollTo({
          position: endPosition,
          justNow: true
        });
        smoothScrollTo.stopped       = true;
        smoothScrollTo.currentOffset = 0;
        resolve();
        return;
      }
      const power        = Math.sin(spentTime / duration * radian);
      const currentDelta = parseInt(delta * power);
      const newPosition  = startPosition + currentDelta;
      scrollTo({
        position: newPosition,
        justNow:  true
      });
      smoothScrollTo.currentOffset = currentDelta;
      window.requestAnimationFrame(scrollStep);
    };
    window.requestAnimationFrame(scrollStep);
  });
}
smoothScrollTo.currentOffset= 0;

async function smoothScrollBy(delta) {
  const scrollBox = getScrollBoxFor(
    Tab.getActiveTab(TabsStore.getCurrentWindowId()),
    { allowFallback: true }
  );
  return smoothScrollTo({
    position: scrollBox.$scrollTop + delta,
    scrollBox,
  });
}

function stopSmoothScroll() {
  smoothScrollTo.stopped = true;
}

/* advanced operations */

export function scrollToNewTab(tab, options = {}) {
  if (!canScrollToTab(tab))
    return;

  if (configs.scrollToNewTabMode == Constants.kSCROLL_TO_NEW_TAB_IF_POSSIBLE) {
    const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
    scrollToTab(tab, {
      ...options,
      anchor:            !activeTab.pinned && isTabInViewport(activeTab) && activeTab,
      notifyOnOutOfView: true
    });
  }
}

function canScrollToTab(tab) {
  tab = Tab.get(tab && tab.id);
  return (TabsStore.ensureLivingTab(tab) &&
          !tab.hidden);
}

export async function scrollToTab(tab, options = {}) {
  scrollToTab.lastTargetId = null;

  log('scrollToTab to ', tab && tab.id, options.anchor && options.anchor.id, options,
      { stack: configs.debug && new Error().stack });
  cancelRunningScroll();
  if (!canScrollToTab(tab)) {
    log('=> unscrollable');
    return;
  }

  scrollToTab.stopped = false;
  cancelNotifyOutOfViewTab();
  //cancelPerformingAutoScroll(true);

  await nextFrame();
  if (scrollToTab.stopped)
    return;
  cancelNotifyOutOfViewTab();

  const anchorTab = options.anchor;
  const hasAnchor = TabsStore.ensureLivingTab(anchorTab) && anchorTab != tab;
  const openedFromPinnedTab = hasAnchor && anchorTab.pinned;

  if (isTabInViewport(tab) &&
      (!hasAnchor ||
       !openedFromPinnedTab)) {
    log('=> already visible');
    return;
  }

  // wait for one more frame, to start collapse/expand animation
  await nextFrame();
  if (scrollToTab.stopped)
    return;
  cancelNotifyOutOfViewTab();
  scrollToTab.lastTargetId = tab.id;

  const scrollBox = getScrollBoxFor(tab);
  if (hasAnchor &&
      !anchorTab.pinned) {
    const targetItemRect = getItemRect(tab);
    const anchorItemRect = getItemRect(anchorTab);
    const scrollBoxRect = Size.getScrollBoxRect(scrollBox);
    let delta = calculateScrollDeltaForTab(tab, { over: false });

    let topStickyItemsAreaSize, bottomStickyItemsAreaSize;
    if (mLastStickyItemIdsAbove.has(anchorTab.id) &&
        mLastStickyItemIdsAbove.size > 0)
      topStickyItemsAreaSize = Size.getRenderedTabHeight() * (mLastStickyItemIdsAbove.size - 1);
    else
      topStickyItemsAreaSize = Size.getRenderedTabHeight() * mLastStickyItemIdsAbove.size;

    if (mLastStickyItemIdsBelow.has(tab.id) &&
        mLastStickyItemIdsBelow.size > 0)
      bottomStickyItemsAreaSize = Size.getRenderedTabHeight() * (mLastStickyItemIdsBelow.size - 1);
    else
      bottomStickyItemsAreaSize = Size.getRenderedTabHeight() * mLastStickyItemIdsBelow.size;

    if (targetItemRect.top > anchorItemRect.top) {
      log('=> will scroll down');
      const boundingHeight = (targetItemRect.bottom + bottomStickyItemsAreaSize) - (anchorItemRect.top - topStickyItemsAreaSize);
      const overHeight     = boundingHeight - scrollBoxRect.height;
      if (overHeight > 0) {
        delta -= overHeight;
        if (options.notifyOnOutOfView)
          notifyOutOfViewTab(tab);
      }
      log('calculated result: ', {
        boundingHeight, overHeight, delta,
        container:      scrollBoxRect.height
      });
    }
    else if (targetItemRect.bottom < anchorItemRect.bottom) {
      log('=> will scroll up');
      const boundingHeight = anchorItemRect.bottom - targetItemRect.top;
      const overHeight     = boundingHeight - scrollBoxRect.height;
      if (overHeight > 0)
        delta += overHeight;
      log('calculated result: ', {
        boundingHeight, overHeight, delta,
        container:      scrollBoxRect.height
      });
    }
    await scrollTo({
      ...options,
      position: scrollBox.$scrollTop + delta,
    });
  }
  else {
    await scrollTo({
      ...options,
      tab
    });
  }
  // A tab can be moved after the tabbar is scrolled to the tab.
  // To retry "scroll to tab" behavior for such cases, we need to
  // keep "last scrolled-to tab" information until the tab is
  // actually moved.
  await wait(configs.tabBunchesDetectionTimeout);
  if (scrollToTab.stopped)
    return;
  const retryOptions = {
    retryCount: options.retryCount || 0,
    anchor:     options.anchor
  };
  if (scrollToTab.lastTargetId == tab.id &&
      !isTabInViewport(tab) &&
      (!options.anchor ||
       !isTabInViewport(options.anchor)) &&
      retryOptions.retryCount < 3) {
    retryOptions.retryCount++;
    return scrollToTab(tab, retryOptions);
  }
  if (scrollToTab.lastTargetId == tab.id)
    scrollToTab.lastTargetId = null;
}
scrollToTab.lastTargetId = null;

/*
function scrollToTabSubtree(tab) {
  return scrollToTab(tab.$TST.lastDescendant, {
    anchor:            tab,
    notifyOnOutOfView: true
  });
}

function scrollToTabs(tabs) {
  return scrollToTab(tabs[tabs.length - 1], {
    anchor:            tabs[0],
    notifyOnOutOfView: true
  });
}
*/

export function autoScrollOnMouseEvent(event) {
  if (!event.target.closest ||
      autoScrollOnMouseEvent.invoked)
    return;

  const scrollBox = event.target.closest(`#${mPinnedScrollBox.id}, #${mNormalScrollBox.id}`);
  if (!scrollBox ||
      !scrollBox.classList.contains(Constants.kTABBAR_STATE_OVERFLOW))
    return;

  autoScrollOnMouseEvent.invoked = true;
  window.requestAnimationFrame(() => {
    autoScrollOnMouseEvent.invoked = false;

    const tabbarRect = Size.getScrollBoxRect(scrollBox);
    const scrollPixels = Math.round(Size.getRenderedTabHeight() * 0.5);
    if (event.clientY < tabbarRect.top + autoScrollOnMouseEvent.areaSize) {
      if (scrollBox.$scrollTop > 0)
        scrollBox.scrollTop =
          scrollBox.$scrollTop = Math.min(
            scrollBox.$scrollTopMax,
            Math.max(
              0,
              scrollBox.$scrollTop - scrollPixels
            )
          );
    }
    else if (event.clientY > tabbarRect.bottom - autoScrollOnMouseEvent.areaSize) {
      if (scrollBox.$scrollTop < scrollBox.$scrollTopMax)
        scrollBox.scrollTop =
          scrollBox.$scrollTop = Math.min(
            scrollBox.$scrollTopMax,
            Math.max(
              0,
              scrollBox.$scrollTop + scrollPixels
            )
          );
    }
  });
}
autoScrollOnMouseEvent.areaSize = 20;


async function notifyOutOfViewTab(tab) {
  tab = Tab.get(tab && tab.id);
  if (RestoringTabCount.hasMultipleRestoringTabs()) {
    log('notifyOutOfViewTab: skip until completely restored');
    wait(100).then(() => notifyOutOfViewTab(tab));
    return;
  }
  await nextFrame();
  cancelNotifyOutOfViewTab();
  if (tab && isTabInViewport(tab))
    return;
  mOutOfViewTabNotifier.classList.add('notifying');
  await wait(configs.outOfViewTabNotifyDuration);
  cancelNotifyOutOfViewTab();
}

function cancelNotifyOutOfViewTab() {
  mOutOfViewTabNotifier.classList.remove('notifying');
}


/* event handling */

async function onWheel(event) {
  // Ctrl-WheelScroll produces zoom-in/out on all platforms
  // including macOS (not Meta-WheelScroll!).
  // Pinch-in/out on macOS also produces zoom-in/out and
  // it is cancelable via synthesized `wheel` event.
  // (See also: https://bugzilla.mozilla.org/show_bug.cgi?id=1777199#c5 )
  if (!configs.zoomable &&
      event.ctrlKey) {
    event.preventDefault();
    return;
  }

  const tab = EventUtils.getTabFromEvent(event);
  const scrollBox = getScrollBoxFor(tab, { allowFallback: true });

  if (!TSTAPI.isScrollLocked()) {
    cancelRunningScroll();
    if (EventUtils.getElementTarget(event).closest('.sticky-tabs-container') ||
        (tab?.pinned &&
         scrollBox != mPinnedScrollBox)) {
      event.stopImmediatePropagation();
      event.preventDefault();
      scrollTo({ delta: event.deltaY, scrollBox });
    }
    return;
  }

  event.stopImmediatePropagation();
  event.preventDefault();

  TSTAPI.notifyScrolled({
    tab,
    scrollContainer: scrollBox,
    overflow: scrollBox.classList.contains(Constants.kTABBAR_STATE_OVERFLOW),
    event
  });
}

function onScroll(event) {
  const scrollBox = event.currentTarget;
  scrollBox.$scrollTopMax = scrollBox.scrollTopMax;
  scrollBox.$scrollTop = Math.min(scrollBox.$scrollTopMax, scrollBox.scrollTop);
  reserveToUpdateScrolledState(scrollBox);
  if (scrollBox == mNormalScrollBox) {
    reserveToRenderVirtualScrollViewport({ trigger: 'scroll' });
  }
  reserveToSaveScrollPosition();
}


function reserveToUpdateScrolledState(scrollBox) {
  if (scrollBox.__reserveToUpdateScrolledState_invoked) // eslint-disable-line no-underscore-dangle
    return;
  scrollBox.__reserveToUpdateScrolledState_invoked = true; // eslint-disable-line no-underscore-dangle
  window.requestAnimationFrame(() => {
    scrollBox.__reserveToUpdateScrolledState_invoked = false; // eslint-disable-line no-underscore-dangle

    const scrolled = scrollBox.$scrollTop > 0;
    const fullyScrolled = scrollBox.$scrollTop == scrollBox.$scrollTopMax;
    scrollBox.classList.toggle(Constants.kTABBAR_STATE_SCROLLED, scrolled);
    scrollBox.classList.toggle(Constants.kTABBAR_STATE_FULLY_SCROLLED, fullyScrolled);

    if (scrollBox == mNormalScrollBox) {
      mTabBar.classList.toggle(Constants.kTABBAR_STATE_SCROLLED, scrolled);
      mTabBar.classList.toggle(Constants.kTABBAR_STATE_FULLY_SCROLLED, fullyScrolled);
    }

    Size.updateContainers();
  });
}

function reserveToSaveScrollPosition() {
  if (reserveToSaveScrollPosition.reserved)
    clearTimeout(reserveToSaveScrollPosition.reserved);
  reserveToSaveScrollPosition.reserved = setTimeout(() => {
    delete reserveToSaveScrollPosition.reserved;
    browser.sessions.setWindowValue(
      TabsStore.getCurrentWindowId(),
      Constants.kWINDOW_STATE_SCROLL_POSITION,
      mNormalScrollBox.$scrollTop
    ).catch(ApiTabs.createErrorSuppressor());
  }, 150);
}

const mReservedScrolls = new WeakMap();

function reserveToScrollToTab(tab, options = {}) {
  if (!tab)
    return;

  const scrollBox = getScrollBoxFor(tab);
  const reservedScroll = {
    tabId: tab.id,
    options,
  };
  mReservedScrolls.set(scrollBox, reservedScroll);
  window.requestAnimationFrame(() => {
    if (mReservedScrolls.get(scrollBox) != reservedScroll)
      return;
    mReservedScrolls.delete(scrollBox);
    const options = reservedScroll.options;
    delete reservedScroll.tabId;
    delete reservedScroll.options;
    scrollToTab(tab, options);
  });
}

function reserveToScrollToNewTab(tab) {
  if (!tab)
    return;
  const scrollBox = getScrollBoxFor(tab);
  const reservedScroll = {
    tabId: tab.id,
  };
  mReservedScrolls.set(scrollBox, reservedScroll);
  window.requestAnimationFrame(() => {
    if (mReservedScrolls.get(scrollBox) != reservedScroll)
      return;
    mReservedScrolls.delete(scrollBox);
    delete reservedScroll.tabId;
    scrollToNewTab(tab);
  });
}


function reReserveScrollingForTab(tab) {
  if (!tab)
    return false;
  if (reserveToScrollToTab.reservedTabId == tab.id) {
    reserveToScrollToTab(tab);
    return true;
  }
  if (reserveToScrollToNewTab.reservedTabId == tab.id) {
    reserveToScrollToNewTab(tab);
    return true;
  }
  return false;
}


function onMessage(message, _sender, _respond) {
  if (!message ||
      typeof message.type != 'string' ||
      message.type.indexOf('treestyletab:') != 0)
    return;

  if (message.windowId &&
      message.windowId != TabsStore.getCurrentWindowId())
    return;

  //log('onMessage: ', message, sender);
  switch (message.type) {
    case Constants.kCOMMAND_GET_RENDERED_TAB_IDS:
      return Promise.resolve([...new Set([
        ...Tab.getPinnedTabs(message.windowId).map(tab => tab.id),
        ...mLastRenderedVirtualScrollItemIds,
      ])]);

    case Constants.kCOMMAND_ASK_TAB_IS_IN_VIEWPORT:
      return Promise.resolve(isTabInViewport(Tab.get(message.tabId), {
        allowPartial: message.allowPartial,
      }));
  }
}

let mLastToBeActivatedTabId = null;

async function onBackgroundMessage(message) {
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TAB_ATTACHED_COMPLETELY: {
      await Tab.waitUntilTracked([
        message.tabId,
        message.parentId
      ]);
      const tab = Tab.get(message.tabId);
      const parent = Tab.get(message.parentId);
      if (tab && parent && parent.active)
        reserveToScrollToNewTab(tab);
    }; break;

    case Constants.kCOMMAND_SCROLL_TABBAR: {
      const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
      const scrollBox = getScrollBoxFor(activeTab, { allowFallback: true });
      switch (String(message.by).toLowerCase()) {
        case 'lineup':
          smoothScrollBy(-Size.getRenderedTabHeight() * configs.scrollLines);
          break;

        case 'pageup':
          smoothScrollBy(-scrollBox.$offsetHeight + Size.getRenderedTabHeight());
          break;

        case 'linedown':
          smoothScrollBy(Size.getRenderedTabHeight() * configs.scrollLines);
          break;

        case 'pagedown':
          smoothScrollBy(scrollBox.$offsetHeight - Size.getRenderedTabHeight());
          break;

        default:
          switch (String(message.to).toLowerCase()) {
            case 'top':
              smoothScrollTo({ position: 0 });
              break;

            case 'bottom':
              smoothScrollTo({ position: scrollBox.$scrollTopMax });
              break;
          }
          break;
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_CREATED: {
      await Tab.waitUntilTracked(message.tabId);
      if (message.maybeMoved)
        await SidebarTabs.waitUntilNewTabIsMoved(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab) // it can be closed while waiting
        break;
      const needToWaitForTreeExpansion = (
        tab.$TST.collapsedOnCreated &&
        !tab.active &&
        !Tab.getActiveTab(tab.windowId).pinned
      );
      if (shouldApplyAnimation(true) ||
          needToWaitForTreeExpansion) {
        wait(10).then(() => { // wait until the tab is moved by TST itself
          const parent = tab.$TST.parent;
          if (parent && parent.$TST.subtreeCollapsed) // possibly collapsed by other trigger intentionally
            return;
          const active = tab.active;
          tab.$TST.collapsedOnCreated = false;
          const activeTab = Tab.getActiveTab(tab.windowId);
          CollapseExpand.setCollapsed(tab, { // this is required to scroll to the tab with the "last" parameter
            collapsed: false,
            anchor:    (active || activeTab?.$TST.canBecomeSticky) ? null : activeTab,
            last:      !active
          });
          if (!active)
            notifyOutOfViewTab(tab);
        });
      }
      else {
        reserveToScrollToNewTab(tab);
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED: {
      if (tryLockScrollToSuccessor.tabId == message.tabId) {
        log('tryLockScrollToSuccessor: wait until unlocked for ', message.tabId);
        mLastToBeActivatedTabId = message.tabId;
        const canContinueToScroll = await tryLockScrollToSuccessor.promisedUnlocked;
        if (!canContinueToScroll ||
            mLastToBeActivatedTabId != message.tabId) {
          mLastToBeActivatedTabId = null;
          break;
        }
        log('tryLockScrollToSuccessor: unlocked, scroll to ', message.tabId);
      }
      unlockScrollToSuccessor(false);
      mLastToBeActivatedTabId = null;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab)
        break;
      const allowed = await TSTAPI.tryOperationAllowed(
        TSTAPI.kNOTIFY_TRY_SCROLL_TO_ACTIVATED_TAB,
        { tab },
        { tabProperties: ['tab'] }
      );
      if (allowed)
        reserveToScrollToTab(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_UNPINNED:
      await Tab.waitUntilTracked(message.tabId);
      reserveToScrollToTab(Tab.get(message.tabId));
      break;

    case Constants.kCOMMAND_BROADCAST_TAB_STATE: {
      if (!message.tabIds.length ||
          message.tabIds.length > 1 ||
          !message.add ||
          !message.add.includes(Constants.kTAB_STATE_BUNDLED_ACTIVE))
        break;
      await Tab.waitUntilTracked(message.tabIds);
      const tab = Tab.get(message.tabIds[0]);
      if (!tab ||
          tab.active)
        break;
      const bundled = message.add.includes(Constants.kTAB_STATE_BUNDLED_ACTIVE);
      if (bundled &&
          (!configs.scrollToExpandedTree ||
           !configs.syncActiveStateToBundledTabs))
        break;
      const activeTab = bundled ?
        tab.$TST.bundledTab : // bundled-active state may be applied before the bundled tab become active
        Tab.getActiveTab(tab.windowId);
      if (!activeTab)
        break;
      reserveToScrollToTab(tab, {
        anchor:            !activeTab.pinned && isTabInViewport(activeTab) && activeTab,
        notifyOnOutOfView: true
      });
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_MOVED:
    case Constants.kCOMMAND_NOTIFY_TAB_INTERNALLY_MOVED: {
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab) // it can be closed while waiting
        break;
      if (!reReserveScrollingForTab(tab) &&
          tab.active)
        reserveToScrollToTab(tab);
    }; break;
  }
}

function onMessageExternal(message, _aSender) {
  switch (message.type) {
    case TSTAPI.kSCROLL:
      return (async () => {
        const params = {};
        const currentWindow = TabsStore.getCurrentWindowId();
        if ('tab' in message) {
          await Tab.waitUntilTracked(message.tab);
          params.tab = Tab.get(message.tab);
          if (!params.tab || params.tab.windowId != currentWindow)
            return;
        }
        else {
          const windowId = message.window || message.windowId;
          if (windowId == 'active') {
            const currentWindow = await browser.windows.get(TabsStore.getCurrentWindowId());
            if (!currentWindow.focused)
              return;
          }
          else if (windowId != currentWindow) {
            return;
          }
          if ('delta' in message) {
            params.delta = message.delta;
            if (typeof params.delta == 'string')
              params.delta = Size.calc(params.delta);
          }
          if ('position' in message) {
            params.position = message.position;
            if (typeof params.position == 'string')
              params.position = Size.calc(params.position);
          }
          if ('duration' in message && typeof message.duration == 'number')
            params.duration = message.duration;
        }
        return scrollTo(params).then(() => {
          return true;
        });
      })();

    case TSTAPI.kSTOP_SCROLL:
      return (async () => {
        const currentWindow = TabsStore.getCurrentWindowId();
        const windowId = message.window || message.windowId;
        if (windowId == 'active') {
          const currentWindow = await browser.windows.get(TabsStore.getCurrentWindowId());
          if (!currentWindow.focused)
            return;
        }
        else if (windowId != currentWindow) {
          return;
        }
        cancelRunningScroll();
        return true;
      })();
  }
}

CollapseExpand.onUpdating.addListener((tab, options) => {
  if (!configs.scrollToExpandedTree)
    return;
  if (!tab.pinned)
    reserveToRenderVirtualScrollViewport({ trigger: 'collapseExpand' });
  if (options.last)
    scrollToTab(tab, {
      anchor:            options.anchor,
      notifyOnOutOfView: true
    });
});

CollapseExpand.onUpdated.addListener((tab, options) => {
  if (!configs.scrollToExpandedTree)
    return;
  if (!tab.pinned)
    reserveToRenderVirtualScrollViewport({ trigger: 'collapseExpand' });
  if (options.last)
    scrollToTab(tab, {
      anchor:            options.anchor,
      notifyOnOutOfView: true
    });
  else if (tab.active && !options.collapsed)
    scrollToTab(tab);
});


// Simulate "lock tab sizing while closing tabs via mouse click" behavior of Firefox itself
// https://github.com/piroor/treestyletab/issues/2691
// https://searchfox.org/mozilla-central/rev/27932d4e6ebd2f4b8519865dad864c72176e4e3b/browser/base/content/tabbrowser-tabs.js#1207
export async function tryLockPosition(tabIds, reason) {
  if ((!configs.simulateLockTabSizing &&
       !configs.deferScrollingToOutOfViewportSuccessor) ||
      tabIds.every(id => {
        const tab = Tab.get(id);
        return !tab || tab.pinned || tab.hidden;
      })) {
    log('tryLockPosition: ignore pinned or hidden tabs ', tabIds);
    return;
  }

  if (configs.deferScrollingToOutOfViewportSuccessor)
    await tryLockScrollToSuccessor(tabIds, reason);

  if (configs.simulateLockTabSizing)
    trySimulateLockTabSizing(tabIds, reason);

  if (!tryFinishPositionLocking.listening) {
    tryFinishPositionLocking.listening = true;
    window.addEventListener('mousemove', tryFinishPositionLocking);
    window.addEventListener('mouseout', tryFinishPositionLocking);
  }
}
tryLockPosition.tabIds = new Set();

async function tryLockScrollToSuccessor(tabIds, reason) {
  if (reason != LOCK_REASON_REMOVE)
    return;

  // We need to get tabs via WE API here to see its successorTabId certainly.
  const tabs = await Promise.all(tabIds.map(id => browser.tabs.get(id)));
  for (const tab of tabs) {
    if (!tab.active ||
        !tab.successorTabId ||
        tab.successorTabId == tab.id)
      continue;

    const successor = Tab.get(tab.successorTabId);
    if (!successor ||
        isTabInViewport(successor))
      return;

    log('tryLockScrollToSuccessor successor = ', tab.successorTabId);
    unlockScrollToSuccessor(false);
    // The successor tab is out of screen, so the tab bar will be scrolled.
    // We need to defer the scroll after unlocked.
    tryLockScrollToSuccessor.tabId = tab.successorTabId;
    tryLockScrollToSuccessor.promisedUnlocked = new Promise((resolve, _reject) => {
      tryLockScrollToSuccessor.onUnlocked.add(resolve);
    });
    return;
  }
}
tryLockScrollToSuccessor.tabId = null;
tryLockScrollToSuccessor.promisedUnlocked = Promise.resolve(true);
tryLockScrollToSuccessor.onUnlocked = new Set();

function trySimulateLockTabSizing(tabIds, reason) {
  // Don't lock scroll position when the last tab is closed.
  const lastTab = Tab.getLastVisibleTab();
  if (reason == LOCK_REASON_REMOVE &&
      tabIds.includes(lastTab.id)) {
    if (tryLockPosition.tabIds.size > 0) {
      // but we need to add tabs to the list of "close with locked scroll position"
      // tabs to prevent unexpected unlocking.
      for (const id of tabIds) {
        tryLockPosition.tabIds.add(id);
      }
    }
    log('trySimulateLockTabSizing: ignore last tab remove ', tabIds);
    return;
  }

  // Lock scroll position only when the closing affects to the max scroll position.
  if (mNormalScrollBox.$scrollTop < mNormalScrollBox.$scrollTopMax - Size.getRenderedTabHeight() - mTabbarSpacerSize) {
    log('trySimulateLockTabSizing: scroll position is not affected ', tabIds, {
      scrollTop: mNormalScrollBox.$scrollTop,
      scrollTopMax: mNormalScrollBox.$scrollTopMax,
      height: Size.getRenderedTabHeight(),
    });
    return;
  }

  for (const id of tabIds) {
    tryLockPosition.tabIds.add(id);
  }

  log('trySimulateLockTabSizing: ', tabIds);
  const spacer = mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`);
  const count = tryLockPosition.tabIds.size;
  const height = Size.getRenderedTabHeight() * count;
  spacer.style.minHeight = `${height}px`;
  spacer.dataset.removedOrCollapsedTabsCount = count;
  mTabbarSpacerSize = height;
}

function unlockScrollToSuccessor(canContinueToScroll) {
  tryLockScrollToSuccessor.tabId = null;
  for (const callback of tryLockScrollToSuccessor.onUnlocked) {
    try {
      callback(canContinueToScroll);
    }
    catch (_error) {
    }
  }
  tryLockScrollToSuccessor.onUnlocked.clear();
}

export function tryUnlockPosition(tabIds) {
  if ((!configs.simulateLockTabSizing &&
       !configs.deferScrollingToOutOfViewportSuccessor) ||
      tabIds.every(id => {
        const tab = Tab.get(id);
        return !tab || tab.pinned || tab.hidden;
      }))
    return;

  unlockScrollToSuccessor(true);

  if (configs.simulateLockTabSizing) {
    for (const id of tabIds) {
      tryLockPosition.tabIds.delete(id);
    }

    log('tryUnlockPosition/simulateLockTabSizing');
    const spacer = mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`);
    const count = tryLockPosition.tabIds.size;
    const timeout = shouldApplyAnimation() ?
      Math.max(0, configs.collapseDuration) + 250 /* safety margin to wait finishing of the min-height animation of virtual-scroll-container */ :
      0;
    setTimeout(() => {
      const height = Size.getRenderedTabHeight() * count;
      spacer.style.minHeight = `${height}px`;
      spacer.dataset.removedOrCollapsedTabsCount = count;
      mTabbarSpacerSize = height;
    }, timeout);
  }
}

function tryFinishPositionLocking(event) {
  log('tryFinishPositionLocking ', tryLockPosition.tabIds, event);

  switch (event && event.type) {
    case 'mouseout':
      const relatedTarget = event.relatedTarget;
      if (relatedTarget && relatedTarget.ownerDocument == document) {
        log(' => ignore mouseout in the tabbar window itself');
        return;
      }

    case 'mousemove':
      if (tryFinishPositionLocking.contextMenuOpen ||
          (event.type == 'mousemove' &&
           EventUtils.getElementTarget(event)?.closest('#tabContextMenu'))) {
        log(' => ignore events while the context menu is opened');
        return;
      }
      if (event.type == 'mousemove' &&
          EventUtils.getElementTarget(event).closest('#tabbar, .after-tabs, #subpanel-container')) {
        log(' => ignore mousemove on the tab bar');
        return;
      }
      break;

    default:
      break;
  }

  window.removeEventListener('mousemove', tryFinishPositionLocking);
  window.removeEventListener('mouseout', tryFinishPositionLocking);
  tryFinishPositionLocking.listening = false;

  unlockScrollToSuccessor(true);

  tryLockPosition.tabIds.clear();
  const spacer = mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`);
  spacer.dataset.removedOrCollapsedTabsCount = 0;
  spacer.style.minHeight = '';
  mTabbarSpacerSize = 0;
  onPositionUnlocked.dispatch();
}
tryFinishPositionLocking.contextMenuOpen = false;

browser.menus.onShown.addListener((info, tab) => {
  tryFinishPositionLocking.contextMenuOpen = info.contexts.includes('tab') && (tab.windowId == TabsStore.getCurrentWindowId());
});

browser.menus.onHidden.addListener((_info, _tab) => {
  tryFinishPositionLocking.contextMenuOpen = false;
});

browser.tabs.onCreated.addListener(_tab => {
  tryFinishPositionLocking('on tab created');
});

browser.tabs.onRemoved.addListener(tabId => {
  if (tryLockPosition.tabIds.has(tabId) ||
      Tab.get(tabId)?.$TST.collapsed)
    return;
  if (tryLockScrollToSuccessor.tabId) {
    log(`tryLockScrollToSuccessor ignore tab remove ${tabId}`);
    return;
  }
  tryFinishPositionLocking(`on tab removed ${tabId}`);
});
