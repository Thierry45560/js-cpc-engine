/**
 * @file        VirtualJoystick.js
 * @description Touch virtual joystick for tablets — analog D-pad on the left,
 *              action buttons on the right. Simulates the CPC joystick key events.
 *              Includes the Wake Lock API to keep the screen awake.
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — Amstrad in your browser
 */

'use strict';

/* ---------------------------------------------------------------------------
   WAKE LOCK — keeps the screen awake during play
   --------------------------------------------------------------------------- */
var WakeLockManager = (function () {
    var _wakeLock   = null;
    var _enabled    = false;

    async function acquire() {
        if (!('wakeLock' in navigator)) {
            console.warn('[WakeLock] API not supported in this browser.');
            return;
        }
        try {
            _wakeLock = await navigator.wakeLock.request('screen');
            _enabled  = true;
            console.info('[WakeLock] ✔ Screen sleep disabled.');
            _wakeLock.addEventListener('release', function () {
                _enabled = false;
                console.info('[WakeLock] Lock released.');
            });
        } catch (err) {
            console.warn('[WakeLock] Failure:', err.message);
        }
    }

    async function release() {
        if (_wakeLock) {
            await _wakeLock.release();
            _wakeLock = null;
            _enabled  = false;
        }
    }

    /* Re-acquire automatically when the page returns to the foreground */
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && _enabled === false && _wakeLock === null) {
            /* Only re-acquire when the joystick was active */
            if (VirtualJoystick && VirtualJoystick.isVisible()) acquire();
        }
    });

    return { acquire: acquire, release: release, isEnabled: function () { return _enabled; } };
}());


/* ---------------------------------------------------------------------------
   VIRTUAL JOYSTICK
   --------------------------------------------------------------------------- */
