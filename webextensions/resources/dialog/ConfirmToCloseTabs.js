/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirm from '/extlib/RichConfirm.js';

class ConfirmToCloseTabs extends RichConfirm {
  static get dialogHtmlPath() {
    return browser.runtime.getURL('/resources/dialog/ConfirmToCloseTabsDialog.html');
  }
  static get dialogJsPath() {
    return browser.runtime.getURL('/resources/dialog/ConfirmToCloseTabsDialog.js');
  }
}
ConfirmToCloseTabs.Dialog = null;

export default ConfirmToCloseTabs;
