/*
 * BOB chat button for dryerventsquadaz.com.
 * Add before </body>:
 *   <script src="https://katdaddy-bookingbot.vercel.app/widget.js" defer></script>
 * Any link or button with data-bob-open (or href="#book-with-bob") also opens BOB.
 */
(function () {
  if (window.DVSBob) return;

  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : 'https://katdaddy-bookingbot.vercel.app';
  var NAVY = '#083653';
  var ORANGE = '#f27c20';

  var css =
    '.dvs-bob-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:10px;' +
    'padding:8px 18px 8px 8px;border:0;border-radius:999px;background:' + ORANGE + ';color:' + NAVY + ';cursor:pointer;' +
    'font:700 15px/1.2 Montserrat,system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 12px 30px -10px rgba(3,22,36,.6)}' +
    '.dvs-bob-launch img{width:40px;height:40px;border-radius:12px;display:block}' +
    '.dvs-bob-launch span{text-align:left}.dvs-bob-launch span small{display:block;font-weight:600;font-size:12px;color:rgba(8,54,83,.8)}' +
    '.dvs-bob-launch:hover{background:#f68d3b}.dvs-bob-launch:focus-visible{outline:3px solid #fff;outline-offset:3px}' +
    '.dvs-bob-frame{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:400px;height:min(720px,calc(100vh - 40px));' +
    'border:0;border-radius:20px;background:#e8edf1;box-shadow:0 24px 60px -20px rgba(3,22,36,.6);display:none}' +
    '.dvs-bob-open .dvs-bob-frame{display:block}.dvs-bob-open .dvs-bob-launch{display:none}' +
    '@media (max-width:520px){.dvs-bob-frame{right:0;bottom:0;width:100vw;height:100%;max-height:100dvh;border-radius:0}' +
    '.dvs-bob-launch{right:14px;bottom:14px}.dvs-bob-launch span{display:none}.dvs-bob-launch{padding:8px}}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'dvs-bob';

  var launch = document.createElement('button');
  launch.type = 'button';
  launch.className = 'dvs-bob-launch';
  launch.setAttribute('aria-label', 'Book with BOB, our booking assistant');
  launch.innerHTML =
    '<img src="' + origin + '/bob-avatar.svg" alt="">' +
    '<span>Book with BOB<small>Prices and open times</small></span>';

  var frame = null;
  var lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'dvs-bob-frame';
      frame.title = 'BOB booking chat';
      frame.src = origin + '/embed';
      frame.allow = 'clipboard-write';
      root.appendChild(frame);
    }
    root.classList.add('dvs-bob-open');
    setTimeout(function () {
      try { frame.focus(); } catch (e) {}
    }, 50);
  }

  function close() {
    root.classList.remove('dvs-bob-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    else launch.focus();
  }

  launch.addEventListener('click', open);
  root.appendChild(launch);

  function mount() {
    document.body.appendChild(root);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.addEventListener('message', function (e) {
    if (e.origin !== origin) return;
    if (e.data && e.data.type === 'dvs-bob:close') close();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && root.classList.contains('dvs-bob-open')) close();
  });

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-bob-open], a[href="#book-with-bob"]');
    if (t) {
      e.preventDefault();
      open();
    }
  });

  window.DVSBob = { open: open, close: close };
})();
