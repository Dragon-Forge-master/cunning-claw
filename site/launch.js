// Launch countdown. A separate file on purpose: _headers sends a CSP with no
// script-src, so default-src 'self' applies and an inline <script> is silently
// refused by the browser — the countdown would show '–' forever on the live site.
  (function(){
    var target = new Date("2026-09-03T15:00:00+01:00").getTime();
    var d=document.getElementById("cd-d"),h=document.getElementById("cd-h"),
        m=document.getElementById("cd-m"),s=document.getElementById("cd-s"),
        box=document.getElementById("countdown");
    function pad(n){return (n<10?"0":"")+n;}
    function tick(){
      var left=target-Date.now();
      if(left<=0){
        box.classList.add("live");
        box.innerHTML='<div class="live-msg">The forge is open — <a href="https://github.com/Dragon-Forge-master/cunning-claw">github.com/Dragon-Forge-master/cunning-claw</a></div>';
        clearInterval(timer);return;
      }
      var sec=Math.floor(left/1000);
      d.textContent=Math.floor(sec/86400);
      h.textContent=pad(Math.floor(sec%86400/3600));
      m.textContent=pad(Math.floor(sec%3600/60));
      s.textContent=pad(sec%60);
    }
    tick();var timer=setInterval(tick,1000);
  })();
