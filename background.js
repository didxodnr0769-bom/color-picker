const pendingCaptures = new Map();
const sessionKey = (tabId) => `picker:${tabId}`;

// These functions run in the extension's isolated world, not in page JavaScript.
function removeOverlay() {
  window.__colorPickerOverlay?.remove();
  window.__colorPickerOverlay = null;
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;display:block;';
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({ type: 'color-picker-init', token }, new URL(url).origin);
  });
  frame.src = url;
  dialog.append(frame);
  shadow.append(dialog);
  document.documentElement.append(host);
  window.__colorPickerOverlay = host;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    host.remove();
    window.__colorPickerOverlay = null;
    chrome.runtime.sendMessage({ type: 'cancel-overlay', token }).catch(() => {});
  });
  dialog.showModal();
  frame.focus();
  return true;
}

async function dismiss(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: removeOverlay }); } catch (_) {}
}

async function startPicking(tab) {
  if (!tab?.id) return { error: '선택할 웹페이지를 찾을 수 없습니다.' };
  let token;
  try {
    await dismiss(tab.id);
    await chrome.storage.session.remove(sessionKey(tab.id));
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    token = crypto.randomUUID();
    pendingCaptures.set(token, { image, tabId: tab.id });
    await chrome.storage.session.set({ [sessionKey(tab.id)]: { token } });
    const url = chrome.runtime.getURL('picker.html');
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showOverlay, args: [url, token] });
    if (injected?.result !== true) throw new Error('Failed to show picker');
    setTimeout(async () => {
      if (!pendingCaptures.has(token)) return;
      pendingCaptures.delete(token);
      const current = (await chrome.storage.session.get(sessionKey(tab.id)))[sessionKey(tab.id)];
      if (current?.token !== token) return;
      await chrome.storage.session.remove(sessionKey(tab.id));
      await dismiss(tab.id);
      await showError(tab.id, '이 페이지에서는 색상 선택 화면을 열 수 없습니다.');
    }, 10000);
    return { started: true };
  } catch (_) {
    if (token) pendingCaptures.delete(token);
    await chrome.storage.session.remove(sessionKey(tab.id));
    await dismiss(tab.id);
    return { error: '이 페이지에서는 색상을 선택할 수 없습니다. 일반 웹페이지에서 다시 시도해 주세요.' };
  }
}

async function pickerSession(message, sender) {
  if (!sender.tab?.id || !sender.frameId || typeof sender.url !== 'string') return false;
  const url = new URL(sender.url);
  if (url.href !== chrome.runtime.getURL('picker.html') || typeof message.token !== 'string') return false;
  const current = (await chrome.storage.session.get(sessionKey(sender.tab.id)))[sessionKey(sender.tab.id)];
  return current?.token === message.token && (!current.frameId || current.frameId === sender.frameId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return;
  if (message?.type === 'cancel-overlay' && sender.tab?.id && sender.frameId === 0) {
    (async () => {
      const key = sessionKey(sender.tab.id);
      const current = (await chrome.storage.session.get(key))[key];
      if (current?.token === message.token) {
        pendingCaptures.delete(message.token);
        await chrome.storage.session.remove(key);
      }
    })().then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  if (!['get-capture', 'close-picker'].includes(message?.type)) return;
  (async () => {
    if (!(await pickerSession(message, sender))) return {};
    const key = sessionKey(sender.tab.id);
    if (message.type === 'get-capture') {
      const pending = pendingCaptures.get(message.token);
      if (!pending || pending.tabId !== sender.tab.id) return {};
      pendingCaptures.delete(message.token);
      await chrome.storage.session.set({ [key]: { token: message.token, frameId: sender.frameId } });
      return { image: pending.image };
    }
    const session = (await chrome.storage.session.get(key))[key];
    if (session?.frameId !== sender.frameId) return {};
    if (message.type === 'close-picker') {
      await chrome.storage.session.remove(key);
      await dismiss(sender.tab.id);
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

async function runPicker(tab) {
  if (!tab?.id) return;
  await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  await chrome.action.setTitle({ tabId: tab.id, title: 'Color Picker' });
  const outcome = await startPicking(tab);
  if (outcome.error) await showError(tab.id, outcome.error);
}

chrome.action.onClicked.addListener((tab) => { runPicker(tab).catch(() => {}); });
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'pick-color') runPicker(tab).catch(() => {});
});
