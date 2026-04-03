/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  sanitizeForHTMLText,
} from '/common/common.js';
import * as Constants from '/common/constants.js';

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
