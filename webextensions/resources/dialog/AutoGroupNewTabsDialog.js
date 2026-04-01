/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirmDialog from '/extlib/RichConfirmDialog.js';

import {
  configs,
  sanitizeForHTMLText,
} from '/common/common.js';
import * as Dialog from '/common/dialog.js';
import { Tab } from '/common/TreeItem.js';

class AutoGroupNewTabsDialog extends RichConfirmDialog {
  constructor(params) {
    super(params);

    this.params.buttons = [
      browser.i18n.getMessage('warnOnAutoGroupNewTabs_close'),
      browser.i18n.getMessage('warnOnAutoGroupNewTabs_cancel'),
    ];
    this.params.checkMessage = browser.i18n.getMessage('warnOnAutoGroupNewTabs_warnAgain');
    this.params.checked      = true;
    this.params.modal        = !configs.debug; // for popup
    this.params.type         = 'common-dialog'; // for popup
    this.params.title        = browser.i18n.getMessage('warnOnAutoGroupNewTabs_title'); // for popup

    this.onShown = (container) => {
      if (this.params.simulation ||
          this.params.sidebar)
        return;

      setTimeout(() => {
        if (this.params.tab) {
          const style = container.closest('.rich-confirm-dialog').style;
          style.maxWidth = `${Math.floor(window.innerWidth * 0.6)}px`;
          style.marginInlineStart = style.marginInlineEnd = 'auto';
        }

        const ul = container.querySelector('ul');
        if (!ul)
          return;
        const style = ul.style;
        style.height = '0px'; // this makes the box shrinkable
        style.maxHeight = 'none';
        style.minHeight = '0px';
      }, 0);
    }
  }

  async updateContent() {
    const [win, tabs] = await Promise.all([
      browser.windows.get(parseInt(this.params.targetWindowId)),
      (() => {
        const tabs = this.params.tabIds.map(id => Tab.get(id));
        if (tabs.length == 0 || tabs.every(tab => !!tab))
          return tabs;
        return browser.runtime.sendMessage({
          type:   'treestyletab:api:get-tree',
          tabIds: this.params.tabIds,
        });
      })(),
    ]);
    const listing = configs.warnOnAutoGroupNewTabsWithListing ?
      Dialog.tabsToHTMLList(tabs, {
        maxRows:   configs.warnOnAutoGroupNewTabsWithListingMaxRows,
        maxHeight: Math.round(win.height * 0.8),
        maxWidth:  Math.round(win.width * 0.75),
      }) :
      '';

    this.content.insertAdjacentHTML('beforeend', `
      <div>${sanitizeForHTMLText(browser.i18n.getMessage('warnOnAutoGroupNewTabs_message', [tabs.length]))}</div>${listing}
    `.trim());
    for (const element of this.content.querySelectorAll('[accesskey]')) {
      this.updateAccessKey(element);
    }
  }
};
window.AutoGroupNewTabsDialog = AutoGroupNewTabsDialog;
window.RICH_CONFIRM_DIALOG_CLASS_NAME = 'AutoGroupNewTabsDialog';

export default AutoGroupNewTabsDialog;
