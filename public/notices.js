// SoundTracks — app-level notices.
//
// Two slots inside #app-notices:
//   status  ONE banner at a time about connectivity or Spotify availability.
//           When several apply, only the highest-priority one is shown
//           (see STATUS_PRIORITY). Card-level errors never get their own
//           banner; they defer to this one.
//   update  "A new version is ready" with Update / Later.
//
// The banners are static text; screen-reader announcements go through the
// single sr-only polite region (#a11y-status) via announce(), so a change is
// spoken exactly once and nothing here is a live region that could chatter.
(function () {
  const STATUS_PRIORITY = ['offline', 'rate-limit', 'reconnected'];
  const ICONS = {
    offline: '<line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path><path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line>',
    warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    update: '<polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>'
  };

  const statuses = new Map(); // id → config
  let host = null;
  let updateConfig = null;
  const statusTimers = new Map(); // id → auto-hide timeout
  let lastOutsideFocus = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const span = el('span', 'notice-icon');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  function button(label, className, onClick) {
    const btn = el('button', className, label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Sends a message to screen readers through the shared polite region.
  // Clearing first (then setting on the next frame) makes back-to-back
  // identical messages both get announced.
  function announce(message) {
    const region = document.getElementById('a11y-status');
    if (!region) return;
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = message; });
  }

  function getHost() {
    return host || document.getElementById('app-notices');
  }

  // The dashboard and the sign-in card are different screens; the notices
  // follow whichever is showing.
  function mountIn(target) {
    const container = document.getElementById('app-notices');
    if (container && target && container.parentNode !== target) {
      const position = target.dataset.noticesPosition;
      if (position === 'end') target.appendChild(container);
      else target.insertBefore(container, target.firstChild);
    }
    host = container;
  }

  // Removing a focused button would drop focus to <body>, stranding keyboard
  // users at the top of the page; put it back where they were working.
  function restoreFocusIfLost(hadFocus) {
    if (!hadFocus) return;
    const target = lastOutsideFocus && document.contains(lastOutsideFocus) ? lastOutsideFocus : document.querySelector('main');
    if (!target) return;
    if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  function render() {
    const container = getHost();
    if (!container) return;

    const hadFocus = container.contains(document.activeElement);
    container.replaceChildren();

    const activeId = STATUS_PRIORITY.find((id) => statuses.has(id));
    if (activeId) container.appendChild(buildStatus(activeId, statuses.get(activeId)));
    if (updateConfig) container.appendChild(buildUpdate(updateConfig));

    container.classList.toggle('hidden', container.childElementCount === 0);
    restoreFocusIfLost(hadFocus && !container.contains(document.activeElement));
  }

  function buildStatus(id, config) {
    const node = el('div', `notice notice-${config.tone}`);
    node.dataset.status = id;
    node.appendChild(icon(config.icon));

    const text = el('p', 'notice-text');
    text.append(el('strong', 'notice-label', config.label), ' ', config.text);
    node.appendChild(text);

    const actions = el('div', 'notice-actions');
    if (config.action) {
      actions.appendChild(button(config.action.label, 'btn btn-secondary btn-sm', config.action.onClick));
    }
    if (config.dismissible) {
      const dismiss = button('×', 'notice-dismiss', () => clearStatus(id));
      dismiss.setAttribute('aria-label', `Dismiss: ${config.label}`);
      actions.appendChild(dismiss);
    }
    if (actions.childElementCount) node.appendChild(actions);
    return node;
  }

  // config: { tone: 'warn'|'ok', icon, label, text, action?: {label, onClick},
  //           dismissible?, autoHideMs? }
  function showStatus(id, config) {
    statuses.set(id, config);
    clearTimeout(statusTimers.get(id));
    statusTimers.delete(id);
    if (config.autoHideMs) statusTimers.set(id, setTimeout(() => clearStatus(id), config.autoHideMs));
    render();
  }

  function clearStatus(id) {
    clearTimeout(statusTimers.get(id));
    statusTimers.delete(id);
    if (!statuses.delete(id)) return;
    render();
  }

  function hasStatus(id) {
    return statuses.has(id);
  }

  function hasBlockingStatus() {
    return statuses.has('offline') || statuses.has('rate-limit');
  }

  function clearAllStatuses() {
    statuses.clear();
    statusTimers.forEach((timer) => clearTimeout(timer));
    statusTimers.clear();
    render();
  }

  function buildUpdate(config) {
    const node = el('div', 'notice notice-update');
    node.dataset.status = 'update';
    node.appendChild(icon('update'));

    const text = el('p', 'notice-text');
    text.append(el('strong', 'notice-label', 'Update available'), ' ', config.busy ? 'Updating…' : 'A new version of SoundTracks is ready.');
    node.appendChild(text);

    const actions = el('div', 'notice-actions');
    const update = button('Update', 'btn btn-primary btn-sm', config.onUpdate);
    update.disabled = Boolean(config.busy);
    update.setAttribute('aria-label', 'Update SoundTracks to the new version');
    actions.appendChild(update);
    const later = button('Later', 'btn btn-secondary btn-sm', config.onLater);
    later.disabled = Boolean(config.busy);
    later.setAttribute('aria-label', 'Dismiss update notification');
    actions.appendChild(later);
    node.appendChild(actions);
    return node;
  }

  // config: { onUpdate, onLater, busy? }
  function showUpdate(config) {
    updateConfig = config;
    render();
  }

  function hideUpdate() {
    if (!updateConfig) return;
    updateConfig = null;
    render();
  }

  // Remember the last element focused outside the notices, to restore focus
  // to when a notice with focus is dismissed.
  document.addEventListener('focusin', (event) => {
    const container = document.getElementById('app-notices');
    if (container && !container.contains(event.target)) lastOutsideFocus = event.target;
  });

  window.SoundTracksNotices = {
    announce, mountIn, showStatus, clearStatus, hasStatus, hasBlockingStatus, clearAllStatuses, showUpdate, hideUpdate
  };
})();
