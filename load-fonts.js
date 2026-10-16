// Loads the Rubik web font without holding up the page.
//
// A <link rel="stylesheet"> written in the page's <head> blocks the first
// paint until Google answers. On a slow line, or behind an Israeli content
// filter that delays fonts.googleapis.com, the popup stayed blank for seconds.
// A stylesheet added from a script doesn't block: the page draws at once in
// the system font and switches to Rubik when it arrives (display=swap).
//
// Loaded from the <head> of popup.html and daily/daily.html.
(function () {
  'use strict';
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap';
  document.head.appendChild(link);
})();
