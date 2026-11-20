(() => {
  const nav=document.querySelector(".page-nav"),panel=document.getElementById("page-nav-panel"),toggle=nav.querySelector(".page-nav-toggle");
  const links=[...panel.querySelectorAll("a[href^='#']")];
  const sections=links.map(link=>document.getElementById(link.getAttribute("href").slice(1)));
  function setOpen(open){
    nav.classList.toggle("is-open",open);toggle.setAttribute("aria-expanded",String(open));
    toggle.setAttribute("aria-label",open?"收起页面导航":"展开页面导航");
    panel.setAttribute("aria-hidden",String(!open));panel.inert=!open;
    links.forEach(link=>{link.tabIndex=open?0:-1;});
  }
  toggle.addEventListener("click",()=>setOpen(toggle.getAttribute("aria-expanded")!=="true"));
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&toggle.getAttribute("aria-expanded")==="true"){setOpen(false);toggle.focus();}});
  document.addEventListener("pointerdown",event=>{if(toggle.getAttribute("aria-expanded")==="true"&&!nav.contains(event.target))setOpen(false);});
  for(const link of links)link.addEventListener("click",()=>{if(window.matchMedia("(max-width: 760px)").matches)setOpen(false);});
  let pending=false;
  function markCurrent(){
    pending=false;const threshold=Math.min(window.innerHeight*.32,180);let index=0;
    sections.forEach((section,i)=>{if(section&&section.getBoundingClientRect().top<=threshold)index=i;});
    links.forEach((link,i)=>{if(i===index)link.setAttribute("aria-current","location");else link.removeAttribute("aria-current");});
  }
  function scheduleUpdate(){if(!pending){pending=true;requestAnimationFrame(markCurrent);}}
  window.addEventListener("scroll",scheduleUpdate,{passive:true});window.addEventListener("resize",scheduleUpdate,{passive:true});setOpen(false);markCurrent();
})();
