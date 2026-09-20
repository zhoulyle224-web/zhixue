(function (global) {
  'use strict';

  let activeResolve = null;
  let returnFocus = null;

  function ensureDialog() {
    let shell = document.querySelector('#zhixueDialog');
    if (shell) return shell;
    shell = document.createElement('div');
    shell.id = 'zhixueDialog';
    shell.className = 'zhixue-dialog-shell';
    shell.hidden = true;
    shell.innerHTML = `
      <section class="zhixue-dialog-card" role="dialog" aria-modal="true" aria-labelledby="zhixueDialogTitle" aria-describedby="zhixueDialogMessage">
        <button type="button" class="zhixue-dialog-close" aria-label="关闭">×</button>
        <span class="eyebrow">操作确认</span>
        <h2 id="zhixueDialogTitle"></h2>
        <p id="zhixueDialogMessage"></p>
        <div id="zhixueDialogDetails" class="zhixue-dialog-details"></div>
        <label id="zhixueDialogInputWrap" hidden><span id="zhixueDialogInputLabel"></span><textarea id="zhixueDialogInput" maxlength="200"></textarea><small id="zhixueDialogError" role="alert"></small></label>
        <div class="zhixue-dialog-actions">
          <button type="button" class="btn" data-dialog-cancel>取消</button>
          <button type="button" class="btn primary" data-dialog-accept>确认</button>
        </div>
      </section>`;
    document.body.appendChild(shell);
    shell.querySelector('.zhixue-dialog-close').addEventListener('click', () => finish(null));
    shell.querySelector('[data-dialog-cancel]').addEventListener('click', () => finish(null));
    shell.querySelector('[data-dialog-accept]').addEventListener('click', accept);
    shell.addEventListener('click', (event) => { if (event.target === shell) finish(null); });
    shell.addEventListener('keydown', trapKeys);
    return shell;
  }

  function finish(value) {
    const shell = ensureDialog();
    shell.hidden = true;
    const resolve = activeResolve;
    activeResolve = null;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
    resolve?.(value);
  }

  function accept() {
    const shell = ensureDialog();
    const wrap = shell.querySelector('#zhixueDialogInputWrap');
    if (!wrap.hidden) {
      const input = shell.querySelector('#zhixueDialogInput');
      const value = input.value.trim();
      if (!value) {
        shell.querySelector('#zhixueDialogError').textContent = '请填写原因后再继续。';
        input.focus();
        return;
      }
      finish(value);
      return;
    }
    finish(true);
  }

  function trapKeys(event) {
    const shell = ensureDialog();
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...shell.querySelectorAll('button:not([disabled]), textarea:not([disabled])')].filter((node) => !node.hidden);
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function show(options, withInput) {
    if (activeResolve) finish(null);
    const shell = ensureDialog();
    returnFocus = document.activeElement;
    shell.querySelector('#zhixueDialogTitle').textContent = options.title || '请确认操作';
    shell.querySelector('#zhixueDialogMessage').textContent = options.message || '';
    const details = shell.querySelector('#zhixueDialogDetails');
    details.innerHTML = '';
    for (const item of options.details || []) {
      const row = document.createElement('div');
      const label = document.createElement('span');
      const value = document.createElement('b');
      label.textContent = item.label;
      value.textContent = item.value;
      row.append(label, value);
      details.appendChild(row);
    }
    const wrap = shell.querySelector('#zhixueDialogInputWrap');
    wrap.hidden = !withInput;
    const input = shell.querySelector('#zhixueDialogInput');
    input.value = options.initialValue || '';
    input.placeholder = options.placeholder || '';
    shell.querySelector('#zhixueDialogInputLabel').textContent = options.inputLabel || '操作原因';
    shell.querySelector('#zhixueDialogError').textContent = '';
    const acceptButton = shell.querySelector('[data-dialog-accept]');
    acceptButton.textContent = options.acceptLabel || '确认';
    acceptButton.classList.toggle('danger', options.tone === 'danger');
    shell.hidden = false;
    requestAnimationFrame(() => (withInput ? input : acceptButton).focus());
    return new Promise((resolve) => { activeResolve = resolve; });
  }

  global.ZhixueDialog = {
    ask: (options) => show(options || {}, false).then(Boolean),
    input: (options) => show(options || {}, true),
  };
})(window);
