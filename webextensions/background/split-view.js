/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as TreeBehavior from '/common/tree-behavior.js';

import { Tab } from '/common/TreeItem.js';

import * as Tree from './tree.js';
import * as TreeTransaction from './tree-transaction.js';

function log(...args) {
  internalLogger('background/split-view', ...args);
}

/*
export function populateTabs(tabs) {
  const populatedTabs = new Set();
  for (const tab of tabs) {
    const mainTab = tab.$TST.mainSplitViewTab;
    if (mainTab)
      populatedTabs.add(mainTab);
    populatedTabs.add(tab);
    const subTab = tab.$TST.subSplitViewTab;
    if (subTab)
      populatedTabs.add(subTab);
  }
  return [...populatedTabs];
}
*/

export async function swapTreeParent({ to, from }) {
  from = Tab.get(from.id);
  to   = Tab.get(to.id);
  if (!from || !to)
    return;
  log('swapTreeParent: re-attach children from ', from.id, ' to ', to.id);
  await TreeTransaction.run(async () => {
    const children = from.$TST.children;
    await Tree.detachAllChildren(from, {
      behavior: Constants.kPARENT_TAB_OPERATION_BEHAVIOR_PROMOTE_ALL_CHILDREN,
    });
    for (const child of children) {
      await Tree.attachTabTo(child, to, {
        dontMove: true,
        justNow:  true,
      });
    }
  }, { justNow: true });
}

Tab.onSplitViewModified.addListener(async tab => {
  const newSubSplitViewTab = tab.$TST.subSplitViewTab || (tab.$TST.mainSplitViewTab ? tab : null);
  if (!newSubSplitViewTab)
    return;

  log('onSplitViewModified: ', tab, ', new sub split view tab = ', newSubSplitViewTab);

  let closeParentBehavior = TreeBehavior.getParentTabOperationBehavior(newSubSplitViewTab, {
    context: Constants.kPARENT_TAB_OPERATION_CONTEXT_MOVE,
  });
  if (closeParentBehavior == Constants.kPARENT_TAB_OPERATION_BEHAVIOR_ENTIRE_TREE)
    closeParentBehavior = Constants.kPARENT_TAB_OPERATION_BEHAVIOR_PROMOTE_FIRST_CHILD;

  await TreeTransaction.run(async () => {
    await Tree.detachAllChildren(newSubSplitViewTab, {
      behavior:  closeParentBehavior,
      broadcast: true
    });
    //reserveCloseRelatedTabs(toBeClosedTabs);
    Tree.detachTab(newSubSplitViewTab, {
      dontUpdateIndent: true,
      broadcast:        true
    });
  });
});
