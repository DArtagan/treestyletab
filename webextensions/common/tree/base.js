/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
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
 * Portions created by the Initial Developer are Copyright (C) 2011-2017
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 wanabe <https://github.com/wanabe>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *                 Xidorn Quan <https://github.com/upsuper> (Firefox 40+ support)
 *                 lv7777 (https://github.com/lv7777)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ******/
'use strict';

var gAllTabs;
var gTargetWindow    = null;
var gRestoringTree   = false;
var gNeedRestoreTree = false;
var gScrollLockedBy  = {};

var gIsMac = /^Mac/i.test(navigator.platform);

function makeTabId(aApiTab) {
  return `tab-${aApiTab.windowId}-${aApiTab.id}`;
}

async function requestUniqueId(aTabOrId, aOptions = {}) {
  var tabId = aTabOrId;
  var tab   = null;
  if (typeof aTabOrId == 'number') {
    tab = getTabById(id);
  }
  else {
    tabId = aTabOrId.apiTab.id;
    tab   = aTabOrId;
  }

  if (aOptions.inRemote) {
    return await browser.runtime.sendMessage({
      type:     kCOMMAND_REQUEST_UNIQUE_ID,
      id:       tabId,
      forceNew: !!aOptions.forceNew
    });
  }

  var originalId    = null;
  var originalTabId = null;
  var duplicated    = false;
  if (!aOptions.forceNew) {
    let oldId = await browser.sessions.getTabValue(tabId, kPERSISTENT_ID);
    if (oldId && !oldId.tabId) // ignore broken information!
      oldId = null;

    if (oldId) {
      // If the tab detected from stored tabId is different, it is duplicated tab.
      try {
        let tabWithOldId = getTabById(oldId.tabId);
        if (!tabWithOldId)
          throw new Error(`Invalid tab ID: ${oldId.tabId}`);
        originalId = (tabWithOldId.getAttribute(kPERSISTENT_ID) || await tabWithOldId.uniqueId.id);
        duplicated = tab && tabWithOldId != tab && originalId == oldId.id;
        if (duplicated)
          originalTabId = oldId.tabId;
        else
          throw new Error(`Invalid tab ID: ${oldId.tabId}`);
      }
      catch(e) {
        handleMissingTabError(e);
        // It fails if the tab doesn't exist.
        // There is no live tab for the tabId, thus
        // this seems to be a tab restored from session.
        // We need to update the related tab id.
        await browser.sessions.setTabValue(tabId, kPERSISTENT_ID, {
          id:    oldId.id,
          tabId: tabId
        });
        return {
          id:            oldId.id,
          originalId:    null,
          originalTabId: oldId.tabId,
          restored:      true
        };
      }
    }
  }

  var adjective   = kID_ADJECTIVES[Math.floor(Math.random() * kID_ADJECTIVES.length)];
  var noun        = kID_NOUNS[Math.floor(Math.random() * kID_NOUNS.length)];
  var randomValue = Math.floor(Math.random() * 1000);
  var id          = `tab-${adjective}-${noun}-${Date.now()}-${randomValue}`;
  await browser.sessions.setTabValue(tabId, kPERSISTENT_ID, {
    id:    id,
    tabId: tabId // for detecttion of duplicated tabs
  });
  return { id, originalId, originalTabId, duplicated };
}

function buildTab(aApiTab, aOptions = {}) {
  log('build tab for ', aApiTab);
  var tab = document.createElement('li');
  tab.apiTab = aApiTab;
  tab.setAttribute('id', makeTabId(aApiTab));
  tab.setAttribute(kAPI_TAB_ID, aApiTab.id || -1);
  tab.setAttribute(kAPI_WINDOW_ID, aApiTab.windowId || -1);
  //tab.setAttribute(kCHILDREN, '');
  tab.classList.add('tab');
  if (aApiTab.active)
    tab.classList.add(kTAB_STATE_ACTIVE);
  tab.classList.add(kTAB_STATE_SUBTREE_COLLAPSED);

  var label = document.createElement('span');
  label.classList.add(kLABEL);
  tab.appendChild(label);

  window.onTabBuilt && onTabBuilt(tab, aOptions);

  if (aOptions.existing) {
    tab.classList.add(kTAB_STATE_ANIMATION_READY);
  }

  if (aApiTab.id)
    updateUniqueId(tab);
  else
    tab.uniqueId = Promise.resolve({
      id:            null,
      originalId:    null,
      originalTabId: null
    });

  tab.opened = new Promise((aResolve, aReject) => {
    tab._resolveOpened = aResolve;
  });
  tab.closedWhileActive = new Promise((aResolve, aReject) => {
    tab._resolveClosedWhileActive = aResolve;
  });

  tab.childTabs = [];
  tab.parentTab = null;

  return tab;
}

function updateUniqueId(aTab) {
  aTab.uniqueId = requestUniqueId(aTab, {
    inRemote: !!gTargetWindow
  }).then(aUniqueId => {
    if (ensureLivingTab(aTab)) // possibly removed from document while waiting
      aTab.setAttribute(kPERSISTENT_ID, aUniqueId.id);
    return aUniqueId;
  });
  return aTab.uniqueId;
}

function updateTab(aTab, aNewState, aOptions = {}) {
  if ('url' in aNewState)
    aTab.setAttribute(kCURRENT_URI, aNewState.url);

  // Loading of "about:(unknown type)" won't report new URL via tabs.onUpdated,
  // so we need to see the complete tab object.
  if (aOptions.tab && aOptions.tab.url.indexOf(kLEGACY_GROUP_TAB_URI) == 0) {
    browser.tabs.update(aTab.apiTab.id, {
      url: aOptions.tab.url.replace(kLEGACY_GROUP_TAB_URI, kGROUP_TAB_URI)
    }).catch(handleMissingTabError);
    aTab.classList.add(kTAB_STATE_GROUP_TAB);
    return;
  }
  else if ('url' in aNewState &&
           aNewState.url.indexOf(kGROUP_TAB_URI) == 0) {
    aTab.classList.add(kTAB_STATE_GROUP_TAB);
  }
  else if (aTab.apiTab.url.indexOf(kGROUP_TAB_URI) != 0) {
    aTab.classList.remove(kTAB_STATE_GROUP_TAB);
  }

  if (aOptions.forceApply ||
      'title' in aNewState) {
    let visibleLabel = aNewState.title;
    if (aNewState && aNewState.cookieStoreId) {
      let identity = gContextualIdentities[aNewState.cookieStoreId];
      if (identity)
        visibleLabel = `${aNewState.title} - ${identity.name}`;
    }
    if (!aOptions.forceApply &&
        !isActive(aTab))
      aTab.classList.add(kTAB_STATE_UNREAD);
    getTabLabel(aTab).textContent = aNewState.title;
    aTab.label = visibleLabel;
    window.onTabLabelUpdated && onTabLabelUpdated(aTab);
  }

  if (aOptions.forceApply ||
      'favIconUrl' in aNewState ||
       TabFavIconHelper.maybeImageTab(aNewState)) {
    window.onTabFaviconUpdated &&
      onTabFaviconUpdated(
        aTab,
        aNewState.favIconUrl || aNewState.url
      );
  }

  if ('status' in aNewState) {
    let reallyChanged = !aTab.classList.contains(aNewState.status);
    aTab.classList.remove(aNewState.status == 'loading' ? 'complete' : 'loading');
    aTab.classList.add(aNewState.status);
    if (aNewState.status == 'loading') {
      aTab.classList.remove(kTAB_STATE_BURSTING);
    }
    else if (!aOptions.forceApply && reallyChanged) {
      aTab.classList.add(kTAB_STATE_BURSTING);
      if (aTab.delayedBurstEnd)
        clearTimeout(aTab.delayedBurstEnd);
      aTab.delayedBurstEnd = setTimeout(() => {
        delete aTab.delayedBurstEnd;
        aTab.classList.remove(kTAB_STATE_BURSTING);
        if (!isActive(aTab))
          aTab.classList.add(kTAB_STATE_NOT_ACTIVATED_SINCE_LOAD);
      }, configs.butstDuration);
    }
  }

  if ((aOptions.forceApply ||
       'pinned' in aNewState) &&
      aNewState.pinned != aTab.classList.contains(kTAB_STATE_PINNED)) {
    if (aNewState.pinned) {
      aTab.classList.add(kTAB_STATE_PINNED);
      window.onTabPinned && onTabPinned(aTab);
    }
    else {
      aTab.classList.remove(kTAB_STATE_PINNED);
      window.onTabUnpinned && onTabUnpinned(aTab);
    }
  }

  if (aOptions.forceApply ||
      'audible' in aNewState) {
    if (aNewState.audible)
      aTab.classList.add(kTAB_STATE_AUDIBLE);
    else
      aTab.classList.remove(kTAB_STATE_AUDIBLE);
  }

  if (aOptions.forceApply ||
      'mutedInfo' in aNewState) {
    if (aNewState.mutedInfo.muted)
      aTab.classList.add(kTAB_STATE_MUTED);
    else
      aTab.classList.remove(kTAB_STATE_MUTED);
  }

  if (aTab.apiTab.audible && !aTab.apiTab.mutedInfo.muted)
    aTab.classList.add(kTAB_STATE_SOUND_PLAYING);
  else
    aTab.classList.remove(kTAB_STATE_SOUND_PLAYING);

  /*
  // On Firefox, "highlighted" is same to "activated" for now...
  // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/tabs/onHighlighted
  if (aOptions.forceApply ||
      'highlighted' in aNewState) {
    if (aNewState.highlighted)
      aTab.classList.add(kTAB_STATE_HIGHLIGHTED);
    else
      aTab.classList.remove(kTAB_STATE_HIGHLIGHTED);
  }
  */

  if (aOptions.forceApply ||
      'cookieStoreId' in aNewState) {
    for (let className of aTab.classList) {
      if (className.indexOf('contextual-identity-') == 0)
        aTab.classList.remove(className);
    }
    if (aNewState.cookieStoreId)
      aTab.classList.add(`contextual-identity-${aNewState.cookieStoreId}`);
  }

  if (aOptions.forceApply ||
      'incognito' in aNewState) {
    if (aNewState.incognito)
      aTab.classList.add(kTAB_STATE_PRIVATE_BROWSING);
    else
      aTab.classList.remove(kTAB_STATE_PRIVATE_BROWSING);
  }

  /*
  // currently "selected" is not available on Firefox, so the class is used only by other addons.
  if (aOptions.forceApply ||
      'selected' in aNewState) {
    if (aNewState.selected)
      aTab.classList.add(kTAB_STATE_SELECTED);
    else
      aTab.classList.remove(kTAB_STATE_SELECTED);
  }
  */

  if (aOptions.forceApply ||
      'discarded' in aNewState) {
    if (aNewState.discarded)
      aTab.classList.add(kTAB_STATE_DISCARDED);
    else
      aTab.classList.remove(kTAB_STATE_DISCARDED);
  }

  if (configs.debug) {
    aTab.label = `
${aTab.apiTab.title}
#${aTab.id}
(${aTab.className})
uniqueId = <%${kPERSISTENT_ID}%>
duplicated = <%duplicated%> / <%originalTabId%> / <%originalId%>
restored = <%restored%>
tabId = ${aTab.apiTab.id}
windowId = ${aTab.apiTab.windowId}
`.trim();
    aTab.setAttribute('title', aTab.label);
    aTab.uniqueId.then(aUniqueId => {
      // reget it because it can be removed from document.
      aTab = getTabById({ tab: aTab.apiTab.id, window: aTab.apiTab.windowId });
      if (!aTab)
        return;
      aTab.setAttribute('title',
                        aTab.label = aTab.label
                          .replace(`<%${kPERSISTENT_ID}%>`, aUniqueId.id)
                          .replace(`<%originalId%>`, aUniqueId.originalId)
                          .replace(`<%originalTabId%>`, aUniqueId.originalTabId)
                          .replace(`<%duplicated%>`, !!aUniqueId.duplicated)
                          .replace(`<%restored%>`, !!aUniqueId.restored));
    });
  }
}

function updateParentTab(aParent) {
  if (!ensureLivingTab(aParent))
    return;

  var children = getChildTabs(aParent);

  if (children.some(maybeSoundPlaying))
    aParent.classList.add(kTAB_STATE_HAS_SOUND_PLAYING_MEMBER);
  else
    aParent.classList.remove(kTAB_STATE_HAS_SOUND_PLAYING_MEMBER);

  if (children.some(maybeMuted))
    aParent.classList.add(kTAB_STATE_HAS_MUTED_MEMBER);
  else
    aParent.classList.remove(kTAB_STATE_HAS_MUTED_MEMBER);

  updateParentTab(getParentTab(aParent));

  window.onParentTabUpdated && onParentTabUpdated(aParent);
}

function buildTabsContainerFor(aWindowId) {
  var container = document.createElement('ul');
  container.windowId = aWindowId;
  container.setAttribute('id', `window-${aWindowId}`);
  container.classList.add('tabs');

  container.internalMovingCount =
    container.internalClosingCount =
    container.alreadyMovedTabsCount =
    container.subTreeMovingCount =
    container.subTreeChildrenMovingCount =
    container.doingIntelligentlyCollapseExpandCount =
    container.internalFocusCount =
    container.internalSilentlyFocusCount =
    container.tryingReforcusForClosingCurrentTabCount =
    container.processingNewTabsCount =
    container.duplicatingTabsCount =
    container.restoringTabsCount = 0;

  container.openingCount         = 0;
  container.openedNewTabs        = [];
  container.openedNewTabsTimeout = null;

  container.toBeOpenedTabsWithPositions = 0;
  container.toBeOpenedOrphanTabs        = 0;
  container.toBeAttachedTabs            = 0;
  container.toBeDetachedTabs            = 0;

  return container;
}

function clearAllTabsContainers() {
  var range = document.createRange();
  range.selectNodeContents(gAllTabs);
  range.deleteContents();
  range.detach();
}


async function selectTabInternally(aTab, aOptions = {}) {
  log('selectTabInternally: ', dumpTab(aTab));
  if (aOptions.inRemote) {
    await browser.runtime.sendMessage({
      type:     kCOMMAND_SELECT_TAB_INTERNALLY,
      windowId: aTab.apiTab.windowId,
      tab:      aTab.id,
      options:  aOptions
    });
    return;
  }
  var container = aTab.parentNode;
  container.internalFocusCount++;
  if (aOptions.silently)
    container.internalSilentlyFocusCount++;
  return browser.tabs.update(aTab.apiTab.id, { active: true })
    .catch(e => {
      container.internalFocusCount--;
      if (aOptions.silently)
        container.internalSilentlyFocusCount--;
      handleMissingTabError(e);
    });
}

function removeTabInternally(aTab, aOptions = {}) {
  return removeTabsInternally([aTab], aOptions);
}

function removeTabsInternally(aTab, aOptions = {}) {
  aTabs = aTabs.filter(ensureLivingTab);
  if (!aTabs.length)
    return;
  log('removeTabsInternally: ', aTabs.map(dumpTab));
  if (aOptions.inRemote) {
    return browser.runtime.sendMessage({
      type:    kCOMMAND_REMOVE_TABS_INTERNALLY,
      tabs:    aTabs.map(aTab => aTab.id),
      options: aOptions
    });
  }
  var container = aTab.parentNode;
  container.internalClosingCount += aTabs.length;
  return browser.tabs.remove(aTabs.map(aTab => aTab.apiTab.id)).catch(handleMissingTabError);
}

/* move tabs */

async function moveTabsBefore(aTabs, aReferenceTab, aOptions = {}) {
  log('moveTabsBefore: ', aTabs.map(dumpTab), dumpTab(aReferenceTab), aOptions);
  if (!aTabs.length ||
      !ensureLivingTab(aReferenceTab))
    return [];

  if (isAllTabsPlacedBefore(aTabs, aReferenceTab)) {
    log('moveTabsBefore:no need to move');
    return [];
  }
  return moveTabsInternallyBefore(aTabs, aReferenceTab, aOptions);
}
async function moveTabBefore(aTab, aReferenceTab, aOptions = {}) {
  return moveTabsBefore([aTab], aReferenceTab, aOptions);
}

async function moveTabsInternallyBefore(aTabs, aReferenceTab, aOptions = {}) {
  if (!aTabs.length ||
      !ensureLivingTab(aReferenceTab))
    return [];

  log('moveTabsInternallyBefore: ', aTabs.map(dumpTab), dumpTab(aReferenceTab), aOptions);
  if (aOptions.inRemote || aOptions.broadcast) {
    let tabIds = await browser.runtime.sendMessage({
      type:     kCOMMAND_MOVE_TABS_BEFORE,
      windowId: gTargetWindow,
      tabs:     aTabs.map(aTab => aTab.id),
      nextTab:  aReferenceTab.id,
      broadcasted: !!aOptions.broadcast
    });
    if (aOptions.inRemote)
      return tabIds.map(getTabById);
  }

  var container = aTabs[0].parentNode;
  var apiTabIds = aTabs.map(aTab => aTab.apiTab.id);
  try {
    /*
      Tab elements are moved by tabs.onMoved automatically, but
      the operation is asynchronous. To help synchronous operations
      following to this operation, we need to move tabs immediately.
    */
    let oldIndexes = [aReferenceTab].concat(aTabs).map(getTabIndex);
    for (let tab of aTabs) {
      let oldPreviousTab = getPreviousTab(tab);
      let oldNextTab     = getNextTab(tab);
      if (oldNextTab == aReferenceTab) // no move case
        continue;
      container.internalMovingCount++;
      container.alreadyMovedTabsCount++;
      container.insertBefore(tab, aReferenceTab);
      window.onTabElementMoved && onTabElementMoved(tab, {
        oldPreviousTab,
        oldNextTab
      });
    }
    if (container.alreadyMovedTabsCount == 0) {
      log(' => actually nothing moved');
    }
    else {
      log('Tab nodes rearranged by moveTabsInternallyBefore:\n'+(!configs.debug ? '' :
        Array.slice(container.childNodes)
          .map(aTab => aTab.id+(aTabs.indexOf(aTab) > -1 ? '[MOVED]' : ''))
          .join('\n')
          .replace(/^/gm, ' - ')));
      let newIndexes = [aReferenceTab].concat(aTabs).map(getTabIndex);
      let minIndex = Math.min(...oldIndexes, ...newIndexes);
      let maxIndex = Math.max(...oldIndexes, ...newIndexes);
      for (let i = minIndex, allTabs = getTabs(container); i <= maxIndex; i++) {
        let tab = allTabs[i];
        if (!tab)
          continue;
        tab.apiTab.index = i;
      }

      if (!aOptions.broadcasted) {
        let toIndex, fromIndex;
        Promise.all([
          aOptions.delayedMove && wait(configs.newTabAnimationDuration), // Wait until opening animation is finished.
          (async () => {
            [toIndex, fromIndex] = await getApiTabIndex(aReferenceTab.apiTab.id, apiTabIds[0]);
          })()
        ]).then(() => {
          if (fromIndex < toIndex)
            toIndex--;
          browser.tabs.move(apiTabIds, {
            windowId: container.windowId,
            index:    toIndex
          }).catch(handleMissingTabError);
        });
      }
    }
  }
  catch(e) {
    handleMissingTabError(e);
    log('moveTabsInternallyBefore failed: ', String(e));
  }
  return apiTabIds.map(getTabById);
}
async function moveTabInternallyBefore(aTab, aReferenceTab, aOptions = {}) {
  return moveTabsInternallyBefore([aTab], aReferenceTab, aOptions);
}

async function moveTabsAfter(aTabs, aReferenceTab, aOptions = {}) {
  log('moveTabsAfter: ', aTabs.map(dumpTab), dumpTab(aReferenceTab), aOptions);
  if (!aTabs.length ||
      !ensureLivingTab(aReferenceTab))
    return [];

  if (isAllTabsPlacedAfter(aTabs, aReferenceTab)) {
    log('moveTabsAfter:no need to move');
    return [];
  }
  return moveTabsInternallyAfter(aTabs, aReferenceTab, aOptions);
}
async function moveTabAfter(aTab, aReferenceTab, aOptions = {}) {
  return moveTabsAfter([aTab], aReferenceTab, aOptions);
}

async function moveTabsInternallyAfter(aTabs, aReferenceTab, aOptions = {}) {
  if (!aTabs.length ||
      !ensureLivingTab(aReferenceTab))
    return [];

  log('moveTabsInternallyAfter: ', aTabs.map(dumpTab), dumpTab(aReferenceTab), aOptions);
  if (aOptions.inRemote || aOptions.broadcast) {
    let tabIds = await browser.runtime.sendMessage({
      type:        kCOMMAND_MOVE_TABS_AFTER,
      windowId:    gTargetWindow,
      tabs:        aTabs.map(aTab => aTab.id),
      previousTab: aReferenceTab.id,
      broadcasted: !!aOptions.broadcast
    });
    if (aOptions.inRemote)
      return tabIds.map(getTabById);
  }

  var container = aTabs[0].parentNode;
  var apiTabIds = aTabs.map(aTab => aTab.apiTab.id);
  try {
    /*
      Tab elements are moved by tabs.onMoved automatically, but
      the operation is asynchronous. To help synchronous operations
      following to this operation, we need to move tabs immediately.
    */
    let oldIndexes = [aReferenceTab].concat(aTabs).map(getTabIndex);
    var nextTab = getNextTab(aReferenceTab);
    if (aTabs.indexOf(nextTab) > -1)
      nextTab = null;
    for (let tab of aTabs) {
      let oldPreviousTab = getPreviousTab(tab);
      let oldNextTab     = getNextTab(tab);
      if (oldNextTab == nextTab) // no move case
        continue;
      container.internalMovingCount++;
      container.alreadyMovedTabsCount++;
      container.insertBefore(tab, nextTab);
      window.onTabElementMoved && onTabElementMoved(tab, {
        oldPreviousTab,
        oldNextTab
      });
    }
    if (container.alreadyMovedTabsCount == 0) {
      log(' => actually nothing moved');
    }
    else {
      log('Tab nodes rearranged by moveTabsInternallyAfter:\n'+(!configs.debug ? '' :
        Array.slice(container.childNodes)
          .map(aTab => aTab.id+(aTabs.indexOf(aTab) > -1 ? '[MOVED]' : ''))
          .join('\n')
          .replace(/^/gm, ' - ')));
      let newIndexes = [aReferenceTab].concat(aTabs).map(getTabIndex);
      let minIndex = Math.min(...oldIndexes, ...newIndexes);
      let maxIndex = Math.max(...oldIndexes, ...newIndexes);
      for (let i = minIndex, allTabs = getTabs(container); i <= maxIndex; i++) {
        let tab = allTabs[i];
        if (!tab)
          continue;
        tab.apiTab.index = i;
      }

      if (!aOptions.broadcasted) {
        let toIndex, fromIndex;
        Promise.all([
          aOptions.delayedMove && wait(configs.newTabAnimationDuration), // Wait until opening animation is finished.
          (async () => {
            [toIndex, fromIndex] = await getApiTabIndex(aReferenceTab.apiTab.id, apiTabIds[0]);
          })()
        ]).then(() => {
          if (fromIndex > toIndex)
            toIndex++;
          browser.tabs.move(apiTabIds, {
            windowId: container.windowId,
            index:    toIndex
          }).catch(handleMissingTabError);
        });
      }
    }
  }
  catch(e) {
    handleMissingTabError(e);
    log('moveTabsInternallyAfter failed: ', String(e));
  }
  return apiTabIds.map(getTabById);
}
async function moveTabInternallyAfter(aTab, aReferenceTab, aOptions = {}) {
  return moveTabsInternallyAfter([aTab], aReferenceTab, aOptions);
}


/* open something in tabs */

async function loadURI(aURI, aOptions = {}) {
  if (!aOptions.windowId && gTargetWindow)
    aOptions.windowId = gTargetWindow;
  if (aOptions.isRemote) {
    await browser.runtime.sendMessage(clone(aOptions, {
      type: kCOMMAND_LOAD_URI,
      tab:  aOptions.tab && aOptions.tab.id
    }));
    return;
  }
  try {
    let apiTabId;
    if (aOptions.tab) {
      apiTabId = aOptions.tab.apiTab.id;
    }
    else {
      let apiTabs = await browser.tabs.query({
        windowId: aOptions.windowId,
        active:   true
      });
      apiTabId = apiTabs[0].id;
    }
    await browser.tabs.update({
      windowId: aOptions.windowId,
      id:       apiTabId,
      url:      aURI
    }).catch(handleMissingTabError);
  }
  catch(e) {
    handleMissingTabError(e);
  }
}

function openNewTab(aOptions = {}) {
  return openURIInTab(null, aOptions);
}

async function openURIInTab(aURI, aOptions = {}) {
  var tabs = await openURIsInTabs([aURI], aOptions);
  return tabs[0];
}

async function openURIsInTabs(aURIs, aOptions = {}) {
  if (!aOptions.windowId && gTargetWindow)
    aOptions.windowId = gTargetWindow;

  return await doAndGetNewTabs(async () => {
    if (aOptions.inRemote) {
      await browser.runtime.sendMessage(clone(aOptions, {
        type:          kCOMMAND_NEW_TABS,
        uris:          aURIs,
        parent:        aOptions.parent && aOptions.parent.id,
        opener:        aOptions.opener && aOptions.opener.id,
        insertBefore:  aOptions.insertBefore && aOptions.insertBefore.id,
        insertAfter:   aOptions.insertAfter && aOptions.insertAfter.id,
        cookieStoreId: aOptions.cookieStoreId || null,
        inRemote:      false
      }));
    }
    else {
      let startIndex = calculateNewTabIndex(aOptions);
      let container  = getTabsContainer(aOptions.windowId);
      container.toBeOpenedTabsWithPositions += aURIs.length;
      await Promise.all(aURIs.map(async (aURI, aIndex) => {
        var params = {
          windowId: aOptions.windowId
        };
        if (aURI)
          params.url = aURI;
        if (aIndex == 0)
          params.active = !aOptions.inBackground;
        if (aOptions.opener)
          params.openerTabId = aOptions.opener.apiTab.id;
        if (startIndex > -1)
          params.index = startIndex + aIndex;
        if (aOptions.cookieStoreId)
          params.cookieStoreId = aOptions.cookieStoreId;
        var apiTab = await browser.tabs.create(params);
        var tab = getTabById({ tab: apiTab.id, window: apiTab.windowId });
        if (!aOptions.opener &&
            aOptions.parent &&
            tab)
          await attachTabTo(tab, aOptions.parent, {
            insertBefore: aOptions.insertBefore,
            insertAfter:  aOptions.insertAfter,
            broadcast:    true
          });
      }));
    }
  });
}


/* group tab */

function makeGroupTabURI(aTitle, aOptions = {}) {
  var base = kGROUP_TAB_URI;
  var temporaryOption = aOptions.temporary ? '&temporary=true' : '' ;
  return `${base}?title=${encodeURIComponent(aTitle)}${temporaryOption}`;
}


/* blocking/unblocking */

var gBlockingCount = 0;
var gBlockingThrobberCount = 0;

function blockUserOperations(aOptions = {}) {
  gBlockingCount++;
  document.documentElement.classList.add(kTABBAR_STATE_BLOCKING);
  if (aOptions.throbber) {
    gBlockingThrobberCount++;
    document.documentElement.classList.add(kTABBAR_STATE_BLOCKING_WITH_THROBBER);
  }
}

function blockUserOperationsIn(aWindowId, aOptions = {}) {
  if (gTargetWindow && gTargetWindow != aWindowId)
    return;

  if (!gTargetWindow) {
    browser.runtime.sendMessage({
      type:     kCOMMAND_BLOCK_USER_OPERATIONS,
      windowId: aWindowId,
      throbber: !!aOptions.throbber
    });
    return;
  }
  blockUserOperations(aOptions);
}

function unblockUserOperations(aOptions = {}) {
  gBlockingThrobberCount--;
  if (gBlockingThrobberCount < 0)
    gBlockingThrobberCount = 0;
  if (gBlockingThrobberCount == 0)
    document.documentElement.classList.remove(kTABBAR_STATE_BLOCKING_WITH_THROBBER);

  gBlockingCount--;
  if (gBlockingCount < 0)
    gBlockingCount = 0;
  if (gBlockingCount == 0)
    document.documentElement.classList.remove(kTABBAR_STATE_BLOCKING);
}

function unblockUserOperationsIn(aWindowId, aOptions = {}) {
  if (gTargetWindow && gTargetWindow != aWindowId)
    return;

  if (!gTargetWindow) {
    browser.runtime.sendMessage({
      type:     kCOMMAND_UNBLOCK_USER_OPERATIONS,
      windowId: aWindowId,
      throbber: !!aOptions.throbber
    });
    return;
  }
  unblockUserOperations(aOptions);
}


function broadcastTabState(aTabs, aOptions = {}) {
  if (!Array.isArray(aTabs))
    aTabs = [aTabs];
  browser.runtime.sendMessage({
    type:    kCOMMAND_BROADCAST_TAB_STATE,
    tabs:    aTabs.map(aTab => aTab.id),
    add:     aOptions.add || [],
    remove:  aOptions.remove || [],
    bubbles: !!aOptions.bubbles
  });
}


async function bookmarkTabs(aTabs, aOptions = {}) {
  var folderParams = {
    title: browser.i18n.getMessage('bookmarkFolder.label', aTabs[0].apiTab.title)
  };
  if (aOptions.parentId) {
    folderParams.parentId = aOptions.parentId;
    if ('index' in aOptions)
      folderParams.index = aOptions.index;
  }
  var folder = await browser.bookmarks.create(folderParams);
  for (let i = 0, maxi = aTabs.length; i < maxi; i++) {
    let tab = aTabs[i];
    await browser.bookmarks.create({
      parentId: folder.id,
      index:    i,
      title:    tab.apiTab.title,
      url:      tab.apiTab.url
    });
  }
  return folder;
}

async function notify(aParams = {}) {
  var id = await browser.notifications.create({
    type:    'basic',
    iconUrl: aParams.icon,
    title:   aParams.title,
    message: aParams.message
  });

  var timeout = aParams.timeout;
  if (typeof timeout != 'number')
    timeout = configs.notificationTimeout;
  if (timeout >= 0)
    await wait(timeout);

  await browser.notifications.clear(id);
}


/* TST API Helpers */

function serializeTabForTSTAPI(aTab) {
  return clone(aTab.apiTab, {
    states:   Array.slice(aTab.classList).filter(aState => kTAB_INTERNAL_STATES.indexOf(aState) < 0),
    children: getChildTabs(aTab).map(serializeTabForTSTAPI)
  });
}

async function sendTSTAPIMessage(aMessage, aOptions = {}) {
  var addons = window.gExternalListenerAddons;
  if (!addons)
    addons = await browser.runtime.sendMessage({
      type: kCOMMAND_REQUEST_REGISTERED_ADDONS
    });
  var uniqueTargets = {};
  for (let id of Object.keys(addons)) {
    uniqueTargets[id] = true;
  }
  if (aOptions.targets) {
    if (!Array.isArray(aOptions.targets))
      aOptions.targets = [aOptions.targets];
    for (let id of aOptions.targets) {
      uniqueTargets[id] = true;
    }
  }
  return Promise.all(Object.keys(uniqueTargets).map(async (aId) => {
    try {
      let result = await browser.runtime.sendMessage(aId, aMessage);
      return {
        id:     aId,
        result: result
      };
    }
    catch(e) {
      return {
        id:    aId,
        error: e
      };
    }
  }));
}
