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
  shouldApplyAnimation,
} from '/common/common.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as UserOperationBlocker from '/common/user-operation-blocker.js';

import { Tab, TabGroup, TreeItem } from '/common/TreeItem.js';

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


/*
*************************************************************************
Logic to maintain tree structure based on modified native tab groups
*************************************************************************

Firefox's native tab groups feature's basics:

* When tabs are newly grouped, they are gathered to THE PLACE OF THE TAB
  YOU OPENED THE CONTEXT MENU ON.
* When some of already grouped tabs are grouped with another new group,
  a new group will be placed BEFORE THE SOURCE GROUP OF THE CONTEXT TAB
  and all member tabs will be gathered there.
  * When tabs in different groups are grouped with another new group, the
    new group will be placed BEFORE THE SOURCE GROUP OF THE CONTEXT TAB.
* When some of already grouped tabs are ungrouped, they will be moved
  AFTER the source group.
  * When all member tabs are ungrouped, they will be there and just
    ungrouped.
  * When tabs in different groups are ungrouped, ungrouped tabs will be
    placed AFTER EACH SOURCE GROUP. In other words, ungrouped tabs won't
    be gathered.
* When some of already grouped tabs are moved to another group, they will
  be moved AFTER existing members of the destination group.

TST should imitate Firefox's behavior, and should do more with the method
maintainTree():

* A tree should not be separated with multiple groups.
  All member tabs in a tree should be grouped with a same tab group,
  otherwise all members are ungrouped.
  * When some member tabs in a tree are grouped, they need to be DETACHED
    FROM THE ORIGINAL TREE and PLACED BEFORE THE SOURCE TREE.
    Thus TST need to REARRANGE INVOLVED TABS.
    * However, moving grouped tabs may break the native tab group,
      so TST need to move OTHER TABS.
  * When already grouped tabs are newly grouped to another new group,
    they will be moved by Firefox. TST should DO NOTHING EXTRA ON THIS
    CASE, because tree structure of moved tabs are automatically
    maintained.

And, what we should do when TST is activated and detects a tree is
separated to multiple groups? For example:

* tab1
  * tab2 [group1]
  * tab3 [group1]
  * tab4
  * tab5 [group2]
  * tab6 [group2]

On this case we need to move only tab1 and tab4, otherwise moving of
already grouped tabs will break those groups. The method
maintainTree() does that too.
*/
export async function maintainTree({ windowId, groupId }) {
  const win = TabsStore.windows.get(windowId);

  const members = TabGroup.getMemberTabs({ windowId, groupId });
  const rootTabs = Tab.collectRootTabs(members);
  const wholeTreeRootTabs = [...new Set(members.map(tab => tab.$TST.rootTab))];
  const wholeTree = [
    ...new Set(TreeItem.sort([
      ...wholeTreeRootTabs,
      ...Tree.getWholeTree(wholeTreeRootTabs),
    ]))
  ];

  log(`maintainTree: groupId = ${groupId}, members = `,
      () => members.map(tab => `#${tab.id}(@${tab.index})[${tab.groupId}]`),
      ', rootTabs = ',
      () => rootTabs.map(tab => `#${tab.id}(@${tab.index})[${tab.groupId}]`),
      ', wholeTreeRootTabs = ',
      () => wholeTreeRootTabs.map(tab => `#${tab.id}(@${tab.index})[${tab.groupId}]`),
      ', wholeTree = ',
      () => wholeTree.map(tab => `#${tab.id}(@${tab.index})[${tab.groupId}]`));

  if (members.length == wholeTree.length) {
    return;
  }

  UserOperationBlocker.blockIn(windowId, { throbber: true });

  const membersAndStructures = new Map();
  const groupedTabs = new Set();
  const others = [];
  let lastMember = null;
  for (const tab of wholeTree) {
    if (tab.groupId == -1) {
      others.push(tab);
    }
    else {
      groupedTabs.add(tab);
      const membersAndStructure = membersAndStructures.get(tab.groupId) || { members: [] };
      membersAndStructure.members.push(tab);
      membersAndStructures.set(tab.groupId, membersAndStructure);
      lastMember = tab;
    }
  }
  for (const membersAndStructure of membersAndStructures.values()) {
    membersAndStructure.structure = TreeBehavior.getTreeStructureFromTabs(membersAndStructure.members);
    await Tree.detachTabsFromTree(members, {
      partial: true,
    });
  }

  log('maintainTree: others = ',
      () => others.map(tab => `#${tab.id}(@${tab.index})[${tab.groupId}]`),
      `, lastMember = #${lastMember.id}(@${lastMember.index})`);

  if (others.length == 0) {
    log('maintainTree: there is no other tabs need to be moved, so we do nothing.');
    UserOperationBlocker.unblockIn(windowId, { throbber: true });
    return;
  }

  for (const other of others) {
    win.internallyMovingTabsForUpdatedNativeTabGroups.add(other.id);
  }
  const othersStructure = TreeBehavior.getTreeStructureFromTabs(others);
  log('maintainTree: othersStructure = ', othersStructure);
  await Tree.detachTabsFromTree(others);
  const groupIds = wholeTree.map(tab => tab.groupId);
  if (groupIds.join('\n') != groupIds.sort().join('\n')) {
    // Newly grouped tabs are in middle of other trees, so we need to gather grouped tabs.
    // We move other tabs because to avoid breakage of tab groups.
    await Tree.moveTabs(others, {
      insertAfter: lastMember,
      insertBefore: others[others.length - 1].unsafeNextTab,
      // TST automatically optimize rearrangement of tabs, but we need to disable it here to keep grouped tabs there.
      doNotOptimize: TabsStore.windows.get(windowId).tabGroups.size > 0,
    });
    log('maintainTree: moved others = ',
        others.map(tab => `#${tab.id}(@${tab.index})[${tab.groupId}]`));

    await Promise.race([
      new Promise((resolve, _reject) => {
        const resolvers = maintainTree.resolversForWindow.get(windowId) || [];
        resolvers.push(resolve);
        maintainTree.resolversForWindow.set(windowId, resolvers);
      }),
      wait(500),
    ]);
    maintainTree.resolversForWindow.delete(windowId);
  }

  for (const other of others) {
    win.internallyMovingTabsForUpdatedNativeTabGroups.delete(other.id);
  }
  for (const { members, structure } of membersAndStructures.values()) {
    Tree.applyTreeStructureToTabs(members, structure);
  }
  Tree.applyTreeStructureToTabs(others, othersStructure);
  browser.tabs.ungroup(others.map(tab => tab.id));

  UserOperationBlocker.unblockIn(windowId, { throbber: true });
}
maintainTree.resolversForWindow = new Map();

