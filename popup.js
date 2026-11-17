const pickButton = document.querySelector('#pick');
const clearButton = document.querySelector('#clear');
const history = document.querySelector('#history');
const empty = document.querySelector('#empty');
const status = document.querySelector('#status');
const colorPattern = /^#[0-9A-F]{6}$/;
let colors = [];
let statusTimer;

function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.dataset.error = String(isError);
  statusTimer = setTimeout(() => { status.textContent = ''; }, 3000);
}

function render() {
  history.replaceChildren();
  empty.hidden = colors.length > 0;
  clearButton.disabled = colors.length === 0;
  for (const color of colors) {
    const row = document.createElement('li');
    row.className = 'history-item';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'history-copy';
    copy.setAttribute('aria-label', `${color} 복사`);
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = color;
    const label = document.createElement('span');
    label.className = 'hex';
    label.textContent = color;
    copy.append(swatch, label);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(color); showStatus(`${color} 복사됨`); }
      catch (_) { showStatus('클립보드에 복사하지 못했습니다.', true); }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-button';
    remove.setAttribute('aria-label', `${color} 삭제`);
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      await chrome.storage.local.set({ colors: colors.filter((item) => item !== color) });
      showStatus(`${color} 삭제됨`);
    });
    row.append(copy, remove);
    history.append(row);
  }
}

async function loadColors() {
  const stored = await chrome.storage.local.get('colors');
  colors = Array.isArray(stored.colors) ? [...new Set(stored.colors.filter((c) => typeof c === 'string' && colorPattern.test(c)))].slice(0, 10) : [];
  render();
}

pickButton.addEventListener('click', async () => {
  pickButton.disabled = true;
  showStatus('색상 선택 화면을 여는 중입니다.');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'pick-color' });
    if (result?.error) showStatus(result.error, true);
    else if (result?.color) showStatus(result.copied ? `${result.color} 복사됨` : `${result.color} 저장됨 · 복사 실패`, !result.copied);
  } catch (_) { showStatus('색상 선택을 시작하지 못했습니다.', true); }
  finally { pickButton.disabled = false; }
});

clearButton.addEventListener('click', async () => {
  await chrome.storage.local.set({ colors: [] });
  showStatus('최근 색상을 모두 삭제했습니다.');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.colors) loadColors();
});

(async () => {
  await loadColors();
  const { lastError } = await chrome.storage.session.get('lastError');
  if (lastError) {
    showStatus(lastError, true);
    await chrome.storage.session.remove('lastError');
    await chrome.action.setBadgeText({ text: '' });
  }
})();
