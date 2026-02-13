// --- 設定 ---
const LOG_PREFIX = '[NotebookLM Tagger]';

// --- ユーティリティ: Shadow DOM 貫通検索 ---
const querySelectorDeep = (selector, root = document) => {
  return querySelectorAllDeep(selector, root)[0] || null;
};

const querySelectorAllDeep = (selector, root = document) => {
  let results = [];
  if (root.querySelectorAll) {
    try {
      results = results.concat(Array.from(root.querySelectorAll(selector)));
    } catch(e) {}
  }
  if (root.shadowRoot) {
    results = results.concat(querySelectorAllDeep(selector, root.shadowRoot));
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.shadowRoot) {
      results = results.concat(querySelectorAllDeep(selector, node.shadowRoot));
    }
  }
  return results;
};

// --- メイン監視処理 ---
const startObserver = () => {
  let timeoutId = null;
  const runUpdate = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(updateUI, 300);
  };
  const observer = new MutationObserver(runUpdate);
  observer.observe(document.body, { childList: true, subtree: true });
  runUpdate();
};

const isDashboard = () => !window.location.pathname.includes('/notebook/');

const updateUI = () => {
  if (isDashboard()) {
    renderDashboard();
  } else {
    renderNotebookDetail();
  }
};

// =================================================================
//  1. ダッシュボード (一覧画面)
// =================================================================
const renderDashboard = () => {
  // 位置調整 (リスト表示なら削除)
  ensureTagCloudPosition();

  const container = document.getElementById('my-tag-cloud');
  // コンテナがなければ(=リスト表示など) 何もしない
  if (!container) return;

  if (container.childElementCount === 0) {
    refreshTagCloudContent(container);
  }

  const activeBtn = container.querySelector('.cloud-tag.active');
  const selectedTag = (activeBtn && activeBtn.textContent !== 'All') ? activeBtn.textContent : null;

  try {
    chrome.storage.sync.get(null, (items) => {
      if (chrome.runtime.lastError) return;
      processCardsDeep(items, selectedTag);
    });
  } catch (e) {}
};

// --- タグクラウド位置 ---
const ensureTagCloudPosition = () => {
  let container = document.getElementById('my-tag-cloud');

  // ★修正: リスト表示(テーブル)が存在するかチェック
  // mat-table または .project-table があればリスト表示とみなす
  const isListView = querySelectorDeep('mat-table') || querySelectorDeep('.project-table');

  if (isListView) {
    // リスト表示の場合はタグクラウドを削除して終了
    if (container) container.remove();
    return;
  }

  const projectContainers = querySelectorAllDeep('.my-projects-container');
  if (projectContainers.length === 0) {
    if (container) container.remove();
    return;
  }

  const targetTexts = [
    '最近のノートブック', 'Recent notebooks',
    'マイ ノートブック', 'My notebooks', 'My Notebooks'
  ];

  let anchor = null;

  for (const projContainer of projectContainers) {
    const headers = querySelectorAllDeep('.projects-header', projContainer);
    for (const text of targetTexts) {
      const found = headers.find(h =>
        h.textContent && h.textContent.includes(text) && h.offsetParent !== null
      );
      if (found) {
        anchor = found;
        break;
      }
    }
    if (anchor) break;
  }

  if (!anchor) {
    if (container) container.remove();
    return;
  }

  if (!container) {
    container = document.createElement('div');
    container.id = 'my-tag-cloud';
    container.className = 'tag-cloud-container';
  }

  if (container.parentNode !== anchor.parentNode || container.previousSibling !== anchor) {
    if (anchor.parentNode) {
      anchor.parentNode.insertBefore(container, anchor.nextSibling);
    }
  }
};

// --- タグクラウド描画 ---
const refreshTagCloudContent = (container) => {
  if (!container) return;

  container.innerHTML = '';

  chrome.storage.sync.get(null, (items) => {
    if (chrome.runtime.lastError) return;

    const allTags = new Set();
    Object.values(items || {}).forEach(tags => {
      if (Array.isArray(tags)) tags.forEach(t => allTags.add(t));
    });

    const createBtn = (txt, isAll) => {
      const btn = document.createElement('span');
      btn.className = `cloud-tag ${isAll ? 'active' : ''}`;
      btn.textContent = txt;

      btn.onclick = (e) => {
        Array.from(container.children).forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        const tag = isAll ? null : txt;
        chrome.storage.sync.get(null, (curr) => processCardsDeep(curr, tag));
      };

      if (!isAll) {
        btn.oncontextmenu = (e) => {
          e.preventDefault();
          const newName = prompt(`タグ "${txt}" の名前を変更します:`, txt);
          if (newName && newName !== txt) {
            renameAllTags(txt, newName);
          }
        };
      }
      container.appendChild(btn);
    };

    createBtn('All', true);
    Array.from(allTags).sort().forEach(tag => createBtn(tag, false));

    // エクスポート/インポートボタンを追加
    addExportImportButtons(container);
  });
};

