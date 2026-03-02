/* ============================================================
   Prompt Folders & Search — SillyTavern Extension
   ============================================================ */
(function () {
    'use strict';

    const MODULE_NAME = 'prompt_folders_search';
    const POLL_MS = 800;

    /* ─── State ─── */
    let lastPreset = '';
    let observer = null;
    let pollTimer = null;
    let isRebuilding = false;
    let searchQuery = '';
    let searchHasFocus = false;
    let dirty = false;

    /* ─── Settings helpers ─── */
    function ctx() { return SillyTavern.getContext(); }

    // Working copy — changes here do NOT affect extensionSettings until save
    let workingData = null;  // { folders: [], assignments: {} }
    let workingPreset = '';

    function ensureStorageExists() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = { presets: {} };
    }

    function getCurrentPresetName() {
        const sel = document.getElementById('settings_preset_openai');
        if (sel) {
            const opt = sel.options[sel.selectedIndex];
            if (opt) return opt.textContent.trim() || opt.value;
        }
        return '__default__';
    }

    // Load from extensionSettings into working copy (deep clone)
    function loadWorkingData() {
        ensureStorageExists();
        const p = getCurrentPresetName();
        const { extensionSettings } = ctx();
        const saved = extensionSettings[MODULE_NAME].presets[p];
        if (saved) {
            workingData = JSON.parse(JSON.stringify(saved));
        } else {
            workingData = { folders: [], assignments: {} };
        }
        workingPreset = p;
        dirty = false;
    }

    // Get working copy (auto-load if preset changed)
    function getPresetData() {
        const p = getCurrentPresetName();
        if (!workingData || workingPreset !== p) loadWorkingData();
        return workingData;
    }

    function markDirty() { dirty = true; }

    // Write working copy back to extensionSettings and save
    function persistNow() {
        ensureStorageExists();
        const { extensionSettings } = ctx();
        extensionSettings[MODULE_NAME].presets[workingPreset] = JSON.parse(JSON.stringify(workingData));
        ctx().saveSettingsDebounced();
        dirty = false;
        console.log('[PF] saved to preset:', workingPreset);
    }

    function hookSaveButton() {
        const btn = document.getElementById('update_oai_preset');
        if (!btn) { setTimeout(hookSaveButton, 2000); return; }
        if (btn._pfHooked) return;
        btn._pfHooked = true;
        btn.addEventListener('click', () => { if (dirty) persistNow(); });
    }

    /* ─── Folder CRUD ─── */
    function addFolder(name) {
        const d = getPresetData();
        const id = 'pf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        d.folders.push({ id, name, collapsed: false, order: d.folders.length, bgColor: '', textColor: '' });
        markDirty(); rebuildFolderUI();
        return id;
    }

    function deleteFolder(folderId) {
        const d = getPresetData();
        d.folders = d.folders.filter(f => f.id !== folderId);
        for (const [k, v] of Object.entries(d.assignments)) { if (v === folderId) delete d.assignments[k]; }
        markDirty(); rebuildFolderUI();
    }

    function renameFolder(folderId, newName) {
        const d = getPresetData();
        const f = d.folders.find(f => f.id === folderId);
        if (f) { f.name = newName; markDirty(); }
    }

    function setFolderColor(folderId, bgColor, textColor) {
        const d = getPresetData();
        const f = d.folders.find(f => f.id === folderId);
        if (f) { f.bgColor = bgColor || ''; f.textColor = textColor || ''; markDirty(); rebuildFolderUI(); }
    }

    function toggleCollapse(folderId) {
        const d = getPresetData();
        const f = d.folders.find(f => f.id === folderId);
        if (f) { f.collapsed = !f.collapsed; markDirty(); }
    }

    function moveFolderUp(folderId) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const idx = sorted.findIndex(f => f.id === folderId);
        if (idx <= 0) return;
        // Remove and insert one position up
        sorted.splice(idx, 1);
        sorted.splice(idx - 1, 0, d.folders.find(f => f.id === folderId));
        sorted.forEach((f, i) => f.order = i);
        markDirty(); rebuildFolderUI();
    }

    function moveFolderDown(folderId) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const idx = sorted.findIndex(f => f.id === folderId);
        if (idx < 0 || idx >= sorted.length - 1) return;
        // Remove and insert one position down
        sorted.splice(idx, 1);
        sorted.splice(idx + 1, 0, d.folders.find(f => f.id === folderId));
        sorted.forEach((f, i) => f.order = i);
        markDirty(); rebuildFolderUI();
    }

    function assignPrompt(identifier, folderId) {
        const d = getPresetData();
        if (folderId) d.assignments[identifier] = folderId;
        else delete d.assignments[identifier];
        markDirty(); rebuildFolderUI();
    }

    /* ─── DOM helpers ─── */
    function getListContainer() {
        return document.getElementById('completion_prompt_manager_list') || document.querySelector('.completion_prompt_manager_list');
    }
    function getPromptRows(c) { return c ? Array.from(c.querySelectorAll('[data-pm-identifier]')) : []; }
    function getPromptName(row) {
        const el = row.querySelector('.prompt_manager_prompt_name, .completion_prompt_manager_prompt_name, [data-pm-name]');
        return el ? el.textContent.trim() : (row.getAttribute('data-pm-identifier') || '?');
    }

    /* ─── Modal overlay ─── */
    function createModalOverlay(innerEl) {
        document.querySelectorAll('.pf-overlay').forEach(el => el.remove());
        const overlay = document.createElement('div');
        overlay.className = 'pf-overlay';
        overlay.appendChild(innerEl);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
        return overlay;
    }

    /* ─── Build UI ─── */
    function rebuildFolderUI() {
        if (isRebuilding) return;
        isRebuilding = true;
        const list = getListContainer();
        if (!list) { isRebuilding = false; return; }

        const si = list.querySelector('.pf-search-input');
        searchHasFocus = si && (document.activeElement === si);
        const cursorPos = searchHasFocus ? si.selectionStart : -1;

        _doRebuild(list);
        syncPromptOrder(list);
        isRebuilding = false;

        if (searchHasFocus) {
            const ns = list.querySelector('.pf-search-input');
            if (ns) { ns.focus(); if (cursorPos >= 0) ns.setSelectionRange(cursorPos, cursorPos); }
        }
    }

    /* ─── Sync prompt order to ST's internal data after DOM reorder ─── */
    function syncPromptOrder(list) {
        try {
            const context = ctx();
            if (!context || !context.promptManager) return;
            const pm = context.promptManager;
            // Get the current DOM order of prompt identifiers
            const rows = getPromptRows(list);
            const orderedIds = rows
                .filter(r => r.style.display !== 'none' || true)
                .map(r => r.getAttribute('data-pm-identifier'))
                .filter(Boolean);
            if (!orderedIds.length) return;

            const d = getPresetData();
            let extensionOrderChanged = false;
            if (!d.promptOrder || d.promptOrder.join(',') !== orderedIds.join(',')) {
                d.promptOrder = orderedIds;
                markDirty();
                extensionOrderChanged = true;
            }

            // Access the prompt manager's internal list and reorder
            if (pm.serviceSettings && pm.serviceSettings.prompts) {
                const prompts = pm.serviceSettings.prompts;
                const promptMap = {};
                prompts.forEach(p => { promptMap[p.identifier] = p; });

                // Build reordered list: ordered IDs first, then any remaining
                const reordered = [];
                const used = new Set();
                for (const id of orderedIds) {
                    if (promptMap[id]) { reordered.push(promptMap[id]); used.add(id); }
                }
                for (const p of prompts) {
                    if (!used.has(p.identifier)) reordered.push(p);
                }

                // Check if order actually changed
                let changed = false;
                if (prompts.length === reordered.length) {
                    for (let i = 0; i < prompts.length; i++) {
                        if (prompts[i].identifier !== reordered[i].identifier) { changed = true; break; }
                    }
                } else { changed = true; }

                if (changed || extensionOrderChanged) {
                    if (changed) {
                        // Replace in-place
                        prompts.length = 0;
                        reordered.forEach(p => prompts.push(p));
                    }

                    // Flush folder and order settings immediately when drag-and-drop modifies order
                    if (extensionOrderChanged) {
                        persistNow();
                    } else if (changed && typeof ctx === 'function') {
                        const context = ctx();
                        if (context.saveSettingsDebounced) context.saveSettingsDebounced();
                    }
                }
            }
        } catch (e) {
            console.warn('[PF] syncPromptOrder error:', e);
        }
    }

    function _doRebuild(list) {
        const d = getPresetData();
        const rows = getPromptRows(list);
        if (rows.length === 0) return;

        list.querySelectorAll('.pf-injected:not(.pf-toolbar)').forEach(el => el.remove());
        list.querySelectorAll('.pf-folder-btn').forEach(el => el.remove());

        const firstRow = rows[0];
        const parent = firstRow.parentElement;

        let toolbar = list.querySelector('.pf-toolbar');
        if (!toolbar) toolbar = createToolbar();
        // Only move if not already at the top (avoids losing focus)
        if (toolbar.parentElement !== list || toolbar !== list.firstChild) {
            list.insertBefore(toolbar, list.firstChild);
        }

        const assignedRows = {};
        const unassignedRows = [];

        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const fId = d.assignments[id];
            if (fId && d.folders.some(f => f.id === fId)) {
                if (!assignedRows[fId]) assignedRows[fId] = [];
                assignedRows[fId].push(row);
            } else {
                unassignedRows.push(row);
            }
            addFolderButton(row, id);
        }

        for (const folder of [...d.folders].sort((a, b) => a.order - b.order)) {
            parent.appendChild(createFolderHeader(folder));
            for (const row of (assignedRows[folder.id] || [])) {
                row.classList.add('pf-folder-item');
                row.setAttribute('data-pf-folder', folder.id);
                parent.appendChild(row);
                row.style.display = (folder.collapsed && !searchQuery) ? 'none' : '';
            }
        }

        if (unassignedRows.length > 0) {
            parent.appendChild(createUncategorizedHeader());
            for (const row of unassignedRows) {
                row.classList.remove('pf-folder-item');
                row.removeAttribute('data-pf-folder');
                row.style.display = '';
                parent.appendChild(row);
            }
        }

        if (searchQuery) applySearchFilter(rows);
    }

    /* ─── Toolbar ─── */
    function createToolbar() {
        const wrap = document.createElement('div');
        wrap.className = 'pf-toolbar pf-injected';

        const sw = document.createElement('div');
        sw.className = 'pf-search-wrap';
        const si = document.createElement('input');
        si.type = 'text'; si.className = 'pf-search-input text_pole';
        si.placeholder = '🔍 프롬프트 검색…'; si.value = searchQuery;
        let st = null;
        si.addEventListener('input', (e) => { searchQuery = e.target.value.toLowerCase(); clearTimeout(st); st = setTimeout(() => rebuildFolderUI(), 200); });
        si.addEventListener('focus', () => { searchHasFocus = true; });
        si.addEventListener('blur', () => { searchHasFocus = false; });
        sw.appendChild(si);

        const bw = document.createElement('div');
        bw.className = 'pf-btn-wrap';
        [
            mkBtn('📁 추가', () => showAddFolderPopup()),
            mkBtn('⬆ 접기', () => { getPresetData().folders.forEach(f => f.collapsed = true); markDirty(); rebuildFolderUI(); }),
            mkBtn('⬇ 펼치기', () => { getPresetData().folders.forEach(f => f.collapsed = false); markDirty(); rebuildFolderUI(); }),
            mkBtn('🔨 편집', () => showBulkEditPopup()),
            mkBtn('📥', () => showImportSettingsPopup()),
        ].forEach(b => bw.appendChild(b));

        wrap.appendChild(sw);
        wrap.appendChild(bw);
        return wrap;
    }

    function mkBtn(text, fn) {
        const b = document.createElement('button');
        b.className = 'pf-btn menu_button'; b.textContent = text;
        b.addEventListener('click', fn); return b;
    }

    /* ─── Folder Header ─── */
    function createFolderHeader(folder) {
        const header = document.createElement('div');
        header.className = 'pf-folder-header pf-injected';
        header.setAttribute('data-pf-folder-id', folder.id);
        if (folder.bgColor) header.style.backgroundColor = folder.bgColor;
        if (folder.textColor) header.style.color = folder.textColor;

        const arrow = document.createElement('span');
        arrow.className = 'pf-arrow';
        arrow.textContent = folder.collapsed ? '▶' : '▼';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'pf-folder-name';
        nameSpan.textContent = folder.name;

        const d = getPresetData();
        const promptIds = Object.entries(d.assignments).filter(([, v]) => v === folder.id).map(([k]) => k);
        const total = promptIds.length;
        const list = getListContainer();
        let active = 0;
        if (list) {
            for (const pid of promptIds) {
                const row = list.querySelector(`[data-pm-identifier="${pid}"]`);
                if (!row) continue;
                const toggle = row.querySelector('input[type="checkbox"]');
                if (toggle && toggle.checked) { active++; continue; }
                if (row.querySelector('.fa-toggle-on, .toggle-on')) { active++; }
            }
        }
        const countSpan = document.createElement('span');
        countSpan.className = 'pf-count';
        countSpan.textContent = `(${active}/${total})`;
        countSpan.title = `${active}개 활성화 / ${total}개 전체`;

        // ⚡ 토글
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'pf-action-btn-always';
        toggleBtn.textContent = '⚡';
        toggleBtn.title = '폴더 전체 토글';
        toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleAllPromptsInFolder(folder.id); });

        // ▲▼ 이동
        const upBtn = document.createElement('span');
        upBtn.className = 'pf-action-btn-always';
        upBtn.textContent = '▲';
        upBtn.title = '위로 이동';
        upBtn.addEventListener('click', (e) => { e.stopPropagation(); moveFolderUp(folder.id); });

        const downBtn = document.createElement('span');
        downBtn.className = 'pf-action-btn-always';
        downBtn.textContent = '▼';
        downBtn.title = '아래로 이동';
        downBtn.addEventListener('click', (e) => { e.stopPropagation(); moveFolderDown(folder.id); });

        // ✏️ 편집 (삭제도 여기 안에)
        const editBtn = document.createElement('span');
        editBtn.className = 'pf-action-btn-always';
        editBtn.textContent = '✏️';
        editBtn.title = '편집';
        editBtn.addEventListener('click', (e) => { e.stopPropagation(); showFolderEditPopup(folder); });

        [arrow, nameSpan, countSpan, toggleBtn, upBtn, downBtn, editBtn].forEach(el => header.appendChild(el));

        // Click → collapse/expand
        header.addEventListener('click', () => { toggleCollapse(folder.id); rebuildFolderUI(); });

        // ★ Folder DnD reorder
        header.setAttribute('draggable', 'true');
        header.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/pf-folder-id', folder.id);
            e.dataTransfer.effectAllowed = 'move';
            header.classList.add('pf-dragging');
        });
        header.addEventListener('dragend', () => {
            header.classList.remove('pf-dragging');
            document.querySelectorAll('.pf-drag-over-top, .pf-drag-over-bottom').forEach(el => {
                el.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
            });
        });
        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer.types.includes('text/pf-folder-id')) return;
            e.dataTransfer.dropEffect = 'move';
            // Show top or bottom indicator based on mouse position
            const rect = header.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            header.classList.toggle('pf-drag-over-top', e.clientY < midY);
            header.classList.toggle('pf-drag-over-bottom', e.clientY >= midY);
        });
        header.addEventListener('dragleave', () => {
            header.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
        });
        header.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = header.getBoundingClientRect();
            const before = e.clientY < rect.top + rect.height / 2;
            header.classList.remove('pf-drag-over-top', 'pf-drag-over-bottom');
            const srcFolderId = e.dataTransfer.getData('text/pf-folder-id');
            if (srcFolderId && srcFolderId !== folder.id) {
                moveFolderToPosition(srcFolderId, folder.id, before);
            }
        });

        return header;
    }

    /* ─── Folder edit popup ─── */
    function showFolderEditPopup(folder) {
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        inner.innerHTML = `
            <div class="pf-popup-title" style="display:flex;align-items:center;justify-content:center;gap:8px">✏️ 폴더 편집<button class="pf-btn menu_button pf-delete-folder" style="color:#ff6b6b;font-size:11px;padding:2px 6px!important;margin-left:auto">🗑️ 삭제</button></div>
            <div class="pf-popup-field"><label>이름:</label><input type="text" class="pf-edit-name text_pole" value="${folder.name}"></div>
            <div class="pf-color-row"><label>배경색:</label><input type="color" class="pf-cbg" value="${folder.bgColor || '#3a3a3a'}"><input type="text" class="pf-cbg-hex text_pole" placeholder="(UI 설정 따름)" value="${folder.bgColor || ''}"><button class="pf-btn menu_button pf-reset-bg" style="font-size:11px;padding:2px 6px!important" title="UI 설정 사용">↺</button></div>
            <div class="pf-color-row"><label>글자색:</label><input type="color" class="pf-ctx" value="${folder.textColor || '#cccccc'}"><input type="text" class="pf-ctx-hex text_pole" placeholder="(UI 설정 따름)" value="${folder.textColor || ''}"><button class="pf-btn menu_button pf-reset-tx" style="font-size:11px;padding:2px 6px!important" title="UI 설정 사용">↺</button></div>
            <div class="pf-popup-actions">
                <button class="pf-btn menu_button pf-popup-ok">적용</button>
                <button class="pf-btn menu_button pf-popup-cancel">취소</button>
            </div>`;
        const overlay = createModalOverlay(inner);
        const bgP = inner.querySelector('.pf-cbg'), bgH = inner.querySelector('.pf-cbg-hex');
        const txP = inner.querySelector('.pf-ctx'), txH = inner.querySelector('.pf-ctx-hex');
        bgP.addEventListener('input', () => bgH.value = bgP.value);
        bgH.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(bgH.value)) bgP.value = bgH.value; });
        txP.addEventListener('input', () => txH.value = txP.value);
        txH.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(txH.value)) txP.value = txH.value; });
        inner.querySelector('.pf-reset-bg').addEventListener('click', () => { bgP.value = '#3a3a3a'; bgH.value = ''; });
        inner.querySelector('.pf-reset-tx').addEventListener('click', () => { txP.value = '#cccccc'; txH.value = ''; });
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const n = inner.querySelector('.pf-edit-name').value.trim();
            if (n) renameFolder(folder.id, n);
            setFolderColor(folder.id, bgH.value, txH.value);
            overlay.remove();
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
        inner.querySelector('.pf-delete-folder').addEventListener('click', () => {
            overlay.remove();
            showConfirmPopup(`"${folder.name}" 폴더 삭제?\n(프롬프트는 미분류로 이동)`, () => deleteFolder(folder.id));
        });
    }

    /* ─── Uncategorized Header ─── */
    function createUncategorizedHeader() {
        const header = document.createElement('div');
        header.className = 'pf-uncat-header pf-injected';
        header.textContent = '📋 미분류';
        return header;
    }

    /* ─── Folder assign button (📂) ─── */
    function addFolderButton(row, identifier) {
        if (row.querySelector('.pf-folder-btn')) return;
        const btn = document.createElement('span');
        btn.className = 'pf-folder-btn'; btn.textContent = '📂'; btn.title = '폴더 선택';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showFolderPicker(identifier, btn); });
        // Insert into the last grid column (actions area) alongside existing icons
        const actionsCol = row.lastElementChild;
        if (actionsCol) {
            actionsCol.appendChild(btn);
        } else {
            row.appendChild(btn);
        }
    }

    /* ─── Folder Picker ─── */
    function showFolderPicker(identifier, anchorEl) {
        document.querySelectorAll('.pf-picker').forEach(el => el.remove());
        const d = getPresetData();
        const popup = document.createElement('div');
        popup.className = 'pf-picker';
        const cur = d.assignments[identifier];

        const none = document.createElement('div');
        none.className = 'pf-picker-item' + (!cur ? ' pf-picker-selected' : '');
        none.textContent = '❌ 미분류' + (!cur ? ' (현재)' : '');
        none.addEventListener('click', () => { assignPrompt(identifier, null); popup.remove(); });
        popup.appendChild(none);

        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) {
            const isCurrent = cur === f.id;
            const item = document.createElement('div');
            item.className = 'pf-picker-item' + (isCurrent ? ' pf-picker-selected' : '');
            item.textContent = '📁 ' + f.name + (isCurrent ? ' (현재)' : '');
            if (f.bgColor) item.style.borderLeft = `4px solid ${f.bgColor}`;
            item.addEventListener('click', () => { assignPrompt(identifier, f.id); popup.remove(); });
            popup.appendChild(item);
        }

        document.body.appendChild(popup);
        const r = anchorEl.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.top = Math.min(r.bottom + 2, window.innerHeight - 200) + 'px';
        popup.style.left = Math.min(r.left, window.innerWidth - 180) + 'px';
        popup.style.zIndex = '99999';

        setTimeout(() => {
            const h = (e) => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', h, true); } };
            document.addEventListener('click', h, true);
        }, 50);
    }

    /* ─── Add Folder Popup ─── */
    function showAddFolderPopup() {
        const list = getListContainer();
        const rows = list ? getPromptRows(list) : [];
        const d = getPresetData();
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        let html = '';
        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const name = getPromptName(row);
            const a = d.assignments[id];
            const fo = a ? d.folders.find(f => f.id === a) : null;
            const badge = fo ? `<span class="pf-badge">${fo.name}</span>` : '';
            html += `<label class="pf-prompt-check" data-folder="${a || ''}"><input type="checkbox" value="${id}"> ${name} ${badge}</label>`;
        }
        // Build filter options
        let filterHTML = '<option value="__all__">전체</option><option value="">미분류</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) filterHTML += `<option value="${f.id}">📁 ${f.name}</option>`;

        inner.innerHTML = `
            <div class="pf-popup-title">📁 새 폴더 추가</div>
            <div class="pf-popup-field"><label>이름:</label><input type="text" class="pf-popup-name text_pole" placeholder="폴더 이름…"></div>
            <div class="pf-popup-field"><label>프롬프트 선택 (선택사항):</label>
                <div class="pf-filter-row">
                    <select class="pf-category-filter text_pole">${filterHTML}</select>
                    <label class="pf-select-all-label"><input type="checkbox" class="pf-add-check-all"> 전체 선택</label>
                </div>
                <div class="pf-prompt-list">${html}</div></div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">추가</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>`;

        setupCategoryFilter(inner);

        const overlay = createModalOverlay(inner);
        const ni = inner.querySelector('.pf-popup-name');
        setTimeout(() => ni.focus(), 50);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const name = ni.value.trim();
            if (!name) { ni.style.borderColor = 'red'; return; }
            const fid = addFolder(name);
            const dd = getPresetData();
            inner.querySelectorAll('.pf-prompt-check input:checked').forEach(cb => { dd.assignments[cb.value] = fid; });
            markDirty(); overlay.remove(); rebuildFolderUI();
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
        ni.addEventListener('keydown', (e) => { if (e.key === 'Enter') inner.querySelector('.pf-popup-ok').click(); });
    }

    /* ─── Confirm Popup ─── */
    function showConfirmPopup(msg, onOk) {
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        inner.innerHTML = `<div class="pf-popup-title">⚠️ 확인</div><div class="pf-confirm-msg">${msg}</div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">삭제</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>`;
        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => { onOk(); overlay.remove(); });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    /* ─── Bulk Edit Popup ─── */
    function showBulkEditPopup() {
        const list = getListContainer();
        const rows = list ? getPromptRows(list) : [];
        const d = getPresetData();
        if (!d.folders.length) { showConfirmPopup('먼저 폴더를 추가하세요', () => { }); return; }
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        let plHTML = '';
        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const name = getPromptName(row);
            const a = d.assignments[id];
            const fo = a ? d.folders.find(f => f.id === a) : null;
            const badge = fo ? `<span class="pf-badge">${fo.name}</span>` : '<span class="pf-badge pf-badge-none">미분류</span>';
            plHTML += `<label class="pf-prompt-check" data-folder="${a || ''}"><input type="checkbox" value="${id}"> ${name} ${badge}</label>`;
        }
        let foHTML = '<option value="">❌ 미분류</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) foHTML += `<option value="${f.id}">📁 ${f.name}</option>`;
        // Filter options
        let filterHTML = '<option value="__all__">전체</option><option value="">미분류</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) filterHTML += `<option value="${f.id}">📁 ${f.name}</option>`;

        inner.innerHTML = `
            <div class="pf-popup-title">📋 대량 편집</div>
            <div class="pf-popup-field"><label>프롬프트 이동:</label>
                <div class="pf-filter-row">
                    <select class="pf-category-filter text_pole">${filterHTML}</select>
                    <label class="pf-select-all-label"><input type="checkbox" class="pf-bulk-check-all"> 전체 선택</label>
                </div>
                <div class="pf-prompt-list">${plHTML}</div></div>
            <div class="pf-popup-field"><label>이동할 폴더:</label><select class="pf-bulk-target text_pole">${foHTML}</select></div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">이동</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>`;

        setupCategoryFilter(inner);

        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const t = inner.querySelector('.pf-bulk-target').value || null;
            const dd = getPresetData();
            inner.querySelectorAll('.pf-prompt-check input:checked').forEach(cb => {
                if (t) dd.assignments[cb.value] = t; else delete dd.assignments[cb.value];
            });
            markDirty(); overlay.remove(); rebuildFolderUI();
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    /* ─── Import Settings ─── */
    function showImportSettingsPopup() {
        const { extensionSettings } = ctx();
        const allPresets = extensionSettings[MODULE_NAME]?.presets || {};
        const presetNames = Object.keys(allPresets).filter(p => p !== workingPreset);

        if (presetNames.length === 0) {
            showConfirmPopup('가져올 다른 프리셋이 없습니다.', () => { });
            return;
        }

        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';

        let options = '';
        presetNames.forEach(p => options += `<option value="${p}">${p}</option>`);

        inner.innerHTML = `
            <div class="pf-popup-title">📥 다른 프리셋에서 설정 가져오기</div>
            <div class="pf-popup-field">
                <label>가져올 프리셋:</label>
                <select class="pf-import-select text_pole">${options}</select>
            </div>
            <div class="pf-popup-field" style="font-size:12px;color:#aaa;margin-top:10px;line-height:1.4;">
                현재 폴더 설정에 선택한 프리셋의 폴더 구조와<br>프롬프트 할당 정보가 추가/병합됩니다.<br>
                (프롬프트 내부 ID 기반)
            </div>
            <div class="pf-popup-actions">
                <button class="pf-btn menu_button pf-popup-ok">가져오기</button>
                <button class="pf-btn menu_button pf-popup-cancel">취소</button>
            </div>`;

        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const presetName = inner.querySelector('.pf-import-select').value;
            if (presetName && allPresets[presetName]) {
                importSettingsFromPreset(allPresets[presetName]);
                overlay.remove();
                showConfirmPopup('폴더 설정을 성공적으로 가져왔습니다.', () => { });
            }
        });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    function importSettingsFromPreset(sourceData) {
        if (!sourceData || !sourceData.folders) return;
        const d = getPresetData();

        const folderIdMap = {};

        sourceData.folders.forEach(srcFolder => {
            let existing = d.folders.find(f => f.name === srcFolder.name);
            if (existing) {
                folderIdMap[srcFolder.id] = existing.id;
            } else {
                const newId = 'pf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                d.folders.push({
                    id: newId,
                    name: srcFolder.name,
                    collapsed: srcFolder.collapsed,
                    order: d.folders.length,
                    bgColor: srcFolder.bgColor || '',
                    textColor: srcFolder.textColor || ''
                });
                folderIdMap[srcFolder.id] = newId;
            }
        });

        if (sourceData.assignments) {
            Object.keys(sourceData.assignments).forEach(identifier => {
                const srcFolderId = sourceData.assignments[identifier];
                const destFolderId = folderIdMap[srcFolderId];
                if (destFolderId) {
                    d.assignments[identifier] = destFolderId;
                }
            });
        }

        if (sourceData.promptOrder && sourceData.promptOrder.length > 0) {
            d.promptOrder = [...sourceData.promptOrder];

            // Reorder the DOM explicitly here to match sourceData.promptOrder
            const list = getListContainer();
            if (list) {
                const rows = getPromptRows(list);
                const orderMap = {};
                sourceData.promptOrder.forEach((id, idx) => { orderMap[id] = idx; });

                rows.sort((a, b) => {
                    const idA = a.getAttribute('data-pm-identifier');
                    const idB = b.getAttribute('data-pm-identifier');
                    const pA = orderMap[idA] ?? 999999;
                    const pB = orderMap[idB] ?? 999999;
                    return pA - pB;
                });

                // Append rows to their parent based on new order
                if (rows.length > 0) {
                    const parent = rows[0].parentElement;
                    rows.forEach(row => parent.appendChild(row));
                }
            }
        }

        markDirty();
        persistNow(); // auto-save the imported settings
        rebuildFolderUI();
    }


    /* ─── Category filter helper ─── */
    function setupCategoryFilter(container) {
        const filterSel = container.querySelector('.pf-category-filter');
        const checkAll = container.querySelector('.pf-add-check-all, .pf-bulk-check-all');
        if (!filterSel) return;

        function updateEmptyState() {
            const promptList = container.querySelector('.pf-prompt-list');
            if (!promptList) return;
            let existing = promptList.querySelector('.pf-empty-msg');
            const visibleItems = promptList.querySelectorAll('.pf-prompt-check:not([style*="display: none"])');
            if (visibleItems.length === 0) {
                if (!existing) {
                    existing = document.createElement('div');
                    existing.className = 'pf-empty-msg';
                    existing.textContent = '프롬프트가 없습니다.';
                    promptList.appendChild(existing);
                }
                existing.style.display = '';
            } else if (existing) {
                existing.style.display = 'none';
            }
        }

        filterSel.addEventListener('change', () => {
            const val = filterSel.value;
            container.querySelectorAll('.pf-prompt-check').forEach(label => {
                const folder = label.getAttribute('data-folder');
                label.style.display = (val === '__all__' || folder === val) ? '' : 'none';
            });
            if (checkAll) checkAll.checked = false;
            updateEmptyState();
        });

        if (checkAll) {
            checkAll.addEventListener('change', (e) => {
                container.querySelectorAll('.pf-prompt-check').forEach(label => {
                    if (label.style.display !== 'none') {
                        const cb = label.querySelector('input[type="checkbox"]');
                        if (cb) cb.checked = e.target.checked;
                    }
                });
            });
        }
    }

    /* ─── Move folder to position (insert, not swap) for DnD ─── */
    function moveFolderToPosition(srcId, targetId, before) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const srcIdx = sorted.findIndex(f => f.id === srcId);
        if (srcIdx < 0) return;
        const srcFolder = sorted[srcIdx];
        // Remove src from sorted array
        sorted.splice(srcIdx, 1);
        // Find target index in the new array (after removal)
        let tgtIdx = sorted.findIndex(f => f.id === targetId);
        if (tgtIdx < 0) return;
        // Insert before or after target
        if (!before) tgtIdx += 1;
        sorted.splice(tgtIdx, 0, srcFolder);
        // Reassign sequential orders
        sorted.forEach((f, i) => f.order = i);
        markDirty(); rebuildFolderUI();
    }

    /* ─── Toggle all in folder ─── */
    function toggleAllPromptsInFolder(folderId) {
        const d = getPresetData();
        const ids = Object.entries(d.assignments).filter(([, v]) => v === folderId).map(([k]) => k);
        const list = getListContainer();
        if (!list || !ids.length) return;

        // Collect rows and their current toggle states
        const rowData = [];
        for (const pid of ids) {
            const row = list.querySelector(`[data-pm-identifier="${pid}"]`);
            if (!row) continue;
            const toggle = row.querySelector('input[type="checkbox"], .toggle-prompt, [data-pm-toggle], .fa-toggle-on, .fa-toggle-off');
            if (!toggle) continue;
            const isOn = (toggle.type === 'checkbox') ? toggle.checked : toggle.classList.contains('fa-toggle-on');
            rowData.push({ toggle, isOn });
        }
        if (!rowData.length) return;

        // If any is on → turn all off, else turn all on
        const anyOn = rowData.some(r => r.isOn);
        const targetState = !anyOn; // true = turn on, false = turn off

        for (const { toggle, isOn } of rowData) {
            if (isOn !== targetState) toggle.click();
        }
    }

    /* ─── Search filter ─── */
    function applySearchFilter(rows) {
        if (!searchQuery) return;
        const d = getPresetData();
        const mf = new Set();
        let hasVisibleUnassigned = false;
        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const n = getPromptName(row).toLowerCase();
            const c = (row.title || '').toLowerCase();
            if (n.includes(searchQuery) || c.includes(searchQuery)) {
                row.style.display = '';
                const fId = d.assignments[id];
                if (fId) mf.add(fId); else hasVisibleUnassigned = true;
            } else { row.style.display = 'none'; }
        }
        document.querySelectorAll('.pf-folder-header').forEach(h => {
            const fId = h.getAttribute('data-pf-folder-id');
            const vis = Array.from(document.querySelectorAll(`[data-pf-folder="${fId}"]`)).some(r => r.style.display !== 'none');
            h.style.display = (mf.has(fId) || vis) ? '' : 'none';
        });
        // Hide uncategorized header if no matching unassigned prompts
        document.querySelectorAll('.pf-uncat-header').forEach(h => {
            h.style.display = hasVisibleUnassigned ? '' : 'none';
        });
    }

    /* ─── Periodic check ─── */
    function periodicCheck() {
        const list = getListContainer();
        if (!list || searchHasFocus) return;
        const cp = getCurrentPresetName();
        if (cp !== lastPreset) {
            lastPreset = cp;
            loadWorkingData(); // discard unsaved, reload from saved data
            list.querySelectorAll('.pf-toolbar').forEach(el => el.remove());
            rebuildFolderUI(); return;
        }
        if (!list.querySelector('.pf-injected')) rebuildFolderUI();
    }

    /* ─── MutationObserver ─── */
    function setupObserver() {
        const target = document.getElementById('completion_prompt_manager') || document.querySelector('.completion_prompt_manager');
        if (!target) return;
        if (observer) observer.disconnect();
        observer = new MutationObserver(() => {
            if (searchHasFocus) return;
            const list = getListContainer();
            if (list && !list.querySelector('.pf-injected') && !isRebuilding) rebuildFolderUI();
        });
        observer.observe(target, { childList: true, subtree: true });
    }

    /* ─── Slash Commands ─── */
    function registerSlashCommands() {
        try {
            const context = ctx();
            if (!context) return;

            // Try to access SlashCommandParser from SillyTavern
            const SlashCommandParser = (window.SillyTavern && window.SillyTavern.getContext().SlashCommandParser) || null;
            const registerSlashCommand = context.registerSlashCommand || (SlashCommandParser ? SlashCommandParser.addCommandObject.bind(SlashCommandParser) : null);

            // Common slash command registration approach
            const registerCmd = (name, callback, helpStr) => {
                try {
                    if (context.registerSlashCommand) {
                        context.registerSlashCommand(name, callback, [], helpStr);
                    } else if (window.registerSlashCommand) {
                        window.registerSlashCommand(name, callback, [], helpStr);
                    }
                } catch (e) { console.warn(`[PF] Failed to register /${name}:`, e); }
            };

            // /togglechd [폴더이름]
            registerCmd('toggle', (args, value) => {
                const folderName = (value || '').trim();
                if (!folderName) return 'Usage: /togglechd [폴더이름]';
                const d = getPresetData();
                const folder = d.folders.find(f => f.name === folderName);
                if (!folder) return `폴더 "${folderName}"을(를) 찾을 수 없습니다.`;
                toggleAllPromptsInFolder(folder.id);
                return `폴더 "${folderName}" 토글 완료`;
            }, '폴더 내 모든 프롬프트 토글 — /togglechd [폴더이름]');

            // /newchd [폴더이름]
            registerCmd('newchd', (args, value) => {
                const folderName = (value || '').trim();
                if (!folderName) return 'Usage: /newchd [폴더이름]';
                addFolder(folderName);
                return `폴더 "${folderName}" 추가 완료`;
            }, '새 폴더 추가 — /newchd [폴더이름]');

            // /editchd [폴더이름]
            registerCmd('editchd', (args, value) => {
                const folderName = (value || '').trim();
                if (!folderName) return 'Usage: /editchd [폴더이름]';
                const d = getPresetData();
                const folder = d.folders.find(f => f.name === folderName);
                if (!folder) return `폴더 "${folderName}"을(를) 찾을 수 없습니다.`;
                showFolderEditPopup(folder);
                return `폴더 "${folderName}" 편집 팝업 표시`;
            }, '폴더 편집 — /editchd [폴더이름]');

            console.log('[PF] Slash commands registered: /togglechd, /newchd, /editchd');
        } catch (e) {
            console.warn('[PF] Slash commands registration failed:', e);
        }
    }

    /* ─── Init ─── */
    function init() {
        console.log('[Prompt Folders] loaded');
        pollTimer = setInterval(periodicCheck, POLL_MS);
        hookSaveButton();
        registerSlashCommands();
        const trySetup = () => {
            const list = getListContainer();
            if (list) { setupObserver(); rebuildFolderUI(); }
            else setTimeout(trySetup, 1000);
        };
        trySetup();
    }

    if (typeof jQuery !== 'undefined') jQuery(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();

