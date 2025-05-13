/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';


// Generates a custom element name at random. This mainly aims to avoid
// conflicting of custom element names defined by webpage scripts.
// The generated name is user-unfriendly, this aims to guard your privacy.
function generateOneTimeCustomElementName() {
  const alphabets = 'abcdefghijklmnopqrstuvwxyz';
  const prefix = alphabets[Math.floor(Math.random() * alphabets.length)];
  return prefix + '-' + Date.now() + '-' + Math.round(Math.random() * 65000);
}

export function getProviderCode() {
  return `
    // We cannot use multiple custom element types with contents scripts -
    // otherwise second custom type must fail its construction ("super()" in
    // its constructor raises unexpected error), so we just use only one
    // custom element type and recycle it for multiple purposes.
    window.closedContainerType = window.closedContainerType || '${generateOneTimeCustomElementName()}';

    const version = '${browser.runtime.getManifest().version}';
    if (window.lastClosedContainerVersion &&
        window.lastClosedContainerVersion != version) {
      window.clearClosedContents();
    }
    window.lastClosedContainerVersion = version;

    // We cannot undefine custom element types, so we define it just one time.
    if (!window.customElements.get(window.closedContainerType)) {
      window.closedContentsDestructors = new Set();
      // We use a wrapper custom element to enclose all preview elements
      // which can contain privacy information.
      // It should guard them from accesses by webpage scripts.
      class ClosedContainer extends HTMLElement {
        constructor() {
          super();
          const shadow = this.attachShadow({ mode: 'closed' });
          window.appendClosedContents = element => shadow.appendChild(element);
          window.removeClosedContents = element => shadow.removeChild(element);
          window.clearClosedContents = () => {
            for (const destructor of window.closedContentsDestructors) {
              try {
                destructor();
              }
              catch(error) {
                console.error(error);
              }
            }
            for (const element of shadow.childNodes) {
              removeClosedContents(element);
            }
            closedContentsDestructors.clear();
            lastClosedContainer.parentNode.removeChild(lastClosedContainer);
            window.lastClosedContainer = null;
          };
        }
      }
      window.customElements.define(window.closedContainerType, ClosedContainer);
      window.destroyClosedContents = destructor => {
        try{
          destructor();
        }
        catch(error) {
          console.error(error);
        }
        window.closedContentsDestructors.delete(destructor);
        if (window.closedContentsDestructors.size > 0) {
          return;
        }
        window.lastClosedContainer.parentNode.removeChild(window.lastClosedContainer);
        window.lastClosedContainer = null;
      };
    }

    if (!window.lastClosedContainer) {
      window.lastClosedContainer = document.createElement(window.closedContainerType);
      document.documentElement.appendChild(window.lastClosedContainer);
    }
  `;
}
