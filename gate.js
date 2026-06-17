/**
 * flo-gate.js
 * PIN gate for TaskFlo / TravelFlo / AthleteFlo
 *
 * To change the PIN:
 *   1. Pick a new 6-digit code
 *   2. Run in your browser console:
 *        crypto.subtle.digest('SHA-256', new TextEncoder().encode('flo2026' + 'NEWPIN'))
 *          .then(b => console.log(Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')))
 *   3. Replace EXPECTED_HASH below with the output
 */
(function () {
  'use strict';

  const GATE_KEY      = 'flo_gate_v1';
  const EXPIRY_DAYS   = 30;
  const SALT          = 'flo2026';
  const EXPECTED_HASH = '90344f60e63ec98566c194796ff07f9bdb6fae2815c341c355827b331a99b4b6';

  // ─── Auth helpers ──────────────────────────────────────────────────────────

  function isAuthed() {
    try {
      const s = JSON.parse(localStorage.getItem(GATE_KEY) || '{}');
      return !!s.token && Date.now() < s.expires;
    } catch (e) { return false; }
  }

  function setAuthed() {
    const expires = Date.now() + EXPIRY_DAYS * 86400 * 1000;
    localStorage.setItem(GATE_KEY, JSON.stringify({ token: '1', expires }));
    document.cookie =
      `flo_gate=1; max-age=${EXPIRY_DAYS * 86400}; path=/; SameSite=Strict`;
  }

  async function sha256(str) {
    const buf = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(str)
    );
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ─── Already authenticated — show page and exit ───────────────────────────

  if (isAuthed()) {
    document.documentElement.style.visibility = '';
    return;
  }

  // ─── Styles ────────────────────────────────────────────────────────────────

  const CSS = `
    #flo-gate {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: #080a10;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, 'Inter', BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
      visibility: visible !important;
      opacity: 1;
      transition: opacity 0.45s cubic-bezier(0.4, 0, 0.2, 1);
      -webkit-tap-highlight-color: transparent;
    }
    #flo-gate.exit {
      opacity: 0;
      pointer-events: none;
    }
    #flo-gate-icon {
      width: 40px;
      height: 40px;
      margin-bottom: 48px;
      opacity: 0.35;
    }
    #flo-gate-boxes {
      display: flex;
      gap: 10px;
      transition: transform 0.05s ease;
    }
    #flo-gate-boxes.shake {
      animation: flo-shake 0.42s ease;
    }
    @keyframes flo-shake {
      0%, 100% { transform: translateX(0); }
      14%       { transform: translateX(-7px); }
      28%       { transform: translateX(7px); }
      42%       { transform: translateX(-5px); }
      57%       { transform: translateX(5px); }
      71%       { transform: translateX(-3px); }
      85%       { transform: translateX(3px); }
    }
    .flo-gate-box {
      width: 48px;
      height: 60px;
      background: #10141d;
      border: 1.5px solid #1e2535;
      border-radius: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      font-weight: 600;
      color: #e2e8f0;
      letter-spacing: -0.01em;
      transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
      cursor: text;
      user-select: none;
    }
    .flo-gate-box.active {
      border-color: #6366f1;
      background: #151a28;
      box-shadow: 0 0 0 3px rgba(99,102,241,0.12);
    }
    .flo-gate-box.filled {
      border-color: #2d3550;
      background: #12161f;
    }
    .flo-gate-box.error {
      border-color: #ef4444 !important;
      background: #1a0e0e !important;
      color: #ef4444;
    }
    .flo-gate-box.success {
      border-color: #22c55e !important;
      background: #0d1a10 !important;
      color: #22c55e;
    }
    #flo-gate-hint {
      margin-top: 28px;
      font-size: 11.5px;
      color: #ef4444;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-weight: 500;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    #flo-gate-hint.visible {
      opacity: 0.75;
    }
    #flo-gate-tap {
      margin-top: 48px;
      font-size: 11px;
      color: #2a3040;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      display: none;
    }
    @media (hover: none) {
      #flo-gate-tap { display: block; }
    }
  `;

  const LOCK_SVG = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="11" width="18" height="12" rx="2.5" stroke="#6366f1" stroke-width="1.6"/>
      <path d="M7 11V7.5a5 5 0 0 1 10 0V11" stroke="#6366f1" stroke-width="1.6"
        stroke-linecap="round"/>
      <circle cx="12" cy="17" r="1.4" fill="#6366f1" opacity="0.7"/>
    </svg>
  `;

  // ─── Mount gate UI ─────────────────────────────────────────────────────────

  function mountGate() {
    // Inject styles
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Build DOM
    const gate  = document.createElement('div');
    gate.id     = 'flo-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-label', 'Enter access code');

    const icon  = document.createElement('div');
    icon.id     = 'flo-gate-icon';
    icon.innerHTML = LOCK_SVG;

    const boxes = document.createElement('div');
    boxes.id    = 'flo-gate-boxes';
    boxes.setAttribute('aria-label', '6-digit access code');

    const hint  = document.createElement('div');
    hint.id     = 'flo-gate-hint';
    hint.setAttribute('aria-live', 'polite');
    hint.textContent = 'Incorrect code';

    const tap   = document.createElement('div');
    tap.id      = 'flo-gate-tap';
    tap.textContent = 'Tap to enter code';

    for (let i = 0; i < 6; i++) {
      const box       = document.createElement('div');
      box.className   = 'flo-gate-box';
      box.dataset.idx = i;
      boxes.appendChild(box);
    }

    // Hidden numeric input (captures keystrokes / mobile keyboard)
    const input       = document.createElement('input');
    input.type        = 'tel';
    input.inputMode   = 'numeric';
    input.pattern     = '[0-9]*';
    input.maxLength   = 6;
    input.autocomplete = 'off';
    input.style.cssText =
      'position:fixed;left:-9999px;top:50%;width:1px;height:1px;opacity:0;font-size:16px;';

    gate.appendChild(icon);
    gate.appendChild(boxes);
    gate.appendChild(hint);
    gate.appendChild(tap);
    gate.appendChild(input);
    document.body.appendChild(gate);

    const boxEls = Array.from(boxes.querySelectorAll('.flo-gate-box'));
    let digits   = [];
    let pending  = false;

    function render() {
      boxEls.forEach((box, i) => {
        box.className  = 'flo-gate-box';
        box.textContent = digits[i] !== undefined ? digits[i] : '';
        if (i === digits.length && !pending) box.classList.add('active');
        else if (i < digits.length)          box.classList.add('filled');
      });
    }

    function doError() {
      pending = true;
      boxEls.forEach(b => b.className = 'flo-gate-box error');
      hint.classList.add('visible');
      boxes.classList.add('shake');
      boxes.addEventListener('animationend', () => {
        boxes.classList.remove('shake');
        setTimeout(() => {
          hint.classList.remove('visible');
          digits  = [];
          input.value = '';
          pending = false;
          render();
          input.focus();
        }, 80);
      }, { once: true });
    }

    function doSuccess() {
      pending = true;
      boxEls.forEach(b => b.className = 'flo-gate-box success');
      setTimeout(() => {
        setAuthed();
        gate.classList.add('exit');
        gate.addEventListener('transitionend', () => {
          gate.remove();
          document.documentElement.style.visibility = '';
        }, { once: true });
      }, 350);
    }

    async function verify() {
      if (pending) return;
      pending = true;
      const pin  = digits.join('');
      const hash = await sha256(SALT + pin);
      if (hash === EXPECTED_HASH) {
        doSuccess();
      } else {
        doError();
      }
    }

    input.addEventListener('input', () => {
      if (pending) return;
      const val = input.value.replace(/\D/g, '').slice(0, 6);
      input.value = val;
      digits      = val.split('').filter(Boolean);
      render();
      if (digits.length === 6) verify();
    });

    input.addEventListener('keydown', (e) => {
      if (pending) return;
      if (e.key === 'Backspace') {
        if (digits.length > 0) {
          digits.pop();
          input.value = digits.join('');
          render();
        }
        e.preventDefault();
      }
    });

    // Any click/tap on the gate focuses the input
    gate.addEventListener('click', (e) => {
      e.stopPropagation();
      input.focus();
      tap.style.display = 'none';
    });

    // Update tap hint visibility
    gate.addEventListener('focusin', () => {
      tap.style.display = 'none';
    });

    render();

    // Focus on load (desktop) — mobile requires user gesture
    requestAnimationFrame(() => {
      input.focus();
      // If focus didn't work (mobile), show the tap hint
      setTimeout(() => {
        if (document.activeElement !== input) {
          tap.style.display = 'block';
        }
      }, 300);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountGate);
  } else {
    mountGate();
  }

})();
