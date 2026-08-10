/**
 * Opens an OminiNote deep link in the installed app when possible.
 *
 * Public URLs look like:
 *   https://omininote.com/import?id=…
 *   https://omininote.com/collab?folderId=…&nbId=…
 *   https://omininote.com/link/n/…
 *
 * The custom-scheme fallback (omninote://…) is what the OS already registers.
 * Android App Links can skip the browser once assetlinks.json is verified.
 */
(function () {
  var ORIGIN = 'https://omininote.com';
  var CUSTOM = 'omninote';

  function pathKindAndRest() {
    var path = (location.pathname || '/').replace(/\/+/g, '/');
    // Strip trailing slash except root
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    var segs = path.split('/').filter(Boolean);
    // Support /import/index.html style paths hosted under a folder
    if (segs.length && segs[segs.length - 1] === 'index.html') segs.pop();
    if (!segs.length) return { kind: null, rest: '' };
    return { kind: segs[0], rest: segs.slice(1).join('/') };
  }

  function buildCustomScheme(kind, rest, search) {
    if (!kind) return null;
    if (kind === 'link') {
      return rest
        ? CUSTOM + '://link/' + rest + (search || '')
        : CUSTOM + '://link' + (search || '');
    }
    return CUSTOM + '://' + kind + (search || '');
  }

  function isDeepLinkKind(kind) {
    return (
      kind === 'import' ||
      kind === 'collab' ||
      kind === 'link'
    );
  }

  function tryOpenApp(customUrl) {
    // Attempt to hand off to the app. Browsers vary; a short delay then show UI.
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = customUrl;
    document.body.appendChild(iframe);
    setTimeout(function () {
      try {
        document.body.removeChild(iframe);
      } catch (_) {}
    }, 1500);

    // Also try top-level navigation (works better on some mobile browsers).
    setTimeout(function () {
      window.location.href = customUrl;
    }, 50);
  }

  function setOpenButton(customUrl) {
    var btn = document.getElementById('open-app');
    if (btn) {
      btn.href = customUrl;
      btn.style.display = 'inline-block';
    }
    var code = document.getElementById('link-preview');
    if (code) code.textContent = customUrl.replace(CUSTOM + '://', ORIGIN + '/');
  }

  function run() {
    var parts = pathKindAndRest();
    var kind = parts.kind;
    var rest = parts.rest;
    var search = location.search || '';

    if (!isDeepLinkKind(kind)) {
      // Not a deep-link path — leave marketing page alone.
      return;
    }

    var custom = buildCustomScheme(kind, rest, search);
    if (!custom) return;

    document.documentElement.classList.add('deeplink-page');
    var title = document.getElementById('dl-title');
    var desc = document.getElementById('dl-desc');
    if (title) {
      title.textContent =
        kind === 'import'
          ? 'Open shared note'
          : kind === 'collab'
            ? 'Open collaboration invite'
            : 'Open in OminiNote';
    }
    if (desc) {
      desc.textContent =
        'If OminiNote is installed, it should open automatically. ' +
        'Otherwise install the app, then tap Open again.';
    }
    setOpenButton(custom);
    tryOpenApp(custom);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();

