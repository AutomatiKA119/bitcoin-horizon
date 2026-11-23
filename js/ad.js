const AD_CLIENT = "";
const AD_SLOT = "";

export function mountAd(host) {
  host.replaceChildren();
  host.setAttribute("aria-label", "Advertisement");
  if (!AD_CLIENT || !AD_SLOT) return;
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = "inline-block";
  ins.style.width = "320px";
  ins.style.height = "50px";
  ins.dataset.adClient = AD_CLIENT;
  ins.dataset.adSlot = AD_SLOT;
  host.append(ins);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(AD_CLIENT)}`;
  script.crossOrigin = "anonymous";
  script.onload = () => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* the ad script blocked the fill */
    }
  };
  document.head.append(script);
}
