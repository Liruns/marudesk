'use strict';
// Feature-detect the navigationHistory API (Electron 30+) vs legacy webContents methods.
const canGoBack    = (wc) => (wc.navigationHistory ? wc.navigationHistory.canGoBack()    : wc.canGoBack());
const canGoForward = (wc) => (wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward());
const goBack       = (wc) => (wc.navigationHistory ? wc.navigationHistory.goBack()       : wc.goBack());
const goForward    = (wc) => (wc.navigationHistory ? wc.navigationHistory.goForward()    : wc.goForward());

module.exports = { canGoBack, canGoForward, goBack, goForward };