var VirtualJoystick = (function () {

    /* -- CPC joystick key mappings -----------------------------------------
       Default: arrow keys + space (Fire 1) + left ctrl (Fire 2).
       Configurable via VirtualJoystick.setKeyMap({...}).
       ----------------------------------------------------------------------- */
    var keyMap = {
        up    : 'ArrowUp',
        down  : 'ArrowDown',
        left  : 'ArrowLeft',
        right : 'ArrowRight',
        fireA : ' ',          // Space   -> Fire 1 / button A
        fireB : 'Control',    // Ctrl    -> Fire 2 / button B
        start : 'F1'          // F1      -> Pause / Start
    };

    /* -- Current direction state --------------------------------------------- */
    var _state = { up: false, down: false, left: false, right: false };
    var _held  = {};          // Keys currently held down

    /* -- DOM refs ------------------------------------------------------------ */
    var _container = null;
    var _knob      = null;
    var _padBase   = null;
    var _visible   = false;

    /* -- Dead zone & pad radius ---------------------------------------------- */
    var PAD_RADIUS  = 55;    // px — stick travel radius
    var DEAD_ZONE   = 0.18;  // fraction of the radius ignored at the centre

    /* -----------------------------------------------------------------------
       KEYBOARD EVENT SIMULATION
       ----------------------------------------------------------------------- */
    function _fireKey(key, type) {
        var target = document.getElementById('screen') || document.body;
        var event  = new KeyboardEvent(type, {
            key      : key,
            code     : _keyToCode(key),
            keyCode  : _keyToKeyCode(key),
            which    : _keyToKeyCode(key),
            bubbles  : true,
            cancelable: true
        });
        target.dispatchEvent(event);
        /* Fall back to document when the canvas does not catch the event */
        document.dispatchEvent(event);
    }

    function _press(key) {
        if (_held[key]) return;
        _held[key] = true;
        _fireKey(key, 'keydown');
    }

    function _release(key) {
        if (!_held[key]) return;
        _held[key] = false;
        _fireKey(key, 'keyup');
    }

    function _keyToCode(key) {
        var map = {
            'ArrowUp'   : 'ArrowUp',
            'ArrowDown' : 'ArrowDown',
            'ArrowLeft' : 'ArrowLeft',
            'ArrowRight': 'ArrowRight',
            ' '         : 'Space',
            'Control'   : 'ControlLeft',
            'F1'        : 'F1'
        };
        return map[key] || 'Key' + key.toUpperCase();
    }

    function _keyToKeyCode(key) {
        var map = {
            'ArrowUp'   : 38,
            'ArrowDown' : 40,
            'ArrowLeft' : 37,
            'ArrowRight': 39,
            ' '         : 32,
            'Control'   : 17,
            'F1'        : 112
        };
        return map[key] || key.charCodeAt(0);
    }

    /* -----------------------------------------------------------------------
       D-PAD LOGIC — direction computed from the touch position
       ----------------------------------------------------------------------- */
    function _updateDpad(dx, dy) {
        var dist   = Math.sqrt(dx * dx + dy * dy);
        var norm   = dist / PAD_RADIUS;

        /* Inside the dead zone -> release everything */
        if (norm < DEAD_ZONE) {
            _releaseAll();
            _moveKnob(0, 0);
            return;
        }

        /* Clamp the visual knob displacement */
        var capDist = Math.min(dist, PAD_RADIUS);
        var ratio   = capDist / dist;
        _moveKnob(dx * ratio, dy * ratio);

        /* Angle for the 8 directions */
        var angle = Math.atan2(dy, dx) * (180 / Math.PI); // -180 to +180

        var newState = { up: false, down: false, left: false, right: false };

        if      (angle > -112.5 && angle <= -67.5) { newState.up    = true; }
        else if (angle >  67.5  && angle <= 112.5) { newState.down  = true; }
        else if (angle > 157.5  || angle <= -157.5){ newState.left  = true; }
        else if (angle > -22.5  && angle <=  22.5) { newState.right = true; }
        /* Diagonals */
        else if (angle > -157.5 && angle <= -112.5){ newState.up   = true; newState.left  = true; }
        else if (angle >  -67.5 && angle <=  -22.5){ newState.up   = true; newState.right = true; }
        else if (angle >   22.5 && angle <=   67.5){ newState.down = true; newState.right = true; }
        else if (angle >  112.5 && angle <=  157.5){ newState.down = true; newState.left  = true; }

        /* Apply the state changes */
        _applyDpadState(newState);
        _highlightDpad(newState);
    }

    function _applyDpadState(newState) {
        var dirs = ['up','down','left','right'];
        dirs.forEach(function (d) {
            if (newState[d] && !_state[d]) _press(keyMap[d]);
            if (!newState[d] && _state[d]) _release(keyMap[d]);
            _state[d] = newState[d];
        });
    }

    function _releaseAll() {
        var dirs = ['up','down','left','right'];
        dirs.forEach(function (d) {
            if (_state[d]) { _release(keyMap[d]); _state[d] = false; }
        });
        _highlightDpad({ up:false, down:false, left:false, right:false });
    }

    function _releaseAllButtons() {
        Object.keys(_held).forEach(function (k) {
            if (_held[k]) { _release(k); }
        });
        _held = {};
        Object.keys(_state).forEach(function (k) { _state[k] = false; });
    }

    function _moveKnob(x, y) {
        if (!_knob) return;
        _knob.style.transform = 'translate(calc(-50% + ' + x + 'px), calc(-50% + ' + y + 'px))';
    }

    function _highlightDpad(s) {
        if (!_padBase) return;
        ['up','down','left','right'].forEach(function (d) {
            var el = _padBase.querySelector('[data-dir="' + d + '"]');
            if (el) el.classList.toggle('active', !!s[d]);
        });
    }

    /* -----------------------------------------------------------------------
       CONSTRUCTION DU DOM
       ----------------------------------------------------------------------- */
    function _build() {
        /* -- Main container ------------------------------------------------- */
        _container = document.createElement('div');
        _container.id = 'vjoy-container';
        _container.innerHTML = [
            /* -- D-PAD (left) --------------------------------------------- */
            '<div id="vjoy-pad-wrap">',
            '  <div id="vjoy-pad-base">',
            '    <div class="vjoy-dpad-arm vjoy-arm-up"    data-dir="up">',
            '      <svg viewBox="0 0 24 24"><path d="M12 5l-7 9h14z"/></svg>',
            '    </div>',
            '    <div class="vjoy-dpad-arm vjoy-arm-down"  data-dir="down">',
            '      <svg viewBox="0 0 24 24"><path d="M12 19l7-9H5z"/></svg>',
            '    </div>',
            '    <div class="vjoy-dpad-arm vjoy-arm-left"  data-dir="left">',
            '      <svg viewBox="0 0 24 24"><path d="M5 12l9-7v14z"/></svg>',
            '    </div>',
            '    <div class="vjoy-dpad-arm vjoy-arm-right" data-dir="right">',
            '      <svg viewBox="0 0 24 24"><path d="M19 12l-9 7V5z"/></svg>',
            '    </div>',
            '    <div id="vjoy-knob"></div>',
            '  </div>',
            '</div>',

            /* -- Action buttons (right) ----------------------------------- */
            '<div id="vjoy-buttons-wrap">',
            '  <div id="vjoy-start-group">',
            '    <button class="vjoy-mini-btn" data-action="start" title="Pause / F1">',
            '      <i class="fas fa-pause"></i>',
            '    </button>',
            '  </div>',
            '  <div id="vjoy-action-group">',
            '    <button class="vjoy-btn vjoy-btn-b" data-action="fireB" title="Fire 2 / Ctrl">B</button>',
            '    <button class="vjoy-btn vjoy-btn-a" data-action="fireA" title="Fire 1 / Espace">A</button>',
            '  </div>',
            '</div>'
        ].join('');

        document.body.appendChild(_container);

        _padBase = document.getElementById('vjoy-pad-base');
        _knob    = document.getElementById('vjoy-knob');

        _bindTouchPad();
        _bindButtons();
    }

    /* -- D-pad touch handling ------------------------------------------------ */
    function _bindTouchPad() {
        var touchId  = null;
        var originX  = 0;
        var originY  = 0;

        function _getCenter() {
            var r = _padBase.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }

        _padBase.addEventListener('touchstart', function (e) {
            e.preventDefault();
            if (touchId !== null) return;
            var t   = e.changedTouches[0];
            touchId = t.identifier;
            var c   = _getCenter();
            originX = c.x;
            originY = c.y;
            _updateDpad(t.clientX - originX, t.clientY - originY);
        }, { passive: false });

        _padBase.addEventListener('touchmove', function (e) {
            e.preventDefault();
            for (var i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === touchId) {
                    var t = e.changedTouches[i];
                    _updateDpad(t.clientX - originX, t.clientY - originY);
                    break;
                }
            }
        }, { passive: false });

        function _onEnd(e) {
            for (var i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === touchId) {
                    touchId = null;
                    _releaseAll();
                    _moveKnob(0, 0);
                    break;
                }
            }
        }

        _padBase.addEventListener('touchend',    _onEnd, { passive: false });
        _padBase.addEventListener('touchcancel', _onEnd, { passive: false });
    }

    /* -- Touch handling for the A / B / Start buttons ------------------------ */
    function _bindButtons() {
        var btns = _container.querySelectorAll('[data-action]');
        btns.forEach(function (btn) {
            var action = btn.getAttribute('data-action');
            var key    = keyMap[action];
            if (!key) return;

            btn.addEventListener('touchstart', function (e) {
                e.preventDefault();
                btn.classList.add('pressed');
                _press(key);
            }, { passive: false });

            function _onBtnEnd(e) {
                e.preventDefault();
                btn.classList.remove('pressed');
                _release(key);
            }

            btn.addEventListener('touchend',    _onBtnEnd, { passive: false });
            btn.addEventListener('touchcancel', _onBtnEnd, { passive: false });
        });
    }

    /* -----------------------------------------------------------------------
       DYNAMICALLY INJECTED CSS
       ----------------------------------------------------------------------- */
    function _injectCSS() {
        var style = document.createElement('style');
        style.id  = 'vjoy-styles';
        style.textContent = [
            /* -- General layout ------------------------------------------- */
            '#vjoy-container {',
            '  display: none;',               /* Hidden by default -> shown on touch */
            '  position: fixed;',
            '  bottom: 0; left: 0; right: 0;',
            '  height: 180px;',
            '  z-index: 8000;',
            '  pointer-events: none;',
            '  user-select: none;',
            '  -webkit-user-select: none;',
            '  padding: 12px 16px;',
            '  box-sizing: border-box;',
            '  align-items: flex-end;',
            '  justify-content: space-between;',
            '  background: linear-gradient(to top,',
            '    rgba(0,0,0,0.75) 0%,',
            '    rgba(0,0,0,0.30) 70%,',
            '    transparent 100%);',
            '  backdrop-filter: none;',
            '}',

            /* Active on touch devices only */
            '@media (pointer: coarse) {',
            '  #vjoy-container { display: flex; }',
            '}',

            /* -- D-Pad wrap ------------------------------------------------ */
            '#vjoy-pad-wrap {',
            '  pointer-events: auto;',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: center;',
            '}',

            '#vjoy-pad-base {',
            '  position: relative;',
            '  width: 140px;',
            '  height: 140px;',
            '  border-radius: 50%;',
            '  background: rgba(255,255,255,0.08);',
            '  border: 2px solid rgba(255,255,255,0.18);',
            '  touch-action: none;',
            '  box-shadow: 0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);',
            '}',

            /* -- Knob (stick central) -------------------------------------- */
            '#vjoy-knob {',
            '  position: absolute;',
            '  top: 50%; left: 50%;',
            '  transform: translate(-50%, -50%);',
            '  width: 52px; height: 52px;',
            '  border-radius: 50%;',
            '  background: radial-gradient(circle at 35% 35%,',
            '    rgba(255,255,255,0.35) 0%,',
            '    rgba(255,255,255,0.08) 60%,',
            '    rgba(0,0,0,0.3) 100%);',
            '  border: 2px solid rgba(255,255,255,0.3);',
            '  box-shadow: 0 2px 12px rgba(0,0,0,0.6);',
            '  transition: transform 0.04s linear;',
            '  pointer-events: none;',
            '}',

            /* -- D-Pad arrows ---------------------------------------------- */
            '.vjoy-dpad-arm {',
            '  position: absolute;',
            '  width: 36px; height: 36px;',
            '  display: flex; align-items: center; justify-content: center;',
            '  border-radius: 6px;',
            '  transition: background 0.06s ease, opacity 0.06s ease;',
            '  opacity: 0.5;',
            '}',
            '.vjoy-dpad-arm svg {',
            '  width: 22px; height: 22px;',
            '  fill: rgba(255,255,255,0.85);',
            '}',
            '.vjoy-dpad-arm.active {',
            '  background: rgba(137, 180, 250, 0.35);',
            '  opacity: 1;',
            '}',
            '.vjoy-arm-up    { top: 2px;  left: 50%; transform: translateX(-50%); }',
            '.vjoy-arm-down  { bottom: 2px; left: 50%; transform: translateX(-50%); }',
            '.vjoy-arm-left  { left: 2px; top: 50%;  transform: translateY(-50%); }',
            '.vjoy-arm-right { right: 2px; top: 50%; transform: translateY(-50%); }',

            /* -- Buttons (right) -------------------------------------------- */
            '#vjoy-buttons-wrap {',
            '  pointer-events: auto;',
            '  display: flex;',
            '  flex-direction: column;',
            '  align-items: flex-end;',
            '  justify-content: flex-end;',
            '  gap: 8px;',
            '}',

            '#vjoy-start-group {',
            '  display: flex;',
            '  justify-content: flex-end;',
            '}',

            '#vjoy-action-group {',
            '  display: flex;',
            '  gap: 14px;',
            '  align-items: center;',
            '}',

            /* Main buttons */
            '.vjoy-btn {',
            '  width: 56px; height: 56px;',
            '  border-radius: 50%;',
            '  border: 2px solid rgba(255,255,255,0.25);',
            '  font-family: "Share Tech Mono", monospace;',
            '  font-size: 1rem; font-weight: 700;',
            '  letter-spacing: 0.04em;',
            '  cursor: pointer;',
            '  touch-action: manipulation;',
            '  display: flex; align-items: center; justify-content: center;',
            '  box-shadow: 0 4px 16px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15);',
            '  transition: transform 0.06s ease, box-shadow 0.06s ease, filter 0.06s ease;',
            '  -webkit-tap-highlight-color: transparent;',
            '}',

            '.vjoy-btn-a {',
            '  background: radial-gradient(circle at 35% 35%,',
            '    rgba(166,227,161,0.9),',
            '    rgba(64,160,60,0.8));',
            '  color: rgba(0,40,0,0.9);',
            '}',
            '.vjoy-btn-b {',
            '  background: radial-gradient(circle at 35% 35%,',
            '    rgba(243,188,114,0.9),',
            '    rgba(200,120,20,0.8));',
            '  color: rgba(40,20,0,0.9);',
            '}',

            '.vjoy-btn.pressed {',
            '  transform: scale(0.88);',
            '  box-shadow: 0 1px 6px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);',
            '  filter: brightness(1.3);',
            '}',

            /* Start mini button */
            '.vjoy-mini-btn {',
            '  width: 36px; height: 36px;',
            '  border-radius: 18px;',
            '  border: 1px solid rgba(255,255,255,0.2);',
            '  background: rgba(255,255,255,0.1);',
            '  color: rgba(255,255,255,0.7);',
            '  font-size: 0.75rem;',
            '  cursor: pointer;',
            '  touch-action: manipulation;',
            '  display: flex; align-items: center; justify-content: center;',
            '  transition: background 0.1s, transform 0.06s;',
            '  -webkit-tap-highlight-color: transparent;',
            '}',
            '.vjoy-mini-btn.pressed {',
            '  transform: scale(0.88);',
            '  background: rgba(137,180,250,0.35);',
            '}',

            /* -- Tablet adaptations for the header ------------------------- */
            '@media (pointer: coarse) and (max-width: 1024px) {',

            '  /* Extra space at the bottom for the virtual joystick */',
            '  .game-area {',
            '    padding-bottom: 185px !important;',
            '  }',

            '  /* Centred canvas, shrunk so the buttons stay visible */',
            '  #emulator-area canvas {',
            '    max-width: 100% !important;',
            '    max-height: calc(100vh - 185px - 48px) !important;',
            '    width: auto !important;',
            '    height: auto !important;',
            '    object-fit: contain;',
            '  }',

            '  /* Compact header on tablets */',
            '  .game-header {',
            '    height: 44px !important;',
            '    padding: 0 8px !important;',
            '    flex-wrap: nowrap;',
            '    overflow: hidden;',
            '  }',

            '  /* Hide some header elements on small touch screens */',
            '  .volume-wrap,',
            '  #btn-filter,',
            '  #btn-quicksave,',
            '  #btn-quickload {',
            '    display: none !important;',
            '  }',

            '  /* More compact logo */',
            '  .game-header h1 {',
            '    font-size: 0.9rem !important;',
            '  }',

            '  /* Status pill compact */',
            '  #status-pill {',
            '    font-size: 0.7rem !important;',
            '    padding: 2px 8px !important;',
            '  }',
            '}'
        ].join('\n');

        document.head.appendChild(style);
    }

    /* -----------------------------------------------------------------------
       PUBLIC API
       ----------------------------------------------------------------------- */

    /**
     * Initialises the virtual joystick (injects CSS + DOM).
     * Call once from document.ready.
     */
    function init() {
        if (_container) return; // Already initialised
        _injectCSS();
        _build();

        /* Wake Lock as soon as a touch is detected */
        document.addEventListener('touchstart', function onFirstTouch() {
            WakeLockManager.acquire();
            document.removeEventListener('touchstart', onFirstTouch);
        }, { once: true });

        /* Release every key when the window loses focus */
        window.addEventListener('blur', function () {
            _releaseAllButtons();
        });

        _visible = true;
        console.info('[VirtualJoystick] ✔ Initialised.');
    }

    /** Returns true when the joystick is visible (= active) */
    function isVisible() {
        return _visible;
    }

    /**
     * Lets the caller customise the mapped keys.
     * @param {Object} map e.g. { fireA: ' ', fireB: 'z', up: 'ArrowUp', ... }
     */
    function setKeyMap(map) {
        Object.assign(keyMap, map);
    }

    /**
     * Shows or hides the virtual joystick manually.
     * @param {boolean} show
     */
    function setVisible(show) {
        _visible = !!show;
        if (_container) {
            _container.style.display = show ? 'flex' : 'none';
        }
        if (show) WakeLockManager.acquire();
        else      WakeLockManager.release();
    }

    return {
        init      : init,
        isVisible : isVisible,
        setKeyMap : setKeyMap,
        setVisible: setVisible
    };

}()); /* end VirtualJoystick */
