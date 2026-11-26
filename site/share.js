// The share row at the foot of each page. The buttons are ordinary links and
// work with this file blocked; all it adds is the phone's own share sheet,
// where there is one, and a copy-the-link button. Nothing is sent anywhere:
// no counters, no third-party script, in keeping with the rest of the site.
(function () {
  "use strict";
  var band = document.querySelector(".share-band");
  if (!band) return;
  var url = band.getAttribute("data-share-url") || location.href;
  var text = band.getAttribute("data-share-text") || document.title;
  var native = band.querySelector("[data-share-native]");
  var copy = band.querySelector("[data-share-copy]");
  var said = band.querySelector(".copied");
  if (native && navigator.share) {
    native.hidden = false;
    native.addEventListener("click", function () {
      navigator.share({ title: "Cunning Claw", text: text, url: url }).catch(function () { /* closed without sharing */ });
    });
  }
  if (copy && navigator.clipboard && navigator.clipboard.writeText) {
    copy.hidden = false;
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(url).then(function () {
        if (said) said.textContent = "Copied.";
      }, function () {
        if (said) said.textContent = "Could not copy; the address is in the bar above.";
      });
    });
  }
})();