function reserveToMaintainTree({ windowId, groupId }, options = {}) {
  let timer = reserveToMaintainTree.delayed.get(groupId);
  if (timer)
    clearTimeout(timer);
  if (options.justNow || !shouldApplyAnimation()) {
    return maintainTree({ windowId, groupId });
  }
  timer = setTimeout(() => {
    reserveToMaintainTree.delayed.delete(groupId);
    maintainTree({ windowId, groupId });
  }, 100);
  reserveToMaintainTree.delayed.set(groupId, timer);
}
reserveToMaintainTree.delayed = new Map();

export async function startToMaintainTree() {
  // fixup mismatched tree structure and tab groups constructed while TST is disabled
  const groups = await browser.tabGroups.query({});
  for (const group of groups) {
    await maintainTree({
      windowId: group.windowId,
      groupId: group.id,
    });
  }

  // after all we start tracking of dynamic changes of tab groups
  Tab.onNativeGroupModified.addListener(tab => {
    const win = TabsStore.windows.get(tab.windowId);
    if (win.internallyMovingTabsForUpdatedNativeTabGroups.has(tab.id)) {
      window.requestAnimationFrame(() => {
        const resolvers = maintainTree.resolversForWindow.get(tab.windowId) || [];
        maintainTree.resolversForWindow.delete(tab.windowId);
        for (const resolver of resolvers) {
          resolver();
        }
      });
      return;
    }
    reserveToMaintainTree(tab);
  });
}
