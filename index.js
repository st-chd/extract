/* ============================================================
   Prompt Folders & Search — SillyTavern Extension
   ============================================================ */
(function () {
    'use strict';

    const MODULE_NAME = 'prompt_folders_search';
    const POLL_MS = 800;

    /* ─── 상태 (State) ─── */
    let lastPreset = '';
    let observer = null;
    let isRebuilding = false;
    let rebuildTimeout = null; // 디바운스를 위한 타이머
    let searchQuery = '';
    let searchHasFocus = false;
    let dirty = false;
    let isImporting = false;
    let needsSTSync = false; // 유저가 폴더를 직접 다시 정렬할 때만 참(true)이 됩니다.
    let wasDragging = false; // 기본 드래그 앤 드롭 동작 추적용
    let pendingSaveAs = false; // "프리셋으로 저장" 버튼이 눌렸을 때 true

    /* ─── 설정 도우미 (Settings helpers) ─── */
    function ctx() { return SillyTavern.getContext(); }

    // 작업용 데이터 사본 (Working copy) — 여기서 변경된 내용은 저장 전까지 extensionSettings에 반영되지 않습니다.
    let workingData = null;  // { folders: [], assignments: {} }
    let workingPreset = '';

    function ensureStorageExists() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = { presets: {} };
    }

    // ST에서 삭제된 프리셋의 폴더 데이터를 정리
    function cleanupOldPresets() {
        const sel = document.getElementById('settings_preset_openai');
        if (!sel) return;
        const { extensionSettings } = ctx();
        const presets = extensionSettings[MODULE_NAME]?.presets;
        if (!presets) return;

        const stNames = new Set();
        Array.from(sel.options).forEach(opt => {
            const name = (opt.textContent || '').trim() || opt.value;
            if (name) stNames.add(name);
        });

        let cleaned = 0;
        for (const key of Object.keys(presets)) {
            if (!stNames.has(key)) {
                delete presets[key];
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[PF] ${cleaned}개의 삭제된 프리셋 폴더 데이터 정리 완료`);
            ctx().saveSettingsDebounced();
        }
    }

    function getCurrentPresetName() {
        const sel = document.getElementById('settings_preset_openai');
        if (sel) {
            const opt = sel.options[sel.selectedIndex];
            if (opt) return opt.textContent.trim() || opt.value;
        }
        return '__default__';
    }

    // extensionSettings에서 작업 사본으로 가져오기
    function loadWorkingData(isFirstLoad = false) {
        ensureStorageExists();
        const p = getCurrentPresetName();
        const { extensionSettings } = ctx();
        const session = extensionSettings[MODULE_NAME].sessionState;

        if (isFirstLoad) {
            cleanupOldPresets(); // 초기 로드 시에만 삭제된 프리셋 데이터 정리
            // F5 새로고침 또는 처음 시작: 현재 프리셋과 일치하면 세션 상태 복구
            if (session && session.preset === p && session.data) {
                workingData = JSON.parse(JSON.stringify(session.data));
            } else {
                const saved = extensionSettings[MODULE_NAME].presets[p];
                workingData = saved ? JSON.parse(JSON.stringify(saved)) : { folders: [], assignments: {} };
            }
        } else {
            // 세션 도중 프리셋 변경
            const saved = extensionSettings[MODULE_NAME].presets[p];
            if (saved) {
                workingData = JSON.parse(JSON.stringify(saved));
            } else if (pendingSaveAs && workingData) {
                // [프리셋으로 저장] 버튼을 눌렀을 때: 현재 폴더를 새 이름으로 영구 저장
                console.log(`[PF] Save As: 폴더 설정을 새 프리셋 '${p}'에 영구 저장`);
                pendingSaveAs = false;
                extensionSettings[MODULE_NAME].presets[p] = JSON.parse(JSON.stringify(workingData));
            } else if (workingData && workingPreset) {
                // [이름 변경 감지] 이전 이름이 드롭다운에서 사라졌으면 = 이름 변경!
                const sel = document.getElementById('settings_preset_openai');
                const stNames = new Set();
                if (sel) Array.from(sel.options).forEach(opt => {
                    const name = (opt.textContent || '').trim() || opt.value;
                    if (name) stNames.add(name);
                });
                if (!stNames.has(workingPreset) && stNames.has(p)) {
                    // 이전 이름 사라짐 + 새 이름 등장 = 이름 변경!
                    console.log(`[PF] 프리셋 이름 변경 감지: '${workingPreset}' → '${p}', 폴더 데이터 이전`);
                    // 이전 이름의 영구 저장 데이터도 새 이름으로 이전
                    if (extensionSettings[MODULE_NAME].presets[workingPreset]) {
                        extensionSettings[MODULE_NAME].presets[p] = extensionSettings[MODULE_NAME].presets[workingPreset];
                        delete extensionSettings[MODULE_NAME].presets[workingPreset];
                    }
                    // workingData는 그대로 유지 (임시저장 상태 보존)
                } else {
                    // 새 프리셋 (Import 등): 빈 폴더로 시작
                    workingData = { folders: [], assignments: {} };
                }
            } else {
                workingData = { folders: [], assignments: {} };
            }
            extensionSettings[MODULE_NAME].sessionState = { preset: p, data: JSON.parse(JSON.stringify(workingData)) };
            ctx().saveSettingsDebounced();
        }

        workingPreset = p;
        dirty = false;
    }

    // 작업 사본 가져오기 (이름이 변경된 경우 자동 불러오기)
    function getPresetData() {
        const p = getCurrentPresetName();
        if (!workingData || workingPreset !== p) loadWorkingData(lastPreset === '');
        return workingData;
    }

    function markDirty() {
        dirty = true;
        // F5를 눌러도 상태가 유지되도록 sessionState에만 임시 저장 (실제 프리셋에는 저장 버튼 클릭 시에만 저장)
        const { extensionSettings } = ctx();
        extensionSettings[MODULE_NAME].sessionState = { preset: workingPreset, data: JSON.parse(JSON.stringify(workingData)) };
        ctx().saveSettingsDebounced();
    }

    // 작업 사본을 extensionSettings의 실제 프리셋으로 작성 (프리셋 업데이트를 클릭했을 때만 실행)
    function persistNow() {
        ensureStorageExists();
        const { extensionSettings } = ctx();
        extensionSettings[MODULE_NAME].presets[workingPreset] = JSON.parse(JSON.stringify(workingData));
        extensionSettings[MODULE_NAME].sessionState = { preset: workingPreset, data: JSON.parse(JSON.stringify(workingData)) };
        ctx().saveSettingsDebounced();
        dirty = false;
        console.log('[PF] saved to preset:', workingPreset);
    }

    function hookSaveButton() {
        // ① 현재 프리셋 업데이트 (그냥 저장)
        const btn = document.getElementById('update_oai_preset');
        if (!btn) { setTimeout(hookSaveButton, 2000); return; }
        if (btn._pfHooked) return;
        btn._pfHooked = true;
        btn.addEventListener('click', () => { if (dirty) persistNow(); });

        // ② 프리셋으로 저장 (다른 이름으로 저장) — 현재 폴더를 새 이름으로 영구 저장
        const saveAsBtn = document.getElementById('new_oai_preset');
        if (saveAsBtn && !saveAsBtn._pfHooked) {
            saveAsBtn._pfHooked = true;
            saveAsBtn.addEventListener('click', () => {
                pendingSaveAs = true;
                console.log('[PF] Save As 버튼 감지: 폴더 이어받기 대기 중');
            });
        }
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
        // 제거 후 한 칸 위로 삽입
        sorted.splice(idx, 1);
        sorted.splice(idx - 1, 0, d.folders.find(f => f.id === folderId));
        sorted.forEach((f, i) => f.order = i);
        markDirty(); needsSTSync = true; rebuildFolderUI();
    }

    function moveFolderDown(folderId) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const idx = sorted.findIndex(f => f.id === folderId);
        if (idx < 0 || idx >= sorted.length - 1) return;
        // 제거 후 한 칸 아래로 삽입
        sorted.splice(idx, 1);
        sorted.splice(idx + 1, 0, d.folders.find(f => f.id === folderId));
        sorted.forEach((f, i) => f.order = i);
        markDirty(); needsSTSync = true; rebuildFolderUI();
    }

    function assignPrompt(identifier, folderId) {
        const d = getPresetData();
        if (folderId) d.assignments[identifier] = folderId;
        else delete d.assignments[identifier];
        markDirty(); rebuildFolderUI();
    }

    /* ─── DOM 도우미 ─── */
    function getListContainer() {
        return document.getElementById('completion_prompt_manager_list') || document.querySelector('.completion_prompt_manager_list');
    }
    function getPromptRows(c) { return c ? Array.from(c.querySelectorAll('[data-pm-identifier]')) : []; }
    function getPromptName(row) {
        const el = row.querySelector('.prompt_manager_prompt_name, .completion_prompt_manager_prompt_name, [data-pm-name]');
        return el ? el.textContent.trim() : (row.getAttribute('data-pm-identifier') || '?');
    }

    /* ─── 모달 오버레이 ─── */
    function createModalOverlay(innerEl) {
        document.querySelectorAll('.pf-overlay').forEach(el => el.remove());
        const overlay = document.createElement('div');
        overlay.className = 'pf-overlay';
        overlay.appendChild(innerEl);

        // 모달 클릭 시 ST의 외부 클릭 방지(패널 닫힘) 우회하기 (모바일 터치 이벤트 포함)
        const stopProp = (e) => e.stopPropagation();
        const startHandler = (e) => {
            e.stopPropagation();
            if (e.target === overlay) {
                // 이벤트 타겟이 떨어진 후 bubbling되는 것을 막기 위해 살짝 지연해서 없앱니다.
                setTimeout(() => overlay.remove(), 0);
            }
        };

        overlay.addEventListener('mousedown', startHandler);
        overlay.addEventListener('touchstart', startHandler, { passive: false });
        overlay.addEventListener('mouseup', stopProp);
        overlay.addEventListener('touchend', stopProp);
        overlay.addEventListener('touchcancel', stopProp);
        overlay.addEventListener('click', stopProp);

        document.body.appendChild(overlay);
        return overlay;
    }

    /* ─── UI 생성 (Build UI) ─── */
    function rebuildFolderUI() {
        if (isRebuilding) return;

        // 중복 호출 방지를 위한 디바운스 (여러 번의 Mutation이 발생해도 1번만 실행)
        clearTimeout(rebuildTimeout);
        rebuildTimeout = setTimeout(() => {
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
        }, 30); // 30ms 디바운스
    }

    /* ─── DOM 재정렬 후 ST 내부 데이터에 프롬프트 순서 동기화 ─── */
    function getServiceSettings() {
        // prompt_order가 있는 OpenAI/service 설정을 찾기 위해 여러 경로 탐색
        try {
            const context = ctx();
            // 경로 1: context.promptManager
            if (context.promptManager && context.promptManager.serviceSettings) {
                return context.promptManager.serviceSettings;
            }
            // 경로 2: oai_settings 전역
            if (window.oai_settings) {
                return window.oai_settings;
            }
            // 경로 3: context.openai_settings
            if (context.openai_settings) {
                return context.openai_settings;
            }
            // 경로 4: context 내부 객체 중 prompt_order를 가진 객체 찾기
            for (const key of Object.keys(context)) {
                const val = context[key];
                if (val && typeof val === 'object' && !Array.isArray(val) && 'prompt_order' in val) {
                    console.log('[PF] found prompt_order in context.' + key);
                    return val;
                }
            }
            console.warn('[PF] could not find serviceSettings. Context keys:', Object.keys(context).join(', '));
        } catch (e) {
            console.warn('[PF] getServiceSettings error:', e);
        }
        return null;
    }

    function syncPromptOrder(list) {
        try {
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

            // ★ 유저가 폴더를 수동으로 정렬했을 때만 ST 내부 데이터 수정
            if (needsSTSync && !isImporting) {
                const ss = getServiceSettings();
                if (ss) {
                    // prompts 배열 재정렬
                    if (ss.prompts) {
                        const prompts = ss.prompts;
                        const promptMap = {};
                        prompts.forEach(p => { promptMap[p.identifier] = p; });

                        const reordered = [];
                        const used = new Set();
                        for (const id of orderedIds) {
                            if (promptMap[id]) { reordered.push(promptMap[id]); used.add(id); }
                        }
                        for (const p of prompts) {
                            if (!used.has(p.identifier)) reordered.push(p);
                        }

                        let changed = false;
                        for (let i = 0; i < prompts.length; i++) {
                            if (prompts[i]?.identifier !== reordered[i]?.identifier) { changed = true; break; }
                        }

                        if (changed) {
                            prompts.length = 0;
                            reordered.forEach(p => prompts.push(p));
                            console.log('[PF] prompts array reordered');
                        }
                    }

                    // 메모리의 prompt_order 재정렬
                    if (ss.prompt_order) {
                        reorderPromptOrderEntries(ss, orderedIds);
                    }
                }
                needsSTSync = false;
            }
        } catch (e) {
            console.warn('[PF] syncPromptOrder error:', e);
        }
    }

    /* ─── ST의 prompt_order 항목을 폴더 순서에 맞게 재정렬 ─── */
    function reorderPromptOrderEntries(ss, orderedIds) {
        try {
            if (!ss || !ss.prompt_order) {
                console.warn('[PF] prompt_order not found');
                return false;
            }
            const promptOrder = ss.prompt_order;
            if (!Array.isArray(promptOrder) || promptOrder.length === 0) {
                console.warn('[PF] prompt_order is empty or not array');
                return false;
            }

            console.log('[PF] prompt_order entries:', promptOrder.length,
                'structure:', JSON.stringify(promptOrder.map(e => ({
                    character_id: e.character_id,
                    orderLen: e.order ? e.order.length : 0
                }))));

            let anyChanged = false;
            const firstEntry = promptOrder[0];

            if (firstEntry && typeof firstEntry === 'object' && 'order' in firstEntry) {
                // 중첩된 구조: [{character_id, order: [...]}]
                for (const entry of promptOrder) {
                    if (entry && Array.isArray(entry.order)) {
                        const before = entry.order.map(e => e.identifier).join(',');
                        reorderFlatOrderArray(entry.order, orderedIds);
                        const after = entry.order.map(e => e.identifier).join(',');
                        if (before !== after) {
                            anyChanged = true;
                            console.log(`[PF] character_id ${entry.character_id} order changed`);
                        }
                    }
                }
            } else if (firstEntry && typeof firstEntry === 'object' && 'identifier' in firstEntry) {
                // 평탄한 구조: [{identifier, enabled}]
                const before = promptOrder.map(e => e.identifier).join(',');
                reorderFlatOrderArray(promptOrder, orderedIds);
                const after = promptOrder.map(e => e.identifier).join(',');
                if (before !== after) anyChanged = true;
            }

            if (anyChanged) {
                console.log('[PF] prompt_order reordered successfully');
            } else {
                console.log('[PF] prompt_order: no change needed');
            }
            return anyChanged;
        } catch (e) {
            console.warn('[PF] reorderPromptOrderEntries error:', e);
            return false;
        }
    }

    function reorderFlatOrderArray(orderArr, orderedIds) {
        if (!Array.isArray(orderArr) || orderArr.length === 0) return;
        const entryMap = {};
        orderArr.forEach(e => { if (e && e.identifier) entryMap[e.identifier] = e; });

        const reordered = [];
        const used = new Set();
        for (const id of orderedIds) {
            if (entryMap[id]) { reordered.push(entryMap[id]); used.add(id); }
        }
        // orderedIds에 없는 나머지 항목들 이어붙이기
        for (const e of orderArr) {
            if (e && e.identifier && !used.has(e.identifier)) reordered.push(e);
            else if (e && !e.identifier) reordered.push(e); // 식별자 없는 항목 유지
        }

        // 제자리 교체 (Replace in-place)
        orderArr.length = 0;
        reordered.forEach(e => orderArr.push(e));
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
        // 아직 상단에 없을 때만 상단으로 이동시킵니다 (포커스 잃음 방지)
        if (toolbar.parentElement !== list || toolbar !== list.firstChild) {
            list.insertBefore(toolbar, list.firstChild);
        }

        const assignedRows = {};
        const unassignedRows = [];

        // 검색용 Set (빠른 조회)
        const validFolderIds = new Set(d.folders.map(f => f.id));

        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const fId = d.assignments[id];
            if (fId && validFolderIds.has(fId)) {
                if (!assignedRows[fId]) assignedRows[fId] = [];
                assignedRows[fId].push(row);
            } else {
                unassignedRows.push(row);
            }
            addFolderButton(row, id);
        }

        // DOM 조작 성능 최적화를 위해 DocumentFragment 사용 (수십 개의 폴더로 인한 렉 방지)
        const fragment = document.createDocumentFragment();

        for (const folder of [...d.folders].sort((a, b) => a.order - b.order)) {
            fragment.appendChild(createFolderHeader(folder));
            const isHidden = (folder.collapsed && !searchQuery);
            for (const row of (assignedRows[folder.id] || [])) {
                row.classList.add('pf-folder-item');
                row.setAttribute('data-pf-folder', folder.id);
                // 이동하기 전에 디스플레이 속성을 먼저 적용하여 계산 최소화
                row.style.display = isHidden ? 'none' : '';
                fragment.appendChild(row);
            }
        }

        if (unassignedRows.length > 0) {
            fragment.appendChild(createUncategorizedHeader());
            for (const row of unassignedRows) {
                row.classList.remove('pf-folder-item');
                row.removeAttribute('data-pf-folder');
                row.style.display = '';
                fragment.appendChild(row);
            }
        }

        // 메모리에서 완성된 구조를 실제 DOM에 한 번에 적용
        parent.appendChild(fragment);

        // 무한 루프 방지: 현재 DOM에 존재하는 프롬프트 ID 목록을 해시 형태로 저장
        list._pfHash = Array.from(list.querySelectorAll('[data-pm-identifier]'))
            .map(r => r.getAttribute('data-pm-identifier'))
            .filter(Boolean).join('|');

        if (searchQuery) applySearchFilter(rows);

        // [드래그 렉 해결 핵심] SortableJS가 우리가 삽입한 폴더 헤더를 무시하도록 패치
        patchSortable(list);

        // ★ [깜빡임 방지] 프리셋 전환 시 리빌드가 완전히 끝난 후에만 리스트를 다시 표시
        if (isSwitchingPreset) {
            isSwitchingPreset = false;
            list.style.visibility = '';
        }
    }

    /* ─── 도구 모음 (Toolbar) ─── */
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

    /* ─── 폴더 헤더 ─── */
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

        // 클릭 → 접기/펼치기
        header.addEventListener('click', () => { toggleCollapse(folder.id); rebuildFolderUI(); });

        // ★ 폴더 DnD 기능 (드래그 앤 드롭)
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
            // 마우스 위치에 따라 위쪽 혹은 아래쪽 표시기 표시
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

    /* ─── 폴더 편집 팝업 ─── */
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

    /* ─── 미분류 헤더 ─── */
    function createUncategorizedHeader() {
        const header = document.createElement('div');
        header.className = 'pf-uncat-header pf-injected';
        header.textContent = '📋 미분류';
        return header;
    }

    /* ─── 폴더 할당 버튼 (📂) ─── */
    function addFolderButton(row, identifier) {
        if (row.querySelector('.pf-folder-btn')) return;
        const btn = document.createElement('span');
        btn.className = 'pf-folder-btn'; btn.textContent = '📂'; btn.title = '폴더 선택';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showFolderPicker(identifier, btn); });
        // 기존 아이콘들과 나란히 마지막 그리드 열(작업 영역)에 삽입
        const actionsCol = row.lastElementChild;
        if (actionsCol) {
            actionsCol.appendChild(btn);
        } else {
            row.appendChild(btn);
        }
    }

    /* ─── 폴더 선택기 (Folder Picker) ─── */
    function showFolderPicker(identifier, anchorEl) {
        document.querySelectorAll('.pf-picker').forEach(el => el.remove());
        const d = getPresetData();
        const popup = document.createElement('div');
        popup.className = 'pf-picker';
        const cur = d.assignments[identifier];

        const none = document.createElement('div');
        none.className = 'pf-picker-item' + (!cur ? ' pf-picker-selected' : '');
        none.textContent = '미분류' + (!cur ? ' (현재)' : '');
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
            const h = (e) => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', h, true); document.removeEventListener('touchend', h, true); } };
            document.addEventListener('click', h, true);
            document.addEventListener('touchend', h, true);
        }, 50);

        // 모바일 패널 닫힘 방지
        const stopProp = (e) => e.stopPropagation();
        popup.addEventListener('mousedown', stopProp);
        popup.addEventListener('touchstart', stopProp, { passive: false });
        popup.addEventListener('mouseup', stopProp);
        popup.addEventListener('touchend', stopProp);
        popup.addEventListener('touchcancel', stopProp);
        popup.addEventListener('click', stopProp);
    }

    /* ─── 폴더 추가 팝업 ─── */
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
            html += `<label class="pf-prompt-check" data-folder="${a || ''}"><input type="checkbox" value="${id}"><span class="pf-prompt-name">${name}</span>${badge}</label>`;
        }
        // 필터 옵션 생성
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

    /* ─── 확인 팝업 (Confirm Popup) ─── */
    function showConfirmPopup(msg, onOk) {
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        inner.innerHTML = `<div class="pf-popup-title">⚠️ 확인</div><div class="pf-confirm-msg">${msg}</div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">삭제</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>`;
        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => { onOk(); overlay.remove(); });
        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    /* ─── Alert Popup (확인 버튼만) ─── */
    function showAlertPopup(msg) {
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';
        inner.innerHTML = `<div class="pf-popup-title">✅ 알림</div><div class="pf-confirm-msg">${msg}</div>
            <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">확인</button></div>`;
        const overlay = createModalOverlay(inner);
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => overlay.remove());
    }

    /* ─── 대량 편집 팝업 (Bulk Edit Popup) ─── */
    function showBulkEditPopup() {
        const list = getListContainer();
        const rows = list ? getPromptRows(list) : [];
        const d = getPresetData();
        if (!d.folders.length) { showConfirmPopup('먼저 폴더를 추가하세요', () => { }); return; }
        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';

        // ─── 프롬프트 이동 모드 HTML ─── 
        let plHTML = '';
        for (const row of rows) {
            const id = row.getAttribute('data-pm-identifier');
            const name = getPromptName(row);
            const a = d.assignments[id];
            const fo = a ? d.folders.find(f => f.id === a) : null;
            const badge = fo ? `<span class="pf-badge">${fo.name}</span>` : '<span class="pf-badge pf-badge-none">미분류</span>';
            plHTML += `<label class="pf-prompt-check" data-folder="${a || ''}"><input type="checkbox" value="${id}"><span class="pf-prompt-name">${name}</span>${badge}</label>`;
        }
        let foHTML = '<option value="">미분류</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) foHTML += `<option value="${f.id}">📁 ${f.name}</option>`;
        let filterHTML = '<option value="">미분류</option><option value="__all__">전체</option>';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) filterHTML += `<option value="${f.id}">📁 ${f.name}</option>`;

        // ─── 폴더 삭제 모드 HTML ───
        let folderListHTML = '';
        for (const f of [...d.folders].sort((a, b) => a.order - b.order)) {
            const count = Object.values(d.assignments).filter(v => v === f.id).length;
            folderListHTML += `<label class="pf-prompt-check"><input type="checkbox" value="${f.id}"><span class="pf-prompt-name">📁 ${f.name}</span><span class="pf-badge">${count}개 프롬프트</span></label>`;
        }

        inner.innerHTML = `
            <div class="pf-popup-title" style="display:flex;align-items:center;justify-content:space-between;">
                <span>📋 대량 편집</span>
                <button class="pf-btn menu_button pf-toggle-delete-mode" style="font-size:12px;padding:2px 8px;">🗑️ 폴더 삭제</button>
            </div>
            <div class="pf-bulk-move-mode">
                <div class="pf-popup-field"><label>프롬프트 이동:</label>
                    <div class="pf-filter-row">
                        <select class="pf-category-filter text_pole">${filterHTML}</select>
                        <label class="pf-select-all-label"><input type="checkbox" class="pf-bulk-check-all"> 전체 선택</label>
                    </div>
                    <div class="pf-prompt-list">${plHTML}</div></div>
                <div class="pf-popup-field"><label>이동할 폴더:</label><select class="pf-bulk-target text_pole">${foHTML}</select></div>
                <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-ok">이동</button><button class="pf-btn menu_button pf-popup-cancel">취소</button></div>
            </div>
            <div class="pf-bulk-delete-mode" style="display:none;">
                <div class="pf-popup-field"><label>삭제할 폴더 선택:</label>
                    <div style="margin-top:4px;"><label class="pf-select-all-label"><input type="checkbox" class="pf-bulk-delete-check-all"> 전체 선택</label></div>
                    <div class="pf-prompt-list">${folderListHTML}</div></div>
                <div class="pf-popup-field" style="font-size:12px;color:#f88;line-height:1.4;">⚠️ 삭제된 폴더의 프롬프트는 미분류로 이동됩니다.</div>
                <div class="pf-popup-actions"><button class="pf-btn menu_button pf-popup-delete" style="background:rgba(255,60,60,0.3);">🗑️ 삭제</button><button class="pf-btn menu_button pf-popup-cancel2">취소</button></div>
            </div>`;

        setupCategoryFilter(inner);
        // 기본 필터(미분류)를 즉시 적용
        const filterSel = inner.querySelector('.pf-category-filter');
        if (filterSel) filterSel.dispatchEvent(new Event('change'));

        // 모드 토글
        const moveMode = inner.querySelector('.pf-bulk-move-mode');
        const deleteMode = inner.querySelector('.pf-bulk-delete-mode');
        const toggleBtn = inner.querySelector('.pf-toggle-delete-mode');
        let isDeleteMode = false;
        toggleBtn.addEventListener('click', () => {
            isDeleteMode = !isDeleteMode;
            moveMode.style.display = isDeleteMode ? 'none' : '';
            deleteMode.style.display = isDeleteMode ? '' : 'none';
            toggleBtn.textContent = isDeleteMode ? '📋 프롬프트 이동' : '🗑️ 폴더 삭제';
        });

        // 폴더 삭제 전체 선택
        const deleteCheckAll = inner.querySelector('.pf-bulk-delete-check-all');
        if (deleteCheckAll) {
            deleteCheckAll.addEventListener('change', () => {
                deleteMode.querySelectorAll('.pf-prompt-check input[type="checkbox"]').forEach(cb => {
                    cb.checked = deleteCheckAll.checked;
                });
            });
        }

        const overlay = createModalOverlay(inner);

        // 프롬프트 이동 실행
        inner.querySelector('.pf-popup-ok').addEventListener('click', () => {
            const t = inner.querySelector('.pf-bulk-target').value || null;
            const dd = getPresetData();
            inner.querySelectorAll('.pf-bulk-move-mode .pf-prompt-check input:checked').forEach(cb => {
                if (t) dd.assignments[cb.value] = t; else delete dd.assignments[cb.value];
            });
            markDirty(); overlay.remove(); rebuildFolderUI();
        });

        // 폴더 삭제 실행
        inner.querySelector('.pf-popup-delete').addEventListener('click', () => {
            const checkedIds = [];
            deleteMode.querySelectorAll('.pf-prompt-check input:checked').forEach(cb => checkedIds.push(cb.value));
            if (checkedIds.length === 0) return;
            showConfirmPopup(`${checkedIds.length}개의 폴더를 삭제하시겠습니까?`, () => {
                const dd = getPresetData();
                const deleteSet = new Set(checkedIds);
                // 폴더 삭제
                dd.folders = dd.folders.filter(f => !deleteSet.has(f.id));
                // 해당 폴더의 프롬프트 할당 해제
                for (const [pid, fid] of Object.entries(dd.assignments)) {
                    if (deleteSet.has(fid)) delete dd.assignments[pid];
                }
                markDirty(); overlay.remove(); rebuildFolderUI();
            });
        });

        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
        inner.querySelector('.pf-popup-cancel2').addEventListener('click', () => overlay.remove());
    }

    /* ─── 설정 가져오기 / 내보내기 ─── */
    function showImportSettingsPopup() {
        const { extensionSettings } = ctx();
        const allPresets = extensionSettings[MODULE_NAME]?.presets || {};

        // ★ [이름 동기화] ST의 실제 프리셋 드롭다운과 교차 검증하여
        //   이름이 변경되거나 삭제된 프리셋은 목록에서 제외
        const stPresetNames = new Set();
        const sel = document.getElementById('settings_preset_openai');
        if (sel) {
            Array.from(sel.options).forEach(opt => {
                const name = (opt.textContent || '').trim() || opt.value;
                if (name) stPresetNames.add(name);
            });
        }
        const presetNames = Object.keys(allPresets).filter(p => p !== workingPreset && stPresetNames.has(p));

        const inner = document.createElement('div');
        inner.className = 'pf-modal-inner';

        let options = '';
        if (presetNames.length > 0) {
            presetNames.forEach(p => options += `<option value="${p}">${p}</option>`);
        } else {
            options = `<option value="">(가져올 다른 프리셋이 없습니다)</option>`;
        }

        inner.innerHTML = `
            <div class="pf-popup-title">📥 폴더 설정 가져오기 / 내보내기</div>
            <div class="pf-popup-field">
                <label>다른 프리셋에서 가져오기:</label>
                <div style="display:flex;gap:4px;">
                    <select class="pf-import-select text_pole" style="flex:1;" ${presetNames.length ? '' : 'disabled'}>${options}</select>
                    <button class="pf-btn menu_button pf-import-preset-btn" ${presetNames.length ? '' : 'disabled'}>가져오기</button>
                </div>
            </div>
            <div class="pf-popup-field" style="margin-top:4px;display:flex;align-items:center;">
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;"><input type="checkbox" class="pf-import-order-check"> 폴더 및 프롬프트 표시 순서도 포함 (덮어쓰기)</label>
            </div>
            <hr style="border:0; border-top:1px solid rgba(255,255,255,0.1); margin:12px 0;">
            <div class="pf-popup-field">
                <label>파일로 내보내기 / 가져오기 (.json):</label>
                <div style="display:flex;gap:4px;margin-top:4px;">
                    <button class="pf-btn menu_button pf-export-file-btn" style="flex:1;">📤 내보내기</button>
                    <button class="pf-btn menu_button pf-import-file-btn" style="flex:1;">📥 가져오기</button>
                    <input type="file" class="pf-import-file-input" accept=".json" style="display:none;">
                </div>
            </div>
            <div class="pf-popup-actions" style="margin-top:16px;">
                <button class="pf-btn menu_button pf-popup-cancel" style="margin-left:auto;">닫기</button>
            </div>`;

        const overlay = createModalOverlay(inner);
        const orderCheck = inner.querySelector('.pf-import-order-check');

        // 프리셋에서 가져오기
        inner.querySelector('.pf-import-preset-btn').addEventListener('click', () => {
            const presetName = inner.querySelector('.pf-import-select').value;
            if (presetName && allPresets[presetName]) {
                importSettingsFromPreset(allPresets[presetName], orderCheck.checked);
                overlay.remove();
                showAlertPopup('폴더 설정을 성공적으로 가져왔습니다.');
            }
        });

        // 파일로 내보내기
        inner.querySelector('.pf-export-file-btn').addEventListener('click', () => {
            const dataToExport = JSON.stringify(getPresetData(), null, 2);
            const blob = new Blob([dataToExport], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const safeName = workingPreset.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            a.download = `pf_settings_${safeName}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showAlertPopup('설정 파일이 다운로드 되었습니다.');
        });

        // 파일에서 가져오기
        const fileInput = inner.querySelector('.pf-import-file-input');
        inner.querySelector('.pf-import-file-btn').addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const importedData = JSON.parse(ev.target.result);
                    if (!importedData || !importedData.folders) throw new Error('올바르지 않은 PF 설정 파일입니다.');
                    importSettingsFromPreset(importedData, orderCheck.checked);
                    overlay.remove();
                    showAlertPopup('설정 파일에서 폴더를 가져왔습니다.');
                } catch (err) {
                    console.error('[PF] Import file error:', err);
                    showAlertPopup('파일을 읽는 도중 오류가 발생했습니다.');
                }
            };
            reader.readAsText(file);
        });

        inner.querySelector('.pf-popup-cancel').addEventListener('click', () => overlay.remove());
    }

    function importSettingsFromPreset(sourceData, importOrder) {
        if (!sourceData || !sourceData.folders) return;
        const d = getPresetData();

        console.log('[PF] IMPORT START, importOrder:', importOrder);
        console.log('[PF] current folders:', d.folders.map(f => `${f.name}(order=${f.order})`).join(', '));

        // ★ 순서를 가져오지 않을 경우 기존 폴더 순서 백업
        const savedOrders = {};
        if (!importOrder) {
            d.folders.forEach(f => { savedOrders[f.id] = f.order; });
        }

        const folderIdMap = {};

        // ★ 새 폴더의 올바른 생성을 위해 항상 소스 폴더를 표시 순서대로 정렬
        const srcFolders = [...sourceData.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        // 새 폴더를 덧붙이기 위해 기존 최대 순서 추적
        const maxExistingOrder = d.folders.length > 0
            ? Math.max(...d.folders.map(f => f.order)) + 1
            : 0;
        let nextNewOrder = maxExistingOrder;

        srcFolders.forEach(srcFolder => {
            let existing = d.folders.find(f => f.name === srcFolder.name);
            if (existing) {
                folderIdMap[srcFolder.id] = existing.id;
                if (importOrder) {
                    existing.order = srcFolder.order ?? existing.order;
                }
            } else {
                const newId = 'pf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                d.folders.push({
                    id: newId,
                    name: srcFolder.name,
                    collapsed: srcFolder.collapsed,
                    order: nextNewOrder,
                    bgColor: srcFolder.bgColor || '',
                    textColor: srcFolder.textColor || ''
                });
                nextNewOrder++;
                folderIdMap[srcFolder.id] = newId;
            }
        });

        // 할당 적용
        if (sourceData.assignments) {
            Object.keys(sourceData.assignments).forEach(identifier => {
                const srcFolderId = sourceData.assignments[identifier];
                const destFolderId = folderIdMap[srcFolderId];
                if (destFolderId) {
                    d.assignments[identifier] = destFolderId;
                }
            });
        }

        if (importOrder) {
            // ★ 소스의 폴더 순서 사용
            const sorted = [...d.folders].sort((a, b) => a.order - b.order);
            sorted.forEach((f, i) => f.order = i);
        } else {
            // ★ 기존 폴더의 백업된 순서 복원
            d.folders.forEach(f => {
                if (savedOrders[f.id] !== undefined) f.order = savedOrders[f.id];
            });

            // ★ 현재 DOM 프롬프트 순서로부터 새 폴더 순서 파생
            const list = getListContainer();
            if (list) {
                const rows = getPromptRows(list);
                const firstAppearance = {};
                rows.forEach((row, idx) => {
                    const id = row.getAttribute('data-pm-identifier');
                    const folderId = d.assignments[id];
                    if (folderId && !(folderId in firstAppearance)) {
                        firstAppearance[folderId] = idx;
                    }
                });
                // 프롬프트 위치를 기준으로 (백업된 순서가 없는) 새 폴더만 재정렬
                d.folders.forEach(f => {
                    if (savedOrders[f.id] === undefined && firstAppearance[f.id] !== undefined) {
                        // 새 폴더: 첫 번째 프롬프트가 나타나는 위치를 기준으로 순서 설정
                        f.order = 1000 + firstAppearance[f.id];
                    }
                });
            }
            // 순차적으로 재정규화
            const sorted = [...d.folders].sort((a, b) => a.order - b.order);
            sorted.forEach((f, i) => f.order = i);
        }

        console.log('[PF] after order fix:', d.folders.map(f => `${f.name}(order=${f.order})`).join(', '));

        markDirty();

        // ★ 순서를 가져올 때, UI 재구성(rebuild) 전에 DOM과 ST 데이터를 재정렬
        if (importOrder && sourceData.promptOrder && sourceData.promptOrder.length > 0) {
            d.promptOrder = [...sourceData.promptOrder];

            // 소스 프롬프트 순서에 맞춰 DOM 행 재정렬
            const list = getListContainer();
            if (list) {
                const rows = getPromptRows(list);
                if (rows.length > 0) {
                    const orderMap = {};
                    sourceData.promptOrder.forEach((id, idx) => { orderMap[id] = idx; });
                    const sortedRows = [...rows].sort((a, b) => {
                        const pA = orderMap[a.getAttribute('data-pm-identifier')] ?? 999999;
                        const pB = orderMap[b.getAttribute('data-pm-identifier')] ?? 999999;
                        return pA - pB;
                    });
                    const parent = rows[0].parentElement;
                    sortedRows.forEach(row => parent.appendChild(row));
                }
            }

            // ST의 메모리 데이터에도 적용
            const ss = getServiceSettings();
            if (ss) {
                if (ss.prompts) {
                    const promptMap = {};
                    ss.prompts.forEach(p => { promptMap[p.identifier] = p; });
                    const reordered = [];
                    const used = new Set();
                    for (const id of sourceData.promptOrder) {
                        if (promptMap[id]) { reordered.push(promptMap[id]); used.add(id); }
                    }
                    for (const p of ss.prompts) {
                        if (!used.has(p.identifier)) reordered.push(p);
                    }
                    ss.prompts.length = 0;
                    reordered.forEach(p => ss.prompts.push(p));
                }
                if (ss.prompt_order) {
                    reorderPromptOrderEntries(ss, sourceData.promptOrder);
                }
                console.log('[PF] applied source prompt order to ST');
            }
        }

        // ★ UI 재구성 (올바른 폴더 내 순서를 위해 재정렬된 DOM을 탐색합니다)
        isImporting = true;
        rebuildFolderUI();
        isImporting = false;

        console.log('[PF] IMPORT DONE, final folders:', d.folders.map(f => `${f.name}(order=${f.order})`).join(', '));
    }


    /* ─── 카테고리 필터 도우미 ─── */
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

    /* ─── 폴더 이동 (DnD를 위해 스왑이 아닌 삽입) ─── */
    function moveFolderToPosition(srcId, targetId, before) {
        const d = getPresetData();
        const sorted = [...d.folders].sort((a, b) => a.order - b.order);
        const srcIdx = sorted.findIndex(f => f.id === srcId);
        if (srcIdx < 0) return;
        const srcFolder = sorted[srcIdx];
        // 정렬된 배열에서 소스 폴더 제거
        sorted.splice(srcIdx, 1);
        // 새로운 배열(제거 후)에서 타겟 인덱스 찾기
        let tgtIdx = sorted.findIndex(f => f.id === targetId);
        if (tgtIdx < 0) return;
        // 타겟 앞 또는 뒤에 삽입
        if (!before) tgtIdx += 1;
        sorted.splice(tgtIdx, 0, srcFolder);
        // 순차적 순서 재할당
        sorted.forEach((f, i) => f.order = i);
        markDirty(); needsSTSync = true; rebuildFolderUI();
    }

    /* ─── 폴더 안의 모든 프롬프트 토글 ─── */
    function toggleAllPromptsInFolder(folderId) {
        const d = getPresetData();
        const ids = Object.entries(d.assignments).filter(([, v]) => v === folderId).map(([k]) => k);
        const list = getListContainer();
        if (!list || !ids.length) return;

        // 행과 현재 토글 상태 수집
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

        // 켜진 것이 하나라도 있으면 → 모두 끄기, 아니면 모두 켜기
        const anyOn = rowData.some(r => r.isOn);
        const targetState = !anyOn; // true = 켜기, false = 끄기

        for (const { toggle, isOn } of rowData) {
            if (isOn !== targetState) toggle.click();
        }
    }

    /* ─── 검색 필터 ─── */
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
        // 일치하는 미분류 프롬프트가 없으면 미분류 헤더 숨기기
        document.querySelectorAll('.pf-uncat-header').forEach(h => {
            h.style.display = hasVisibleUnassigned ? '' : 'none';
        });
    }

    /* ─── 프리셋 변경 감지 ─── */
    let isSwitchingPreset = false; // ★ 깜빡임 방지용 플래그

    function checkPresetChange() {
        const list = getListContainer();
        if (!list || searchHasFocus) return;
        const cp = getCurrentPresetName();
        if (cp !== lastPreset) {
            const isFirstLoad = (lastPreset === '');
            lastPreset = cp;

            // ★ [깜빡임 방지] 프리셋 전환 시 리스트를 숨김 (리빌드 완료 후 _doRebuild에서 다시 표시)
            if (!isFirstLoad) {
                isSwitchingPreset = true;
                list.style.visibility = 'hidden';
            }

            loadWorkingData(isFirstLoad);
            list.querySelectorAll('.pf-toolbar').forEach(el => el.remove());
            rebuildFolderUI();
        }
    }

    function setupPresetChangeListener() {
        const sel = document.getElementById('settings_preset_openai');
        if (sel) {
            sel.addEventListener('change', checkPresetChange);
        }
    }

    /* ─── [드래그 렉 해결] SortableJS 패치 ─── */
    // SillyTavern의 SortableJS는 리스트 컨테이너의 "모든 직접 자식 요소"를 드래그 가능한 아이템으로 취급합니다.
    // 우리 확장 프로그램이 30+개의 폴더 헤더(.pf-folder-header)를 같은 컨테이너에 삽입하면,
    // SortableJS는 mousedown 시 130+개(프롬프트 100 + 폴더 30)의 요소 모두에 대해
    // getBoundingClientRect() 위치 계산 + 내부 캐시 갱신을 수행하여 심각한 렉이 발생합니다.
    // 이 함수는 SortableJS에게 "[data-pm-identifier] 속성이 있는 요소만 드래그 아이템이야!" 라고
    // 알려줘서, 폴더 헤더들을 완전히 무시하게 만듭니다.
    function patchSortable(list) {
        if (!list || list._pfSortablePatched) return;
        try {
            let sortable = null;

            // 방법 1: 전역 Sortable.get()
            if (window.Sortable && typeof Sortable.get === 'function') {
                try { sortable = Sortable.get(list); } catch (e) { }
            }

            // 방법 2: 요소에 저장된 SortableJS 인스턴스 직접 탐색
            if (!sortable) {
                for (const key of Object.keys(list)) {
                    try {
                        const val = list[key];
                        if (val && typeof val === 'object' && typeof val.option === 'function') {
                            sortable = val;
                            break;
                        }
                    } catch (e) { }
                }
            }

            // 방법 3: Symbol 프로퍼티 탐색 (최신 SortableJS)
            if (!sortable && Object.getOwnPropertySymbols) {
                for (const sym of Object.getOwnPropertySymbols(list)) {
                    try {
                        const val = list[sym];
                        if (val && typeof val === 'object' && typeof val.option === 'function') {
                            sortable = val;
                            break;
                        }
                    } catch (e) { }
                }
            }

            if (sortable && typeof sortable.option === 'function') {
                // ★ 핵심: SortableJS가 프롬프트 행만 드래그 아이템으로 인식하도록 설정
                sortable.option('draggable', '[data-pm-identifier]');
                // ★ 드래그 중 애니메이션 완전 비활성화 (ALL children에 getBoundingClientRect 호출 방지)
                sortable.option('animation', 0);
                // ★ 우리가 삽입한 요소를 드래그 불가능으로 필터링
                const curFilter = sortable.options.filter || '';
                if (!curFilter.includes('.pf-injected')) {
                    sortable.option('filter', curFilter ? `${curFilter}, .pf-injected` : '.pf-injected');
                }
                list._pfSortablePatched = true;
                console.log('[PF] ✅ SortableJS 패치 완료: draggable + animation:0 + filter');
            }
        } catch (e) {
            console.warn('[PF] patchSortable error:', e);
        }
    }

    /* ─── [드래그 렉 해결] 드래그 중 폴더 헤더 DOM 제거 + Observer 비활성화 ─── */
    // SortableJS는 `draggable` 필터와 관계없이 컨테이너의 "모든 직접 자식"을 순회하며
    // 위치 계산(getBoundingClientRect)+ 내부 캐시 갱신을 수행합니다.
    // 근본적 해결책: 프롬프트를 드래그하는 순간, 폴더 헤더를 DOM에서 완전히 제거하여
    // SortableJS가 보는 DOM을 실리태번 순정 상태와 동일하게 만듭니다.
    function setupDragOptimization(list) {
        if (!list || list._pfDragOpt) return;
        list._pfDragOpt = true;

        list.addEventListener('pointerdown', (e) => {
            // 프롬프트 행을 눌렀을 때만 (폴더 헤더나 도구 모음은 제외)
            if (!e.target.closest('[data-pm-identifier]')) return;

            const observerTarget = document.getElementById('completion_prompt_manager')
                || document.querySelector('.completion_prompt_manager');

            // ★ 1. Observer 완전 차단 (드래그 도중 확장 작업 0%)
            if (observer) observer.disconnect();

            // ★ 2. 폴더 헤더를 제거하기 전에: 각 폴더의 첫 번째 프롬프트에 폴더 이름을 마킹
            //    CSS ::before 로 폴더 이름을 표시하므로 DOM 요소 추가 0개 = SortableJS 영향 없음!
            const d = getPresetData();
            const folderNameMap = {};
            d.folders.forEach(f => { folderNameMap[f.id] = f.name; });

            // 각 폴더의 첫 번째 프롬프트에 라벨 표시
            const seenFolders = new Set();
            list.querySelectorAll('[data-pf-folder]').forEach(el => {
                const fId = el.getAttribute('data-pf-folder');
                if (fId && !seenFolders.has(fId) && folderNameMap[fId]) {
                    el.setAttribute('data-pf-drag-label', '📁 ' + folderNameMap[fId]);
                    seenFolders.add(fId);
                }
            });

            // ★ 3. 폴더 헤더/미분류 헤더를 DOM에서 제거 (툴바는 유지)
            //    SortableJS가 보는 자식 요소 = 프롬프트 행만 남음 = 실리태번 순정과 동일!
            const removedHeaders = [];
            list.querySelectorAll('.pf-injected:not(.pf-toolbar)').forEach(el => {
                removedHeaders.push(el);
                el.remove();
            });

            // ★ 4. 접혀있던(숨겨져있던) 프롬프트를 일시적으로 표시
            list.querySelectorAll('[data-pf-folder]').forEach(el => {
                if (el.style.display === 'none') {
                    el.style.display = '';
                    el.setAttribute('data-pf-was-hidden', '1');
                }
            });

            console.log('[PF] 드래그 시작: 폴더 헤더 제거 + ' + seenFolders.size + '개 폴더 라벨 표시');

            const restore = () => {
                document.removeEventListener('pointerup', restore);
                document.removeEventListener('pointercancel', restore);
                // SortableJS가 DOM 조작을 마칠 때까지 100ms 대기 후 복원
                setTimeout(() => {
                    if (observerTarget && observer) {
                        observer.observe(observerTarget, { childList: true, subtree: true });
                    }
                    // 드래그 완료 후 전체 UI 재구성 (폴더 헤더 복원 포함)
                    wasDragging = true;
                    needsSTSync = true;
                    rebuildFolderUI();
                    console.log('[PF] 드래그 종료: UI 복원 완료');
                }, 100);
            };

            document.addEventListener('pointerup', restore, { once: true });
            document.addEventListener('pointercancel', restore, { once: true });

            // 안전장치: 10초 후 강제 복원
            setTimeout(() => {
                if (observerTarget && observer) {
                    try { observer.observe(observerTarget, { childList: true, subtree: true }); } catch (e) { }
                }
            }, 10000);
        }, { passive: true });

        console.log('[PF] ✅ 드래그 최적화 설정 완료');
    }

    /* ─── MutationObserver 관찰자 ─── */
    function setupObserver() {
        const target = document.getElementById('completion_prompt_manager') || document.querySelector('.completion_prompt_manager');
        if (!target) return;
        if (observer) observer.disconnect();
        observer = new MutationObserver((mutations) => {
            if (searchHasFocus) return;
            const list = getListContainer();
            if (!list) return;

            // ST의 SortableJS가 드래그 중(고스트 엘리먼트 존재)이라면 즉시 종료!
            if (list.querySelector('.sortable-chosen, .sortable-ghost, .sortable-drag')) {
                wasDragging = true;
                return;
            }

            // [Mousedown Freeze 핵심 원인 해결]: 
            // SortableJS는 마우스를 누르자마자 `.sortable-chosen` 클래스를 부여하기 직전에 
            // 드래그 대상 요소의 `style`, `class`, `draggable` 속성 등을 연속으로 변경합니다.
            // 이때 발생하는 수십 번의 mutation마다 100+개의 프롬프트를 스캔하여 Hash를 만들면 
            // 브라우저 메인 스레드가 완전히 잠기며 3초 이상의 프리징이 발생합니다.
            // 따라서, 실제 자식 노드(프롬프트 DOM Element)의 추가/삭제가 아닌
            // '단순 속성 변경(attributes)'만 발생한 mutation은 프롬프트 개수 해시 스캔을 전부 건너뜁니다!
            let hasChildListChange = false;
            for (const m of mutations) {
                if (m.type === 'childList') {
                    hasChildListChange = true;
                    break;
                }
            }

            // 프롬프트가 실제로 추가/제거된 것이 아니라, SortableJS가 마우스를 누를 때 발생시킨 
            // 클래스/스타일 변경 이벤트라면 무시합니다. (Mousedown 딜레이 0초 달성)
            if (!hasChildListChange && !wasDragging) {
                return;
            }

            if (!isRebuilding) {
                // ST가 새로운 프롬프트를 추가/삭제하여 실제 구조가 변경되었는지 확인
                // 이 무거운 O(N) 작업은 이제 '실제 프롬프트 추가/삭제' 시에만 실행됩니다.
                const currentHash = Array.from(list.querySelectorAll('[data-pm-identifier]'))
                    .map(r => r.getAttribute('data-pm-identifier'))
                    .filter(Boolean).join('|');

                // 해시가 같으면 (우리가 DOM을 조작해서 발생한 이벤트면) 무시
                if (list._pfHash === currentHash) {
                    wasDragging = false;
                    return;
                }

                // 드래그가 방금 막 끝난 상황이라 해시가 변경된 경우 -> ST 내부 데이터도 동기화해줘야 함
                if (wasDragging) {
                    console.log('[PF] 드래그 완료 감지. 프롬프트 순서 동기화 플래그 활성화');
                    needsSTSync = true;
                    wasDragging = false;
                }

                rebuildFolderUI();
            }
        });
        observer.observe(target, { childList: true, subtree: true });
    }

    /* ─── 슬래시 명령어 (Slash Commands) ─── */
    function registerSlashCommands() {
        try {
            const context = ctx();
            if (!context) return;

            // SillyTavern 객체에서 SlashCommandParser 접근도 시도
            const SlashCommandParser = (window.SillyTavern && window.SillyTavern.getContext().SlashCommandParser) || null;
            const registerSlashCommand = context.registerSlashCommand || (SlashCommandParser ? SlashCommandParser.addCommandObject.bind(SlashCommandParser) : null);

            // 일반적인 슬래시 명령어 등록을 위한 접근 방식
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

    /* ─── 초기화 (Init) ─── */
    function init() {
        console.log('[Prompt Folders] loaded');
        setupPresetChangeListener();
        hookSaveButton();
        registerSlashCommands();
        const trySetup = () => {
            const list = getListContainer();
            if (list) {
                checkPresetChange(); // 초기 로드 진입점
                setupObserver();
                rebuildFolderUI();
                // [드래그 렉 해결] SortableJS 패치 및 드래그 최적화 설정
                // ST가 SortableJS를 아직 초기화하지 않았을 수 있으므로 지연 호출
                setTimeout(() => {
                    const l = getListContainer();
                    if (l) {
                        patchSortable(l);
                        setupDragOptimization(l);
                    }
                }, 500);
                // 2차 시도: ST가 늦게 SortableJS를 초기화하는 경우 대비
                setTimeout(() => {
                    const l = getListContainer();
                    if (l && !l._pfSortablePatched) {
                        patchSortable(l);
                    }
                }, 3000);
            }
            else setTimeout(trySetup, 1000);
        };
        trySetup();
    }

    if (typeof jQuery !== 'undefined') jQuery(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();