const renameAllTags = (oldName, newName) => {
  chrome.storage.sync.get(null, (items) => {
    if (chrome.runtime.lastError) return;
    const updates = {};
    let changed = false;

    for (const [id, tags] of Object.entries(items)) {
      if (Array.isArray(tags) && tags.includes(oldName)) {
        const newTags = tags.filter(t => t !== oldName);
        if (!newTags.includes(newName)) newTags.push(newName);
        updates[id] = newTags;
        changed = true;
      }
    }

    if (changed) {
      chrome.storage.sync.set(updates, () => {
        alert(`変更しました: ${oldName} -> ${newName}`);
        const container = document.getElementById('my-tag-cloud');
        if (container) refreshTagCloudContent(container);
        chrome.storage.sync.get(null, (curr) => processCardsDeep(curr, null));
      });
    }
  });
};

// --- エクスポート/インポート機能 ---
const addExportImportButtons = (container) => {
  // 既にボタンが存在する場合はスキップ
  if (container.querySelector('.export-btn') || container.querySelector('.import-btn')) {
    return;
  }

  // セパレーター
  const separator = document.createElement('span');
  separator.style.cssText = 'width: 1px; height: 20px; background-color: #ccc; margin: 0 4px;';
  container.appendChild(separator);

  // エクスポートボタン
  const exportBtn = document.createElement('button');
  exportBtn.className = 'export-btn';
  exportBtn.textContent = '📥 Export';
  exportBtn.title = 'タグデータをJSON形式でエクスポート';
  exportBtn.onclick = () => {
    chrome.storage.sync.get(null, (items) => {
      if (chrome.runtime.lastError) {
        alert('エクスポートに失敗しました: ' + chrome.runtime.lastError.message);
        return;
      }

      // タグデータのみを抽出（他の拡張機能のデータを除外）
      const tagData = {};
      for (const [key, value] of Object.entries(items)) {
        if (Array.isArray(value)) {
          tagData[key] = value;
        }
      }

      const jsonStr = JSON.stringify(tagData, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `notebooklm-tags-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  };
  container.appendChild(exportBtn);

  // インポートボタン
  const importBtn = document.createElement('button');
  importBtn.className = 'import-btn';
  importBtn.textContent = '📤 Import';
  importBtn.title = 'JSONファイルからタグデータをインポート';
  importBtn.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const jsonData = JSON.parse(event.target.result);
          
          // データ形式の検証
          if (typeof jsonData !== 'object' || jsonData === null) {
            throw new Error('無効なJSON形式です');
          }

          // 各エントリが配列であることを確認
          const validData = {};
          for (const [key, value] of Object.entries(jsonData)) {
            if (Array.isArray(value)) {
              validData[key] = value;
            }
          }

          if (Object.keys(validData).length === 0) {
            alert('有効なタグデータが見つかりませんでした');
            return;
          }

          // 確認ダイアログ
          const notebookCount = Object.keys(validData).length;
          const totalTags = new Set();
          Object.values(validData).forEach(tags => tags.forEach(t => totalTags.add(t)));
          
          if (!confirm(`インポートしますか？\nノートブック数: ${notebookCount}\nタグ数: ${totalTags.size}\n\n既存のデータは上書きされます。`)) {
            return;
          }

          // ストレージに保存
          chrome.storage.sync.set(validData, () => {
            if (chrome.runtime.lastError) {
              alert('インポートに失敗しました: ' + chrome.runtime.lastError.message);
              return;
            }

            alert(`インポートが完了しました！\nノートブック数: ${notebookCount}\nタグ数: ${totalTags.size}`);
            
            // UIを更新
            const container = document.getElementById('my-tag-cloud');
            if (container) {
              refreshTagCloudContent(container);
            }
            chrome.storage.sync.get(null, (curr) => processCardsDeep(curr, null));
          });
        } catch (error) {
          alert('JSONファイルの読み込みに失敗しました: ' + error.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };
  container.appendChild(importBtn);
};

// --- ID抽出 (カード専用) ---
const extractNotebookId = (element) => {
  const link = querySelectorDeep('a[href*="/notebook/"]', element);
  if (link) {
    const href = link.getAttribute('href');
    const match = href.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
  }

  const elementsWithId = querySelectorAllDeep('[id*="project-"], [aria-labelledby*="project-"]', element);
  if (element.id && element.id.includes('project-')) elementsWithId.push(element);

  for (const el of elementsWithId) {
    let idStr = el.getAttribute('id');
    if (!idStr) idStr = el.getAttribute('aria-labelledby');

    if (idStr) {
        const match = idStr.match(/project-([a-zA-Z0-9-]+)-(?:title|emoji|subtitle|sharing|menu)/);
        if (match && match[1]) {
            return match[1];
        }
    }
  }
  return null;
};

// --- カード処理 ---
const processCardsDeep = (storageItems, selectedTag) => {
  let cards = querySelectorAllDeep('project-button');
  if (cards.length === 0) cards = querySelectorAllDeep('mat-card');

  cards.forEach(card => {
    // おすすめ除外
    if (card.classList.contains('featured-project') ||
        card.querySelector('.featured-project') ||
        card.closest('.featured-project') ||
        card.closest('.featured-project-card')) {
      return;
    }

    const notebookId = extractNotebookId(card);
    if (!notebookId) return;

    const tags = storageItems ? (storageItems[notebookId] || []) : [];

    if (selectedTag && !tags.includes(selectedTag)) {
      card.classList.add('notebook-hidden');
      card.style.display = 'none';
    } else {
      card.classList.remove('notebook-hidden');
      card.style.display = '';

      updateCardFooter(card, tags);
    }
  });
};

const updateCardFooter = (card, tags) => {
  let targetContainer = querySelectorDeep('mat-card', card) || card;

  let tagRow = targetContainer.querySelector('.card-tags-row');

  if (!tags || tags.length === 0) {
    if (tagRow) tagRow.remove();
    return;
  }

  if (!tagRow) {
    tagRow = document.createElement('div');
    tagRow.className = 'card-tags-row';
    targetContainer.appendChild(tagRow);
  }

  tagRow.innerHTML = '';

  tags.forEach(t => {
    const span = document.createElement('span');
    span.className = 'card-mini-tag';
    span.textContent = t;
    tagRow.appendChild(span);
  });
};


// =================================================================
//  2. 詳細画面 (ノートブックの中)
// =================================================================
const renderNotebookDetail = () => {
  const match = window.location.pathname.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
  if (!match) return;
  const notebookId = match[1];

  const notebookHeader = querySelectorDeep('notebook-header');

  if (!notebookHeader || document.getElementById('my-tag-container')) return;

  const container = document.createElement('div');
  container.id = 'my-tag-container';
  container.className = 'header-tag-container';

  if (notebookHeader.parentNode) {
    notebookHeader.parentNode.insertBefore(container, notebookHeader.nextSibling);
  }

  const refresh = () => {
    chrome.storage.sync.get([notebookId], (res) => {
      if (chrome.runtime.lastError) return;
      const tags = res[notebookId] || [];
      container.innerHTML = '';

      tags.forEach(tag => {
        const sp = document.createElement('span');
        sp.className = 'header-tag';
        sp.innerHTML = `${tag} <span class="header-tag-delete" title="削除">×</span>`;
        sp.querySelector('.header-tag-delete').onclick = (e) => {
          if(confirm(`タグ "${tag}" を削除しますか？`)) {
            const newTags = tags.filter(t => t !== tag);
            chrome.storage.sync.set({[notebookId]: newTags}, refresh);
          }
        };
        container.appendChild(sp);
      });

      const addBtn = document.createElement('button');
      addBtn.className = 'header-tag-btn';
      addBtn.textContent = '+ Tag';
      addBtn.onclick = () => {
        const t = prompt('タグ追加:');
        if(t && !tags.includes(t)) {
          chrome.storage.sync.set({[notebookId]: [...tags, t]}, refresh);
        }
      };
      container.appendChild(addBtn);
    });
  };
  refresh();
};

startObserver();
