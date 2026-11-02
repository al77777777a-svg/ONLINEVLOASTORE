// Runs before the page is painted, so the chosen theme never flashes.
(function () {
  try {
    var saved = localStorage.getItem('vc-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    /* storage can be blocked; the system theme is used */
  }
})();
