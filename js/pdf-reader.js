let pdfjsPromise = null;

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.mjs')
      .then(function (pdfjs) {
        if (pdfjs && pdfjs.GlobalWorkerOptions) {
          pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
        }
        return pdfjs;
      })
      .catch(function () { return null; });
  }
  return pdfjsPromise;
}

export function createPdfReader(options) {
  const canvas = options.canvas;
  const container = options.container;
  const fallbackFrame = options.fallbackFrame;
  const onState = typeof options.onState === 'function' ? options.onState : function () {};
  const ctx = canvas.getContext('2d');

  let doc = null;
  let blobUrl = null;
  let pageNumber = 1;
  let zoom = 1;
  let renderTask = null;

  function state(extra) {
    onState(Object.assign({
      ready: !!doc,
      page: pageNumber,
      pages: doc ? doc.numPages : 0,
      zoom: zoom,
      fallback: !doc && !!blobUrl
    }, extra || {}));
  }

  function releaseUrl() {
    if (!blobUrl) return;
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }

  function clearCanvas() {
    const w = Math.max(1, canvas.clientWidth || 1);
    const h = Math.max(1, canvas.clientHeight || 1);
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
  }

  async function renderPage() {
    if (!doc) return;
    if (renderTask && renderTask.cancel) {
      try { renderTask.cancel(); } catch (_) {}
    }

    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const available = Math.max(240, (container.clientWidth || 320) - 24);
    const fit = Math.min(2.5, available / Math.max(1, base.width));
    const cssScale = fit * zoom;
    const viewport = page.getViewport({ scale: cssScale });
    const ratio = Math.min(3, window.devicePixelRatio || 1);

    canvas.width = Math.max(1, Math.round(viewport.width * ratio));
    canvas.height = Math.max(1, Math.round(viewport.height * ratio));
    canvas.style.width = Math.round(viewport.width) + 'px';
    canvas.style.height = Math.round(viewport.height) + 'px';

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    renderTask = page.render({
      canvasContext: ctx,
      viewport: viewport,
      transform: null
    });
    await renderTask.promise;
    renderTask = null;
    state({ rendering: false });
  }

  async function open(blob) {
    await close();
    state({ loading: true, error: null });

    const pdfjs = await loadPdfJs();
    if (!pdfjs) {
      blobUrl = URL.createObjectURL(blob);
      canvas.classList.add('hidden');
      fallbackFrame.classList.remove('hidden');
      fallbackFrame.src = blobUrl;
      state({ loading: false, fallback: true, error: null });
      return;
    }

    fallbackFrame.classList.add('hidden');
    fallbackFrame.removeAttribute('src');
    canvas.classList.remove('hidden');

    try {
      const data = new Uint8Array(await blob.arrayBuffer());
      const loadingTask = pdfjs.getDocument({
        data: data,
        useWorkerFetch: false,
        isEvalSupported: false
      });
      doc = await loadingTask.promise;
      pageNumber = 1;
      zoom = 1;
      state({ loading: false, pages: doc.numPages, page: 1, zoom: 1, fallback: false });
      await renderPage();
    } catch (error) {
      doc = null;
      clearCanvas();
      state({ loading: false, error: error && error.message ? error.message : String(error) });
      throw error;
    }
  }

  async function setPage(next) {
    if (!doc) return;
    pageNumber = Math.max(1, Math.min(doc.numPages, next));
    state({ rendering: true });
    await renderPage();
  }

  async function setZoom(next) {
    if (!doc) return;
    zoom = Math.max(0.6, Math.min(3, next));
    state({ rendering: true });
    await renderPage();
  }

  async function close() {
    if (renderTask && renderTask.cancel) {
      try { renderTask.cancel(); } catch (_) {}
    }
    renderTask = null;
    if (doc && doc.destroy) {
      try { await doc.destroy(); } catch (_) {}
    }
    doc = null;
    releaseUrl();
    fallbackFrame.removeAttribute('src');
    fallbackFrame.classList.add('hidden');
    canvas.classList.remove('hidden');
    canvas.removeAttribute('style');
    clearCanvas();
    pageNumber = 1;
    zoom = 1;
    state({ ready: false, page: 1, pages: 0, zoom: 1, fallback: false });
  }

  return {
    open: open,
    close: close,
    next: function () { return setPage(pageNumber + 1); },
    previous: function () { return setPage(pageNumber - 1); },
    zoomIn: function () { return setZoom(zoom * 1.2); },
    zoomOut: function () { return setZoom(zoom / 1.2); },
    rerender: function () { return renderPage(); },
    getState: function () {
      return { ready: !!doc, page: pageNumber, pages: doc ? doc.numPages : 0, zoom: zoom, fallback: !doc && !!blobUrl };
    }
  };
}
