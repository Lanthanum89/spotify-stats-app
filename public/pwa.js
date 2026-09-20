// SoundTracks — PWA install and service-worker update experience.
//
// INSTALL
//   • `beforeinstallprompt` is captured (and the browser's own prompt
//     suppressed) but nothing is shown until the user presses an "Install app"
//     button. The buttons exist only while the app really is installable:
//     never when already installed/standalone, never on browsers that don't
//     fire the event. Nothing pops up unprompted, so there is nothing to nag.
//   • iOS Safari has no install event, so there it gets a small
//     "Add to Home Screen" hint, and only where that can be detected reliably.
//
// UPDATES
//   • A new service worker installs in the background and WAITS. The user is
//     told once ("Update available") and chooses Update or Later.
//   • Update messages the waiting worker to activate; the page reloads exactly
//     once, and only because the user asked for it.
//   • The very first install (no controlling worker yet) shows nothing.
(function () {
  const UPDATE_CHECK_MIN_INTERVAL_MS = 15 * 60 * 1000;
  const UPDATE_APPLY_TIMEOUT_MS = 10 * 1000;

  const notices = window.SoundTracksNotices;

  // ---- Install -----------------------------------------------------------

  const standaloneQuery = window.matchMedia('(display-mode: standalone)');
  let deferredInstallPrompt = null;
  let installDismissedThisSession = false;

  function isStandalone() {
    return standaloneQuery.matches || window.navigator.standalone === true;
  }

  // Safari on iOS/iPadOS only. Other iOS browsers and in-app browsers have
  // different (or no) Add-to-Home-Screen flows, so they get no guidance
  // rather than wrong guidance.
  function isIosSafari() {
    const ua = navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram|Line\//.test(ua);
    return isIos && /Safari/.test(ua) && !isOtherBrowser;
  }

  function installButtons() {
    return document.querySelectorAll('.js-install-btn');
  }

  function iosHints() {
    return document.querySelectorAll('.js-install-ios-hint');
  }

  function updateInstallUi() {
    const canPrompt = deferredInstallPrompt !== null;
    const showIosHint = !canPrompt && isIosSafari();
    const visible = !isStandalone() && !installDismissedThisSession && (canPrompt || showIosHint);

    installButtons().forEach((btn) => {
      btn.classList.toggle('hidden', !visible);
      // Only the iOS button is a disclosure; the prompt button just acts.
      if (!showIosHint) {
        btn.removeAttribute('aria-expanded');
        btn.removeAttribute('aria-controls');
      } else {
        btn.setAttribute('aria-controls', btn.dataset.hint);
        if (!btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
      }
    });
    if (!visible || !showIosHint) iosHints().forEach((hint) => hint.classList.add('hidden'));
  }

  async function handleInstallClick(event) {
    const btn = event.currentTarget;

    if (!deferredInstallPrompt) {
      // iOS Safari: toggle the instructions.
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      installButtons().forEach((b) => b.setAttribute('aria-expanded', String(!expanded)));
      iosHints().forEach((hint) => hint.classList.toggle('hidden', expanded));
      return;
    }

    // A captured prompt can only be used once, whatever the user answers.
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'dismissed') installDismissedThisSession = true;
    updateInstallUi();
  }

  function initInstall() {
    installButtons().forEach((btn) => btn.addEventListener('click', handleInstallClick));

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      updateInstallUi();
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      updateInstallUi();
      notices.announce('SoundTracks was installed.');
    });

    standaloneQuery.addEventListener('change', updateInstallUi);
    updateInstallUi();
  }

  // ---- Service worker updates -------------------------------------------

  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    let updateRequested = false;
    let reloading = false;
    let lastUpdateCheck = Date.now();
    let registration = null;

    // Only a worker the user explicitly told to take over may reload the page.
    // (The first-ever install also fires controllerchange, via clients.claim(),
    // and another tab applying an update does too — neither should reload us.)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!updateRequested || reloading) return;
      reloading = true;
      window.location.reload();
    });

    function offerUpdate(worker) {
      notices.showUpdate({
        onUpdate: () => applyUpdate(worker),
        onLater: () => notices.hideUpdate()
      });
      notices.announce('An update to SoundTracks is available.');
    }

    function applyUpdate(worker) {
      const target = (registration && registration.waiting) || worker;
      updateRequested = true;
      notices.showUpdate({ busy: true });
      target.postMessage({ type: 'SKIP_WAITING' });

      // If the worker never takes over, give the buttons back rather than
      // leaving "Updating…" on screen forever.
      setTimeout(() => {
        if (reloading) return;
        updateRequested = false;
        offerUpdate(worker);
      }, UPDATE_APPLY_TIMEOUT_MS);
    }

    function checkForUpdate(force) {
      if (!registration) return;
      const now = Date.now();
      if (!force && now - lastUpdateCheck < UPDATE_CHECK_MIN_INTERVAL_MS) return;
      lastUpdateCheck = now;
      registration.update().catch(() => {
        // Offline or the server is unreachable — try again next time.
      });
    }

    async function register() {
      try {
        // Relative, so it resolves beneath the GitHub Pages project subpath.
        registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
      } catch (err) {
        console.error('Service worker registration failed:', err.name);
        return;
      }

      // A worker left waiting by an earlier visit (user chose Later).
      if (registration.waiting && navigator.serviceWorker.controller) {
        offerUpdate(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // No controller means this is the first install, not an update.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            offerUpdate(installing);
          }
        });
      });

      // Browsers throttle their own update checks (as rarely as once a day),
      // so check on load and when the app returns to the foreground — but no
      // more often than every 15 minutes.
      checkForUpdate(true);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkForUpdate(false);
      });
    }

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }

  initInstall();
  initServiceWorker();
})();
