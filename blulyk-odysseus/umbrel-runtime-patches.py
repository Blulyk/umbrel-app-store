from pathlib import Path


def replace_once(path: str, needle: str, replacement: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if replacement in text:
        return
    if needle not in text:
        raise SystemExit(f"Patch target not found in {path}")
    target.write_text(text.replace(needle, replacement, 1), encoding="utf-8")


def replace_if_found(path: str, needle: str, replacement: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if replacement in text or needle not in text:
        return
    target.write_text(text.replace(needle, replacement, 1), encoding="utf-8")


replace_once(
    "core/middleware.py",
    """        is_report = path.startswith("/api/research/report/")
""",
    """        is_report = path.startswith("/api/research/report/")
        # Document-library PDF previews are embedded in same-origin iframes.
        is_pdf_render = path.startswith("/api/document/") and path.endswith("/render-pdf")
""",
)

replace_once(
    "core/middleware.py",
    """            pass
        else:
""",
    """            pass
        elif is_pdf_render:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "object-src 'none'; "
                "frame-ancestors 'self'"
            )
        else:
""",
)

replace_once(
    "core/middleware.py",
    "img-src 'self' data: blob:; ",
    "img-src 'self' data: blob: https: http:; ",
)

replace_once(
    "static/app.js",
    "const UI_VIS_DEFAULT_OFF = new Set(['models-section', 'rag-toggle-btn']);",
    "const UI_VIS_DEFAULT_OFF = new Set(['models-section', 'rag-toggle-btn', 'text-emojis']);",
)

replace_once(
    "static/app.js",
    "    applyTextEmojis(state['text-emojis'] !== false);",
    "    applyTextEmojis(state['text-emojis'] === true);",
)

replace_once(
    "static/js/emailLibrary/utils.js",
    """  const isDangerousUrl = (val) => {
    if (!val) return false;
    const v = val.trim().toLowerCase();
    return v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:');
  };
""",
    """  const isDangerousUrl = (val, attrName, tagName) => {
    if (!val) return false;
    const v = val.trim().toLowerCase();
    if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return true;
    if (v.startsWith('data:')) {
      return !(tagName === 'IMG' && attrName === 'src' && /^data:image\\/(png|gif|jpe?g|webp|svg\\+xml);/i.test(v));
    }
    return false;
  };
""",
)

replace_once(
    "static/js/emailLibrary/utils.js",
    """      if (URL_ATTRS.includes(name) && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
        continue;
      }
""",
    """      if (URL_ATTRS.includes(name) && isDangerousUrl(attr.value, name, el.tagName)) {
        el.removeAttribute(attr.name);
        continue;
      }
""",
)

replace_once(
    "static/js/emailLibrary/utils.js",
    """    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
""",
    """    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
      el.style.maxWidth = '100%';
      el.style.height = 'auto';
    }
""",
)

replace_once(
    "src/upload_handler.py",
    "        self.max_upload_size = 10 * 1024 * 1024  # 10MB",
    "        self.max_upload_size = int(os.environ.get(\"ODYSSEUS_MAX_UPLOAD_MB\", \"100\")) * 1024 * 1024",
)

replace_once(
    "src/document_processor.py",
    """        reader = PdfReader(path)

        for page_num, page in enumerate(reader.pages):
""",
    """        reader = PdfReader(path)
        max_pages = int(os.environ.get("PDF_PROCESS_MAX_PAGES", "30") or "30")
        pages = list(reader.pages)
        selected_pages = pages[:max_pages] if max_pages > 0 else pages
        vision_enabled = os.environ.get("PDF_PROCESS_ENABLE_VISION", "false").lower() == "true"

        for page_num, page in enumerate(selected_pages):
""",
)

replace_once(
    "src/document_processor.py",
    """            if images and len(page_text) < 50:
""",
    """            if vision_enabled and images and len(page_text) < 50:
""",
)

replace_once(
    "src/document_processor.py",
    """        if pdf_text:
            if len(pdf_text) > 15000:
""",
    """        if len(pages) > len(selected_pages):
            pdf_text += f"\\n\\n[PDF extraction limited to first {len(selected_pages)} of {len(pages)} pages]"

        if pdf_text:
            if len(pdf_text) > 15000:
""",
)

replace_once(
    "routes/document_routes.py",
    '            body_text = _process_pdf(pdf_path).lstrip("\\n[PDF content]:").strip()',
    '            body_text = _process_pdf(pdf_path).removeprefix("\\n\\n[PDF content]:").strip()',
)

replace_once(
    "routes/document_routes.py",
    '                body_text = _process_pdf(pdf_path).lstrip("\\n[PDF content]:").strip()',
    '                body_text = _process_pdf(pdf_path).removeprefix("\\n\\n[PDF content]:").strip()',
)

replace_once(
    "static/js/document.js",
    """      img.src = `${API_BASE}/api/document/${docId}/page/${page.page}.png`;
      img.style.cssText = 'display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none;pointer-events:none;';
""",
    """      img.src = `${API_BASE}/api/document/${docId}/page/${page.page}.png`;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.style.cssText = 'display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none;pointer-events:none;';
""",
)

replace_once(
    "static/js/documentLibrary.js",
    """        body: JSON.stringify({
          session_id: sessionId,
          // Preserve the source's type; default to markdown when unknown
""",
    """        body: JSON.stringify({
          session_id: sessionId,
          title: baseTitle,
          // Preserve the source's type; default to markdown when unknown
""",
)

replace_once(
    "static/js/document.js",
    """    // Hide version panel on switch
    const vp = document.getElementById('doc-version-panel');
""",
    """    // PDF-backed docs share a single rendered pane in the editor shell.
    // Rebind that pane whenever the active tab changes so cloned PDFs can sit
    // side-by-side as separate tabs instead of showing a stale viewer.
    if (isPdf) {
      const explicitPdfState = _pdfViewState.get(docId);
      if (explicitPdfState !== false) {
        _setPdfViewActive(true);
        if (langSelect) langSelect.value = 'pdf';
      }
    } else {
      const pdfPane = document.getElementById('doc-pdf-view');
      const editorWrap = document.getElementById('doc-editor-wrap');
      if (pdfPane) {
        const savedPill = document.getElementById('doc-pdf-save-pill');
        pdfPane.style.display = 'none';
        pdfPane.innerHTML = '';
        if (savedPill) pdfPane.appendChild(savedPill);
      }
      if (editorWrap) editorWrap.style.display = '';
      document.getElementById('doc-pdf-view-btn')?.classList.remove('active');
    }

    // Hide version panel on switch
    const vp = document.getElementById('doc-version-panel');
""",
)

replace_once(
    "static/js/document.js",
    """    activeDocId = docId;
    clearSelection();
    const doc = docs.get(docId);
""",
    """    if (_pdfPaneSaveTimer) {
      clearTimeout(_pdfPaneSaveTimer);
      _savePdfPaneToMarkdown();
    }

    activeDocId = docId;
    clearSelection();
    const doc = docs.get(docId);
""",
)

replace_once(
    "static/js/document.js",
    """        dragId = tab.dataset.docId;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
""",
    """        dragId = tab.dataset.docId;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        const doc = docs.get(dragId);
        const payload = JSON.stringify({ id: dragId, title: doc?.title || 'Document' });
        e.dataTransfer.setData('application/x-odysseus-document', payload);
        e.dataTransfer.setData('text/plain', doc?.title || 'Document');
      });
""",
)

replace_if_found(
    "static/js/chat.js",
    """      const readDraggedDoc = (e) => {
        const raw = e.dataTransfer?.getData('application/x-odysseus-document');
""",
    """      const hasDraggedDoc = (e) =>
        Array.from(e.dataTransfer?.types || []).includes('application/x-odysseus-document');
      const readDraggedDoc = (e) => {
        const raw = e.dataTransfer?.getData('application/x-odysseus-document');
""",
)

replace_if_found(
    "static/js/chat.js",
    """      document.addEventListener('dragover', (e) => {
        if (!readDraggedDoc(e)) return;
""",
    """      document.addEventListener('dragover', (e) => {
        if (!hasDraggedDoc(e)) return;
""",
)

replace_once(
    "static/js/chat.js",
    """  export function initListeners() {
    // Global event delegation for copy-code buttons
""",
    """  export function initListeners() {
    if (!window.__odysseus_doc_drop_bound) {
      window.__odysseus_doc_drop_bound = true;
      const docDropTargets = () => [
        document.getElementById('message'),
        document.getElementById('chat-bar'),
        document.getElementById('chat-history'),
      ].filter(Boolean);
      const hasDraggedDoc = (e) =>
        Array.from(e.dataTransfer?.types || []).includes('application/x-odysseus-document');
      const readDraggedDoc = (e) => {
        const raw = e.dataTransfer?.getData('application/x-odysseus-document');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
      };
      document.addEventListener('dragover', (e) => {
        if (!hasDraggedDoc(e)) return;
        if (!docDropTargets().some(t => t === e.target || t.contains(e.target))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
      });
      document.addEventListener('drop', async (e) => {
        const draggedDoc = readDraggedDoc(e);
        if (!draggedDoc?.id) return;
        if (!docDropTargets().some(t => t === e.target || t.contains(e.target))) return;
        e.preventDefault();
        try {
          if (documentModule.openPanel) documentModule.openPanel();
          if (documentModule.loadDocument) await documentModule.loadDocument(draggedDoc.id);
          if (uiModule?.showToast) uiModule.showToast(`Document attached: ${draggedDoc.title || 'Document'}`);
        } catch (err) {
          console.error('Failed to attach dragged document:', err);
          if (uiModule?.showError) uiModule.showError('Could not attach document to chat');
        }
      });
    }

    // Global event delegation for copy-code buttons
""",
)

replace_once(
    "static/js/document.js",
    """      wrap.addEventListener('mouseenter', () => _setHandlesVisible(true));
      wrap.addEventListener('mouseleave', () => _setHandlesVisible(false));
""",
    """      wrap.addEventListener('mouseenter', () => _setHandlesVisible(true));
      wrap.addEventListener('mouseleave', () => {
        setTimeout(() => {
          const overFloatingControl =
            wrap.matches(':hover') ||
            del.matches(':hover') ||
            grip.matches(':hover') ||
            resize.matches(':hover') ||
            (menuBtn && menuBtn.matches(':hover'));
          if (!overFloatingControl) _setHandlesVisible(false);
        }, 180);
      });
""",
)

replace_once(
    "static/js/documentLibrary.js",
    """        if (doc.session_id) items.push({ label: 'Open', action: () => libraryOpenInSession(doc) });
        items.push({ label: 'Clone', action: () => libraryImportDocument(doc) });
""",
    """        items.push({ label: 'Open', action: () => libraryOpenDocument(doc) });
        items.push({ label: 'Clone', action: () => libraryImportDocument(doc) });
""",
)

replace_once(
    "static/js/documentLibrary.js",
    """    if (doc.session_id) {
      openItem.addEventListener('click', (e) => { e.stopPropagation(); dropdown.style.display = 'none'; libraryOpenInSession(doc); });
    } else {
      openItem.disabled = true;
      openItem.style.opacity = '0.35';
      openItem.title = 'Not linked to a session';
    }
""",
    """    openItem.title = doc.session_id ? 'Open in original session' : 'Open in current workspace';
    openItem.addEventListener('click', (e) => { e.stopPropagation(); dropdown.style.display = 'none'; libraryOpenDocument(doc); });
""",
)

replace_once(
    "static/js/documentLibrary.js",
    """    if (doc.session_id) {
      openBtn.title = 'Open in original session';
      openBtn.addEventListener('click', (e) => { e.stopPropagation(); libraryOpenInSession(doc); });
    } else {
      openBtn.disabled = true;
      openBtn.style.opacity = '0.35';
      openBtn.style.cursor = 'not-allowed';
      openBtn.title = 'This document is not linked to a session';
    }
""",
    """    openBtn.title = doc.session_id ? 'Open in original session' : 'Open in current workspace';
    openBtn.addEventListener('click', (e) => { e.stopPropagation(); libraryOpenDocument(doc); });
""",
)

replace_once(
    "static/js/documentLibrary.js",
    """        const files = fileInput.files;
        fileInput.value = '';
""",
    """        const files = Array.from(fileInput.files || []);
        fileInput.value = '';
""",
)

replace_once(
    "src/llm_core.py",
    "import httpx\nimport asyncio\n",
    "import httpx\nimport asyncio\nimport os\n",
)

replace_once(
    "src/llm_core.py",
    """class LLMConfig:
    """ + '"""' + """Configuration constants for LLM operations.""" + '"""' + """
    DEFAULT_TIMEOUT = 30
    DEFAULT_TEMPERATURE = 1.0
    DEFAULT_MAX_TOKENS = 0
    MAX_RETRIES = 3
    RETRY_DELAY = 0.5
    STREAM_TIMEOUT = 300
""",
    """def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


class LLMConfig:
    """ + '"""' + """Configuration constants for LLM operations.""" + '"""' + """
    DEFAULT_TIMEOUT = _env_int("LLM_DEFAULT_TIMEOUT", 60)
    DEFAULT_TEMPERATURE = 1.0
    DEFAULT_MAX_TOKENS = 0
    MAX_RETRIES = 3
    RETRY_DELAY = 0.5
    STREAM_TIMEOUT = _env_int("LLM_STREAM_TIMEOUT", 900)
""",
)

replace_once(
    "src/llm_core.py",
    """def _provider_label(url: str) -> str:
    """ + '"""' + """Human-friendly provider name for error messages.""" + '"""' + """
""",
    """def _provider_label(url: str) -> str:
    """ + '"""' + """Human-friendly provider name for error messages.""" + '"""' + """
""",
)

replace_once(
    "src/llm_core.py",
    """    except Exception:
        return "provider"


def _format_upstream_error(status: int, body: bytes | str, url: str) -> str:
""",
    """    except Exception:
        return "provider"


def _effective_llm_timeout(url: str, timeout: int | float | None) -> int:
    base = int(timeout or LLMConfig.DEFAULT_TIMEOUT)
    label = _provider_label(url).lower()
    if "ollama" in label or "local endpoint" in label or ":11434" in (url or ""):
        return max(base, _env_int("LLM_LOCAL_TIMEOUT", 180))
    return max(base, _env_int("LLM_DEFAULT_TIMEOUT", base))


def _format_upstream_error(status: int, body: bytes | str, url: str) -> str:
""",
)

replace_once(
    "src/llm_core.py",
    """        note_model_activity(target_url, model)
        r = httpx.post(target_url, headers=h, json=payload, timeout=timeout)
""",
    """        note_model_activity(target_url, model)
        r = httpx.post(target_url, headers=h, json=payload, timeout=_effective_llm_timeout(target_url, timeout))
""",
)

replace_once(
    "src/llm_core.py",
    """    call_timeout = httpx.Timeout(connect=3.0, read=float(timeout), write=10.0, pool=5.0)
""",
    """    effective_timeout = _effective_llm_timeout(target_url, timeout)
    call_timeout = httpx.Timeout(connect=3.0, read=float(effective_timeout), write=10.0, pool=5.0)
""",
)

replace_once(
    "src/settings.py",
    "import logging\nfrom typing import Any\n",
    "import logging\nimport os\nfrom typing import Any\n",
)

replace_once(
    "src/settings.py",
    '''    "agent_max_tool_calls": 0,
    "agent_input_token_budget": 6000,
    "agent_stream_timeout_seconds": 300,
''',
    '''    "agent_max_tool_calls": int(os.environ.get("AGENT_MAX_TOOL_CALLS", "0")),
    "agent_input_token_budget": int(os.environ.get("AGENT_INPUT_TOKEN_BUDGET", "12000")),
    "agent_stream_timeout_seconds": int(os.environ.get("AGENT_STREAM_TIMEOUT_SECONDS", "900")),
''',
)
