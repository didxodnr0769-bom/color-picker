const pendingCaptures = new Map();
const activeAttempts = new Map();
const startQueues = new Map();
const activationEpochs = new Map();
const sessionKey = (tabId, token) => `picker:${tabId}:${token}`;

function markWindowChanged(windowId) {
  activationEpochs.set(windowId, (activationEpochs.get(windowId) || 0) + 1);
}

chrome.tabs.onActivated.addListener(({ windowId }) => markWindowChanged(windowId));
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  const attempt = activeAttempts.get(tabId);
  if (attempt) attempt.invalid = true;
  markWindowChanged(oldWindowId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const attempt = activeAttempts.get(tabId);
  if (attempt) {
    attempt.invalid = true;
    cancelAttempt(attempt).catch(() => {});
  }
});
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  const attempt = activeAttempts.get(removedTabId);
  if (attempt) {
    attempt.invalid = true;
    cancelAttempt(attempt).catch(() => {});
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const attempt = activeAttempts.get(tabId);
  if (attempt) {
    attempt.invalid = true;
    cancelAttempt(attempt).catch(() => {});
  }
});

async function isCurrentAttempt(attempt) {
  const isUnchanged = () => !attempt.invalid && activeAttempts.get(attempt.tabId) === attempt &&
    (activationEpochs.get(attempt.windowId) || 0) === attempt.epoch;
  if (!isUnchanged()) return false;
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: attempt.windowId });
    return active?.id === attempt.tabId && isUnchanged();
  } catch (_) { return false; }
}

// These functions run in the extension's isolated world, not in page JavaScript.
function removeOverlay(expectedToken, waitForPaint) {
  if (expectedToken && window.__colorPickerOverlayToken !== expectedToken) return;
  window.__colorPickerOverlay?.remove();
  window.__colorPickerOverlay = null;
  window.__colorPickerOverlayToken = null;
  if (!waitForPaint) return;
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 250);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
  });
}

function showOverlay(url, token) {
  window.__colorPickerOverlay?.remove();
  const host = document.createElement('div');
  host.setAttribute('data-color-picker-overlay', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '색상 선택');
  dialog.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important;overflow:hidden!important;z-index:2147483647!important;';
  const frame = document.createElement('iframe');
  frame.title = '색상 선택';
  frame.setAttribute('allow', 'clipboard-write');
  frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100%;border:0;display:block;';
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({ type: 'color-picker-init', token }, new URL(url).origin);
  });
  frame.src = url;
  dialog.append(frame);
  shadow.append(dialog);
  document.documentElement.append(host);
  window.__colorPickerOverlay = host;
  window.__colorPickerOverlayToken = token;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    host.remove();
    window.__colorPickerOverlay = null;
    window.__colorPickerOverlayToken = null;
    chrome.runtime.sendMessage({ type: 'cancel-overlay', token }).catch(() => {});
  });
  dialog.showModal();
  frame.focus();
  return true;
}

async function dismiss(tabId, token = null, waitForPaint = false) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: removeOverlay, args: [token, waitForPaint] }); } catch (_) {}
}

async function cancelAttempt(attempt) {
  if (attempt.token) {
    pendingCaptures.delete(attempt.token);
    await chrome.storage.session.remove(sessionKey(attempt.tabId, attempt.token));
    await dismiss(attempt.tabId, attempt.token);
  }
  if (activeAttempts.get(attempt.tabId) === attempt) activeAttempts.delete(attempt.tabId);
  return { cancelled: true };
}

async function startPicking(tab, attempt) {
  let token;
  try {
    if (!(await isCurrentAttempt(attempt))) return await cancelAttempt(attempt);
    await dismiss(tab.id, null, true);
    if (!(await isCurrentAttempt(attempt))) return await cancelAttempt(attempt);
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!(await isCurrentAttempt(attempt))) return await cancelAttempt(attempt);
    token = crypto.randomUUID();
    attempt.token = token;
    pendingCaptures.set(token, { image, tabId: tab.id, attempt });
    await chrome.storage.session.set({ [sessionKey(tab.id, token)]: { token } });
    if (!(await isCurrentAttempt(attempt))) return await cancelAttempt(attempt);
    const url = chrome.runtime.getURL('picker.html');
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showOverlay, args: [url, token] });
    if (injected?.result !== true) throw new Error('Failed to show picker');
    if (!(await isCurrentAttempt(attempt))) return await cancelAttempt(attempt);
    setTimeout(async () => {
      if (!pendingCaptures.has(token)) return;
      pendingCaptures.delete(token);
      const key = sessionKey(tab.id, token);
      const current = (await chrome.storage.session.get(key))[key];
      if (current?.token !== token) return;
      await chrome.storage.session.remove(key);
      await dismiss(tab.id, token);
      if (activeAttempts.get(tab.id) === attempt) {
        activeAttempts.delete(tab.id);
        await showError(tab.id, '이 페이지에서는 색상 선택 화면을 열 수 없습니다.');
      }
    }, 10000);
    return { started: true };
  } catch (_) {
    const cancelled = attempt.invalid || activeAttempts.get(tab.id) !== attempt ||
      (activationEpochs.get(attempt.windowId) || 0) !== attempt.epoch;
    await cancelAttempt(attempt);
    if (cancelled) return { cancelled: true };
    return { error: '이 페이지에서는 색상을 선택할 수 없습니다. 일반 웹페이지에서 다시 시도해 주세요.' };
  }
}

