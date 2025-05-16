/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  wait,
  configs,
} from '/common/common.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';

import { TabGroup } from '/common/TreeItem.js';

import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/native-tab-groups', ...args);
}

export async function addTabsToGroup(tabs, groupIdOrProperties) {
  const initialGroupId = typeof groupIdOrProperties == 'number' ? groupIdOrProperties : null;
  const groupId = await addTabsToGroupInternal(tabs, groupIdOrProperties);
  const created = groupId != initialGroupId;
  return { groupId, created };
}
async function addTabsToGroupInternal(tabs, groupIdOrProperties) {
  let groupId = typeof groupIdOrProperties == 'number' ? groupIdOrProperties : null;
  const tabsToGrouped = tabs.filter(tab => tab.groupId != groupId);
  if (tabsToGrouped.length == 0) {
    return groupId;
  }
  const win = TabsStore.windows.get(tabsToGrouped[0].windowId);
  for (const tab of tabsToGrouped) {
    win.internallyMovingTabsForUpdatedNativeTabGroups.add(tab.id);
    win.internalMovingTabs.set(tab.id, -1);
  }

  const structure = TreeBehavior.getTreeStructureFromTabs(tabs);

  await Tree.detachTabsFromTree(tabs, {
    partial: true,
  });

  const { promisedGrouped, finish } = waitUntilGrouped(tabsToGrouped, {
    groupId,
    windowId: tabsToGrouped[0].windowId,
  });
  await browser.tabs.group({
    groupId,
    tabIds: tabsToGrouped.map(tab => tab.id),
    ...(groupId ? {} : {
      createProperties: {
        windowId: win.id, // We must specify the window ID explicitly, otherwise tabs moved across windows may be reverted and grouped in the old window!
      },
    })
  });
  const group = await promisedGrouped;
  groupId = group.id;

  if (groupIdOrProperties &&
      typeof groupIdOrProperties == 'object') {
    const updateProperties = {};
    if ('title' in groupIdOrProperties) {
      updateProperties.title = groupIdOrProperties.title;
    }
    if ('color' in groupIdOrProperties) {
      updateProperties.color = groupIdOrProperties.color;
    }
    if ('collapsed' in groupIdOrProperties) {
      updateProperties.collapsed = groupIdOrProperties.collapsed;
    }
    await browser.tabGroups.update(groupId, updateProperties);
  }

  finish();

  const firstMember = group.$TST.firstMemberTab;
  const lastMember  = group.$TST.lastMemberTab;
  const prevTab = firstMember.$TST.previousTab;
  const nextTab = lastMember.$TST.nextTab;
  const rootTab = prevTab?.$TST.rootTab;
  if (prevTab &&
      nextTab &&
      prevTab.groupId == nextTab.groupId &&
      prevTab.groupId == -1 &&
      prevTab.$TST.parent &&
      rootTab == nextTab.$TST.rootTab) {
    // The group is in a middle of a tree. We need to move the new group away from the tree.
    const lastDescendant = rootTab.$TST.lastDescendant;
    if (firstMember.index - rootTab.index <= lastDescendant.index - lastMember.index) { // move above the tree
      await moveGroupBefore(group, rootTab);
    }
    else { // move below the tree
      await moveGroupAfter(group, lastDescendant);
    }
  }

  await Tree.applyTreeStructureToTabs(tabs, structure, {
    broadcast: true
  });

  return groupId;
}

