/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirmDialog from '/extlib/RichConfirmDialog.js';

import {
  sanitizeForHTMLText,
} from '/common/common.js';

class ShareQRCodeDialog extends RichConfirmDialog {
  constructor(params) {
    super(params);

    this.params.buttons = [
      browser.i18n.getMessage('shareQRCode_close'),
    ];
    this.params.type = 'common-dialog';
  }

  generateStyleDefinitions() {
    const definitions = super.generateStyleDefinitions();
    const dialogWidth = browser.i18n.getMessage('shareQRCode_dialogWidth');
    return `
      ${definitions}

      .${this.commonClass}.rich-confirm-dialog {
        margin-left: auto !important;
        margin-right: auto !important;
        min-width: ${dialogWidth};
        width: min(33%, ${dialogWidth});
      }

      .${this.commonClass} img.qrcode {
        height: 25em;
        image-rendering: pixelated;
        width: 25em;
      }

      .${this.commonClass}.rich-confirm-content p {
        font-size: 150%;
        margin: 0;

        &.url {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: pre;
        }
      }
    `.trim();
  }

  async updateContent() {
    this.content.insertAdjacentHTML('beforeend', `
      <div style="text-align: center">
        <img class="qrcode" src="${this.params.image}" alt="${sanitizeForHTMLText(browser.i18n.getMessage('shareQRCode_alt'))}">
        <p class="url" title="${sanitizeForHTMLText(this.params.sharedURL)}">${sanitizeForHTMLText(this.params.sharedURL)}</p>
        <p>${sanitizeForHTMLText(browser.i18n.getMessage('shareQRCode_message'))}</p>
      </div>
    `.trim());
    for (const element of this.content.querySelectorAll('[accesskey]')) {
      this.updateAccessKey(element);
    }
  }

  isEventFiredOnContent(event) {
    let target = event.target;
    if (target.nodeType == Node.TEXT_NODE)
      target = target.parentNode;
    return target.closest(`.${this.commonClass}.rich-confirm-content`);
  }

  onClick(event) {
    if (this.isEventFiredOnContent(event))
      return true;
    return super.onClick(event);
  }

  onContextMenu(event) {
    if (this.isEventFiredOnContent(event))
      return true;
    return super.onContextMenu(event);
  }
};
window.ShareQRCodeDialog = ShareQRCodeDialog;
window.RICH_CONFIRM_DIALOG_CLASS_NAME = 'ShareQRCodeDialog';

export default ShareQRCodeDialog;