async function pickerSession(message, sender) {
  if (!sender.tab?.id || !sender.frameId || typeof sender.url !== 'string') return false;
  const url = new URL(sender.url);
  if (url.href !== chrome.runtime.getURL('picker.html') || typeof message.token !== 'string') return false;
  const key = sessionKey(sender.tab.id, message.token);
  const current = (await chrome.storage.session.get(key))[key];
  return current?.token === message.token && (!current.frameId || current.frameId === sender.frameId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return;
  if (message?.type === 'cancel-overlay' && sender.tab?.id && sender.frameId === 0) {
    (async () => {
      const key = sessionKey(sender.tab.id, message.token);
      const current = (await chrome.storage.session.get(key))[key];
      if (current?.token === message.token) {
        pendingCaptures.delete(message.token);
        await chrome.storage.session.remove(key);
        const attempt = activeAttempts.get(sender.tab.id);
        if (attempt?.token === message.token) activeAttempts.delete(sender.tab.id);
      }
    })().then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  if (!['get-capture', 'close-picker'].includes(message?.type)) return;
  (async () => {
    if (!(await pickerSession(message, sender))) return {};
    const key = sessionKey(sender.tab.id, message.token);
    if (message.type === 'get-capture') {
      const pending = pendingCaptures.get(message.token);
      if (!pending || pending.tabId !== sender.tab.id) return {};
      if (!(await isCurrentAttempt(pending.attempt))) {
        await cancelAttempt(pending.attempt);
        return {};
      }
      await chrome.storage.session.set({ [key]: { token: message.token, frameId: sender.frameId } });
      if (!(await isCurrentAttempt(pending.attempt)) || pendingCaptures.get(message.token) !== pending) {
        await cancelAttempt(pending.attempt);
        return {};
      }
      pendingCaptures.delete(message.token);
      return { image: pending.image };
    }
    const session = (await chrome.storage.session.get(key))[key];
    if (session?.frameId !== sender.frameId) return {};
    if (message.type === 'close-picker') {
      await chrome.storage.session.remove(key);
      const attempt = activeAttempts.get(sender.tab.id);
      if (attempt?.token === message.token) activeAttempts.delete(sender.tab.id);
      await dismiss(sender.tab.id, message.token);
      return { closed: true };
    }
    return {};
  })().then(sendResponse, () => sendResponse({}));
  return true;
});

async function showError(tabId, message) {
  const details = { tabId };
  await chrome.action.setBadgeText({ ...details, text: '!' });
  await chrome.action.setBadgeBackgroundColor({ ...details, color: '#B42318' });
  await chrome.action.setTitle({ ...details, title: `Color Picker · ${message}` });
}

async function runPicker(tab, attempt) {
  if (attempt.previous) {
    await cancelAttempt(attempt.previous);
    attempt.previous = null;
  }
  if (!(await isCurrentAttempt(attempt))) { await cancelAttempt(attempt); return; }
  await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  await chrome.action.setTitle({ tabId: tab.id, title: 'Color Picker' });
  const outcome = await startPicking(tab, attempt);
  if (outcome.error && (!activeAttempts.has(tab.id) || activeAttempts.get(tab.id) === attempt)) {
    await showError(tab.id, outcome.error);
  }
}

function launchPicker(tab) {
  if (!tab?.id || tab.windowId == null) return;
  const previousAttempt = activeAttempts.get(tab.id);
  if (previousAttempt) previousAttempt.invalid = true;
  const attempt = { tabId: tab.id, windowId: tab.windowId, epoch: activationEpochs.get(tab.windowId) || 0, previous: previousAttempt };
  activeAttempts.set(tab.id, attempt);
  const previous = startQueues.get(tab.id) || Promise.resolve();
  const running = previous.catch(() => {}).then(() => runPicker(tab, attempt)).catch(async () => {
    try { await cancelAttempt(attempt); } catch (_) {}
  });
  startQueues.set(tab.id, running);
  running.finally(() => { if (startQueues.get(tab.id) === running) startQueues.delete(tab.id); }).catch(() => {});
}

chrome.action.onClicked.addListener(launchPicker);
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'pick-color') launchPicker(tab);
});
