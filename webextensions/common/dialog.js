/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirm from '/extlib/RichConfirm.js';

import {
  log as internalLogger,
  configs,
  isMacOS,
  sanitizeForHTMLText,
  wait,
} from '/common/common.js';

import * as ApiTabs from './api-tabs.js';
import * as Constants from './constants.js';
import * as Permissions from './permissions.js';
import * as SidebarConnection from './sidebar-connection.js';
import * as UserOperationBlocker from './user-operation-blocker.js';

import { Tab } from './TreeItem.js';

function log(...args) {
  internalLogger('common/dialog', ...args);
}

export async function show(ownerWindow, dialogParams, DialogClass = RichConfirm) {
  let result;
  let unblocked = false;
  try {
    if (configs.showDialogInSidebar &&
        SidebarConnection.isOpen(ownerWindow.id)/* &&
        SidebarConnection.hasFocus(ownerWindow.id)*/) {
      UserOperationBlocker.blockIn(ownerWindow.id, { throbber: false });
      result = await browser.runtime.sendMessage({
        type:   Constants.kCOMMAND_SHOW_DIALOG,
        params: {
          ...dialogParams,
          onShown:                    null,
          onShownInTab:               null,
          onShownInPopup:             null,
          userOperationBlockerParams: { throbber: false },
        },
        windowId: ownerWindow.id
      }).catch(ApiTabs.createErrorHandler());
    }
    else if (isMacOS() &&
             ownerWindow.state == 'fullscreen') {
      // on macOS, a popup window opened from a fullscreen browser window is always
      // opened as a new fullscreen window, thus we need to fallback to a workaround.
      log('showDialog: show in a temporary tab in ', ownerWindow.id);
      UserOperationBlocker.blockIn(ownerWindow.id, { throbber: false, shade: true });
      const url = (await Permissions.isGranted(Permissions.ALL_URLS)) ? null : browser.runtime.getURL('/resources/blank.html');
      const tempTab = await browser.tabs.create({
        windowId: ownerWindow.id,
        url,
        active:   true
      });
      await Promise.all([
        Tab.waitUntilTracked(tempTab.id).then(() => {
          Tab.get(tempTab.id).$TST.addState('hidden', { broadcast: true });
        }),
        // We need to wait until the tab is completely loaded to avoid
        // "Missing host permission" error.
        url && url != 'about:blank' ?
          (() => {
            let onUpdated;
            return Promise.race([
              (new Promise((resolve, _reject) => {
                onUpdated = (tabId, changes, tab) => {
                  if (changes.status != 'complete' ||
                      tab.url != url)
                    return;
                  resolve();
                };
                browser.tabs.onUpdated.addListener(onUpdated);
              })).finally(() => {
                browser.tabs.onUpdated.removeListener(onUpdated);
              }),
              wait(1000),
            ]);
          })() :
          null,
      ]);
      result = await DialogClass.showInTab(tempTab.id, dialogParams);
      UserOperationBlocker.unblockIn(ownerWindow.id, { throbber: false });
      unblocked = true;
      browser.tabs.remove(tempTab.id);
    }
    else {
      log('showDialog: show in a popup window on ', ownerWindow.id);
      UserOperationBlocker.blockIn(ownerWindow.id, { throbber: false });
      result = await DialogClass.showInPopup(ownerWindow.id, dialogParams);
      UserOperationBlocker.unblockIn(ownerWindow.id, { throbber: false });
      unblocked = true;
    }
  }
  catch(error) {
    console.error(error);
    result = { buttonIndex: -1 };
  }
  finally {
    if (!unblocked)
      UserOperationBlocker.unblockIn(ownerWindow.id, { throbber: false });
  }
  return result;
}

export function tabsToHTMLList(tabs, { maxHeight, maxWidth }) {
  const rootLevelOffset = tabs.map(tab => parseInt(tab.$TST?.getAttribute(Constants.kLEVEL) || tab.indent || 0)).sort()[0];
  return (
    `<ul style="border: 1px inset;
                display: flex;
                flex-direction: column;
                flex-grow: 1;
                flex-shrink: 1;
                margin-block: 0.5em;
                margin-inline: 0;
                min-height: 2em;
                max-height: calc(${maxHeight}px - 12em /* title bar, message, checkbox, buttons, and margins */);
                max-width: ${maxWidth}px;
                overflow: auto;
                padding-block: 0.5em;
                padding-inline: 0.5em;">` +
      tabs.map(tab => `<li style="align-items: center;
                                  display: flex;
                                  flex-direction: row;
                                  padding-inline-start: calc((${tab.$TST?.getAttribute(Constants.kLEVEL) || tab.indent || 0} - ${rootLevelOffset}) * 0.25em);"
                           title="${sanitizeForHTMLText(tab.title)}"
                          ><img style="display: flex;
                                       max-height: 1em;
                                       max-width: 1em;"
                                alt=""
                                src="${sanitizeForHTMLText(tab.favIconUrl || browser.runtime.getURL('resources/icons/defaultFavicon.svg'))}"
                               ><span style="margin-inline-start: 0.25em;
                                             overflow: hidden;
                                             text-overflow: ellipsis;
                                             white-space: nowrap;"
                                     >${sanitizeForHTMLText(tab.title)}</span></li>`).join('') +
      `</ul>`
  );
}
