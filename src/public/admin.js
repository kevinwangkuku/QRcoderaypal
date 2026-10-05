'use strict';

// 登出：用假帳號 logout 請求 /admin/logout，讓瀏覽器以假帳號覆蓋記住的真帳號
(() => {
  const button = document.querySelector('[data-logout]');
  if (!button) return;
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = '登出中…';
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/admin/logout', true, 'logout', 'logout');
    xhr.onloadend = () => location.replace('/logged-out');
    xhr.send();
  });
})();

// 測試卡頁的列印按鈕
document.querySelector('[data-print]')?.addEventListener('click', () => window.print());

// 產品表單的圖片欄：Ctrl+V 貼上、拖曳、過大時自動縮圖、圖片網址預覽
(() => {
  const input = document.querySelector('input[type=file][name=image]');
  if (!input) return;
  const zone = document.querySelector('[data-image-zone]');
  const preview = document.querySelector('[data-image-preview]');
  const status = document.querySelector('[data-image-status]');
  const urlInput = document.querySelector('input[name=image_url]');

  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_SIDE = 1600;
  const ACCEPTED = /^image\/(png|jpeg|webp|gif)$/;

  const say = (text, bad) => {
    status.textContent = text;
    status.classList.toggle('error', Boolean(bad));
  };
  const kb = (n) => `${Math.round(n / 1024).toLocaleString()} KB`;

  const toBlob = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));

  // 超過 2 MB 就縮到長邊 1600 px 並轉成 WebP（不支援時改 JPEG）。GIF 縮圖會失去動畫，不處理。
  async function shrink(file) {
    if (file.size <= MAX_BYTES || file.type === 'image/gif') return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const [type, ext] of [['image/webp', 'webp'], ['image/jpeg', 'jpg']]) {
      const blob = await toBlob(canvas, type);
      if (blob && blob.type === type && blob.size <= MAX_BYTES) {
        return new File([blob], `image.${ext}`, { type });
      }
    }
    return file;
  }

  async function useFile(file) {
    if (!file || !ACCEPTED.test(file.type)) {
      say('只接受 JPG、PNG、WebP、GIF 圖片', true);
      return;
    }
    say('處理中…');
    let result;
    try {
      result = await shrink(file);
    } catch {
      say('無法讀取這張圖片', true);
      return;
    }
    if (result.size > MAX_BYTES) {
      say(`圖片 ${kb(result.size)}，超過 2 MB，請換一張較小的圖`, true);
      return;
    }
    const dt = new DataTransfer();
    dt.items.add(result);
    input.files = dt.files;
    preview.src = URL.createObjectURL(result);
    preview.hidden = false;
    const note = result === file ? '' : `（已從 ${kb(file.size)} 自動縮小）`;
    say(`已選擇圖片 ${kb(result.size)}${note}，按「儲存」後生效`);
  }

  // 在頁面任何地方按 Ctrl+V：剪貼簿裡有圖片才攔截，純文字照常貼上
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    useFile(item.getAsFile());
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    useFile(e.dataTransfer.files[0]);
  });

  // 用「選擇檔案」挑的圖也走同樣的檢查與縮圖（程式設定 input.files 不會再觸發 change）
  input.addEventListener('change', () => {
    if (input.files[0]) useFile(input.files[0]);
  });

  // 圖片網址：實際載入一次，不是圖片就提醒（常見錯誤是貼到產品頁網址）
  const urlStatus = document.querySelector('[data-url-status]');
  let checkId = 0;
  const checkUrl = () => {
    const url = urlInput.value.trim();
    const id = ++checkId;
    urlStatus.textContent = '';
    urlStatus.classList.remove('error');
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const img = new Image();
    img.onload = () => {
      if (id === checkId) urlStatus.textContent = `✓ 圖片可以顯示（${img.naturalWidth}×${img.naturalHeight}）`;
    };
    img.onerror = () => {
      if (id !== checkId) return;
      urlStatus.textContent = '⚠ 這個網址不是圖片。請在圖片上按右鍵 →「複製圖片網址」，不要用網頁網址。';
      urlStatus.classList.add('error');
    };
    img.src = url;
  };
  urlInput.addEventListener('change', checkUrl);
  urlInput.addEventListener('paste', () => setTimeout(checkUrl, 0));
  if (urlInput.value) checkUrl();
})();