function waitUntilGrouped(tabs, { groupId, windowId } = {}) {
  const toBeGroupedIds = tabs.map(tab => tab.id);
  const win = TabsStore.windows.get(windowId || tabs[0].windowId);
  let onUpdated = null;
  const { promisedMoved, finish: finishMoved } = waitUntilMoved(tabs, win.id)
  const promisedGrouped = new Promise((resolve, _reject) => {
    if (!groupId) {
      const onGroupCreated = group => {
        groupId = group.id;
        browser.tabGroups.onCreated.removeListener(onGroupCreated);
      };
      browser.tabGroups.onCreated.addListener(onGroupCreated);
    }
    const toBeGroupedIdsSet = new Set(toBeGroupedIds);
    onUpdated = (tabId, changeInfo, _tab) => {
      if (changeInfo.groupId == groupId) {
        toBeGroupedIdsSet.delete(tabId);
        win.internallyMovingTabsForUpdatedNativeTabGroups.delete(tabId);
      }
      if (toBeGroupedIdsSet.size == 0) {
        resolve(changeInfo.groupId);
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated, { properties: ['groupId'] });
  });
  const finish = () => {
    if (finish.done) {
      return;
    }
    browser.tabs.onUpdated.removeListener(onUpdated);
    for (const tab of tabs) {
      win.internalMovingTabs.delete(tab.id);
    }
    finish.done = true;
  };
  return {
    promisedGrouped: Promise.all([
      promisedGrouped,
      Promise.race([
        promisedMoved,
        wait(configs.nativeTabGroupModificationDetectionTimeoutAfterTabMove),
      ]),
    ]).then(([groupId]) => {
      finish();
      finishMoved();
      return win.tabGroups.get(groupId);
    }),
    finish,
  };
}

export async function removeTabsFromGroup(tabs) {
  const tabsToBeUngrouped = tabs.filter(tab => tab.groupId != -1);
  if (tabsToBeUngrouped.length == 0) {
    return;
  }
  const win = TabsStore.windows.get(tabs[0].windowId);
  for (const tab of tabs) {
    win.internallyMovingTabsForUpdatedNativeTabGroups.add(tab.id);
    win.internalMovingTabs.set(tab.id, -1);
  }
  const toBeUngroupedIds = tabsToBeUngrouped.map(tab => tab.id);
  let onUpdated = null;
  await new Promise((resolve, _reject) => {
    const toBeUngroupedIdsSet = new Set(toBeUngroupedIds);
    onUpdated = (tabId, changeInfo, _tab) => {
      if (changeInfo.groupId == -1) {
        toBeUngroupedIdsSet.delete(tabId);
        win.internallyMovingTabsForUpdatedNativeTabGroups.delete(tabId);
      }
      if (toBeUngroupedIdsSet.size == 0) {
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated, { properties: ['groupId'] });
    browser.tabs.ungroup(toBeUngroupedIds);
  });
  for (const tab of tabsToBeUngrouped) {
    win.internalMovingTabs.delete(tab.id);
  }
  browser.tabs.onUpdated.removeListener(onUpdated);
}

export async function matchTabsGrouped(tabs, groupIdOrCreateParams) {
  if (groupIdOrCreateParams == -1) {
    await removeTabsFromGroup(tabs);
  }
  else {
    await addTabsToGroup(tabs, groupIdOrCreateParams);
  }
}

export async function moveGroupToNewWindow({ groupId, windowId, duplicate, left, top }) {
  log('moveGroupToNewWindow: ', groupId, windowId);
  const group = TabGroup.get({ groupId, windowId });
  const members = TabGroup.getMemberTabs({ windowId, groupId });
  const movedTabs = await Tree.openNewWindowFromTabs(members, { duplicate, left, top });
  await addTabsToGroupInternal(movedTabs, {
    title: group.title,
    color: group.color,
  });
}

export async function moveGroupBefore(group, insertBefore) {
  const { promisedMoved, finish } = waitUntilMoved(group, insertBefore.windowId);

  const members = group.$TST.memberTabs;
  const firstMemberTab = group.$TST.firstMemberTab;
  await browser.tabGroups.move(group.id, {
    index:    insertBefore.index - (insertBefore.index > firstMemberTab.index ? members.length : 0),
    windowId: insertBefore.windowId,
  });

  await Promise.race([
    promisedMoved,
    wait(configs.nativeTabGroupModificationDetectionTimeoutAfterTabMove).then(() => {
      if (finish.done) {
        return;
      }
    }),
  ]);
  finish();
}

export async function moveGroupAfter(group, insertAfter) {
  const { promisedMoved, finish } = waitUntilMoved(group, insertAfter.windowId);

  const members = group.$TST.memberTabs;
  const firstMemberTab = group.$TST.firstMemberTab;
  await browser.tabGroups.move(group.id, {
    index:    insertAfter.index + 1 - (insertAfter.index > firstMemberTab.index ? members.length : 0),
    windowId: insertAfter.windowId,
  });

  await Promise.race([
    promisedMoved,
    wait(configs.nativeTabGroupModificationDetectionTimeoutAfterTabMove).then(() => {
      if (finish.done) {
        return;
      }
    }),
  ]);
  finish();
}

export function waitUntilMoved(groupOrMembers, destinationWindowId) {
  const members = Array.isArray(groupOrMembers) ?
    groupOrMembers :
    groupOrMembers.$TST.memberTabs;
  const win = TabsStore.windows.get(destinationWindowId || members[0].windowId);
  const toBeMovedTabs = new Set();
  for (const tab of members) {
    toBeMovedTabs.add(tab.id);
    win.internalMovingTabs.set(tab.id, -1);
    win.internallyMovingTabsForUpdatedNativeTabGroups.add(tab.id);
  }
  let onTabMoved;
  const promisedMoved = new Promise((resolve, _reject) => {
    onTabMoved = (tabId, _moveInfo) => {
      if (toBeMovedTabs.has(tabId)) {
        toBeMovedTabs.delete(tabId);
      }
      if (toBeMovedTabs.size == 0) {
        log('waitUntilMoved: all members have been moved');
        resolve();
      }
    };
    browser.tabs.onMoved.addListener(onTabMoved);
  });
  const finish = () => {
    if (finish.done) {
      return;
    }
    browser.tabs.onMoved.removeListener(onTabMoved);
    for (const tab of members) {
      win.internalMovingTabs.delete(tab.id);
      win.internallyMovingTabsForUpdatedNativeTabGroups.delete(tab.id);
    }
    finish.done = true;
  };
  return {
    promisedMoved: promisedMoved.then(finish),
    finish,
  };
}
