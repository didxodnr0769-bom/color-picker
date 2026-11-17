const screen = document.querySelector('#screen');
const context = screen.getContext('2d', { willReadFrequently: true });
const zoom = document.querySelector('#zoom').getContext('2d');
const loupe = document.querySelector('#loupe');
const hexLabel = document.querySelector('#hex');
const notice = document.querySelector('#notice');
let ready = false;
let busy = false;
let token;

function hexAt(event) {
  const rect = screen.getBoundingClientRect();
  const x = Math.max(0, Math.min(screen.width - 1, Math.floor((event.clientX - rect.left) * screen.width / rect.width)));
  const y = Math.max(0, Math.min(screen.height - 1, Math.floor((event.clientY - rect.top) * screen.height / rect.height)));
  const pixel = context.getImageData(x, y, 1, 1).data;
  return { x, y, color: `#${[...pixel.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}` };
}

async function closePicker() {
  if (!token) return;
  await chrome.runtime.sendMessage({ type: 'close-picker', token });
}

screen.addEventListener('pointermove', (event) => {
  if (!ready || busy) return;
  const { x, y, color } = hexAt(event);
  zoom.fillStyle = '#eee';
  zoom.fillRect(0, 0, 121, 121);
  zoom.imageSmoothingEnabled = false;
  zoom.drawImage(screen, x - 5, y - 5, 11, 11, 0, 0, 121, 121);
  zoom.strokeStyle = '#ff2e67';
  zoom.lineWidth = 2;
  zoom.strokeRect(55, 55, 11, 11);
  hexLabel.textContent = color;
  loupe.style.display = 'block';
  loupe.style.left = `${Math.max(0, Math.min(innerWidth - 140, event.clientX + 20))}px`;
  loupe.style.top = `${Math.max(0, Math.min(innerHeight - 165, event.clientY + 20))}px`;
});
screen.addEventListener('pointerleave', () => { loupe.style.display = 'none'; });
screen.addEventListener('click', async (event) => {
  if (!ready || busy) return;
  busy = true;
  const { color } = hexAt(event);
  try {
    await navigator.clipboard.writeText(color);
    notice.textContent = `${color} 복사됨`;
    notice.hidden = false;
    setTimeout(closePicker, 1100);
  } catch (_) {
    notice.textContent = `${color} 복사 실패`;
    notice.hidden = false;
    busy = false;
  }
});
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePicker(); });

window.addEventListener('message', async (event) => {
  if (ready || token || event.source !== window.parent || event.data?.type !== 'color-picker-init' || typeof event.data.token !== 'string') return;
  try {
    const receivedToken = event.data.token;
    const { image } = await chrome.runtime.sendMessage({ type: 'get-capture', token: receivedToken });
    if (!image) return;
    token = receivedToken;
    const captured = new Image();
    captured.onload = () => {
      screen.width = captured.naturalWidth;
      screen.height = captured.naturalHeight;
      context.drawImage(captured, 0, 0);
      ready = true;
    };
    captured.onerror = () => { notice.hidden = false; notice.textContent = '화면을 불러오지 못했습니다. Esc를 눌러 닫아주세요.'; };
    captured.src = image;
  } catch (_) { notice.hidden = false; notice.textContent = '화면을 불러오지 못했습니다. 다시 선택해 주세요.'; }
});
