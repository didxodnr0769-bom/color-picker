const COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const pendingCaptures = new Map();

async function saveColor(color) {
  const { colors = [] } = await chrome.storage.local.get('colors');
  const valid = Array.isArray(colors) ? colors.filter((item) => typeof item === 'string' && COLOR_PATTERN.test(item) && item !== color) : [];
  await chrome.storage.local.set({ colors: [color, ...valid].slice(0, 10) });
}

async function startPicking(tab) {
  if (!tab?.id) return { error: '선택할 웹페이지를 찾을 수 없습니다.' };
  try {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const token = crypto.randomUUID();
    pendingCaptures.set(token, image);
    setTimeout(() => pendingCaptures.delete(token), 30000);
    try {
      await chrome.tabs.create({ windowId: tab.windowId, url: chrome.runtime.getURL(`picker.html?token=${encodeURIComponent(token)}`), index: tab.index + 1 });
    } catch (error) {
      pendingCaptures.delete(token);
      throw error;
    }
    return { started: true };
  } catch (_) {
    return { error: '이 페이지에서는 색상을 선택할 수 없습니다. 일반 웹페이지에서 다시 시도해 주세요.' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return;
  const isPopup = sender.url === chrome.runtime.getURL('popup.html');
  const isPicker = sender.url.startsWith(chrome.runtime.getURL('picker.html?'));
  if (message?.type === 'pick-color' && isPopup) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => startPicking(tab)).then(sendResponse);
    return true;
  }
  if (message?.type === 'get-capture' && isPicker && typeof message.token === 'string') {
    const image = pendingCaptures.get(message.token);
    pendingCaptures.delete(message.token);
    sendResponse({ image });
  }
  if (message?.type === 'save-color' && isPicker && COLOR_PATTERN.test(message.color || '')) {
    saveColor(message.color).then(() => sendResponse({ saved: true }), () => sendResponse({ saved: false }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'pick-color') return;
  const outcome = await startPicking(tab);
  if (outcome.error) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#B42318' });
    await chrome.storage.session.set({ lastError: outcome.error });
  }
});
