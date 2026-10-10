(function () {
  'use strict';

  const SYSTEM_FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif';
  const FONT_STACKS = {
    system: SYSTEM_FONT,
    yahei: '"Microsoft YaHei", "Microsoft YaHei UI", "Segoe UI", sans-serif',
    segoe: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
  };
  const TEXT_SCALES = { small: 0.9, normal: 1, large: 1.15 };

  function create(options = {}) {
    const loadedFonts = new Map();
    const fontRequests = new Map();
    const reportedFonts = new Set();
    let desiredFontKey = '';
    let fontGeneration = 0;
    let disposed = false;

    function useFont(family) {
      document.documentElement.style.setProperty('--app-font', family);
    }

    async function decodeFont(font, bytes) {
      if (!font?.id || !bytes?.byteLength) throw new Error('没有读到字体内容。');
      if (loadedFonts.has(font.id)) return loadedFonts.get(font.id);
      const family = `BuddyLocal_${font.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const face = new FontFace(family, source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
      try { await face.load(); }
      catch { throw new Error('这个字体无法读取，请换一个 TTF、OTF、WOFF 或 WOFF2 文件。'); }
      if (disposed) throw new Error('窗口已关闭。');
      document.fonts.add(face);
      const decoded = { family: `"${family}", ${SYSTEM_FONT}`, face };
      loadedFonts.set(font.id, decoded);
      return decoded;
    }

    function requestFont(font) {
      if (loadedFonts.has(font.id)) return Promise.resolve(loadedFonts.get(font.id));
      if (!fontRequests.has(font.id)) {
        const work = Promise.resolve().then(async () => {
          const result = await window.buddy.getActiveFont();
          if (!result?.ok || result.font?.id !== font.id || !result.bytes?.byteLength) {
            throw new Error('已导入的字体暂时无法读取，已使用系统字体。可重新导入字体恢复。');
          }
          return decodeFont(result.font, result.bytes);
        });
        fontRequests.set(font.id, work);
        work.catch(() => {
          if (fontRequests.get(font.id) === work) fontRequests.delete(font.id);
        });
      }
      return fontRequests.get(font.id);
    }

    function apply(state) {
      if (disposed || !state) return;
      const settings = state.settings || {};
      const root = document.documentElement;
      root.dataset.fontFamily = settings.fontFamily || 'system';
      const theme = state.app?.resolvedTheme === 'dark' ? 'dark' : 'light';
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      root.dataset.textSize = Object.hasOwn(TEXT_SCALES, settings.textSize) ? settings.textSize : 'normal';
      root.style.setProperty('--text-scale', String(TEXT_SCALES[root.dataset.textSize]));
      const imported = settings.fontFamily === 'custom' ? settings.importedFont : null;
      // Successful re-imports can repair a missing copy in the other window too.
      const nextKey = imported?.id ? `custom:${imported.id}:${state.app?.fontRevision || 0}` : settings.fontFamily || 'system';
      if (nextKey === desiredFontKey) return;
      desiredFontKey = nextKey;
      const generation = ++fontGeneration;
      useFont(FONT_STACKS[settings.fontFamily] || SYSTEM_FONT);
      root.dataset.fontStatus = imported ? 'loading' : 'ready';
      if (!imported) {
        root.dataset.fontStatus = settings.fontFamily === 'custom' ? 'fallback' : 'ready';
        return;
      }
      requestFont(imported).then(decoded => {
        if (disposed || generation !== fontGeneration || desiredFontKey !== nextKey) return;
        useFont(decoded.family);
        root.dataset.fontStatus = 'ready';
        options.onFontStatus?.('ready', imported);
      }).catch(error => {
        if (disposed || generation !== fontGeneration || desiredFontKey !== nextKey) return;
        useFont(SYSTEM_FONT);
        root.dataset.fontStatus = 'fallback';
        options.onFontStatus?.('fallback', imported);
        if (!reportedFonts.has(imported.id)) {
          reportedFonts.add(imported.id);
          options.onNotice?.(error.message || '字体无法读取，已使用系统字体。');
        }
      });
    }

    async function previewFont(font, bytes) {
      const decoded = await decodeFont(font, bytes);
      // A freshly imported candidate also repairs a failed cached read of this asset.
      fontRequests.delete(font.id);
      reportedFonts.delete(font.id);
      desiredFontKey = '';
      return decoded.family;
    }

    function destroy() {
      disposed = true;
      fontGeneration += 1;
      for (const { face } of loadedFonts.values()) document.fonts.delete(face);
      loadedFonts.clear();
      fontRequests.clear();
    }

    return Object.freeze({ apply, previewFont, destroy });
  }

  window.BuddyAppearance = Object.freeze({ create });
})();
