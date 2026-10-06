// Theme init: dark default, persisted. Validated — unknown values fall back to dark.
// Loaded synchronously in <head> before first paint (CSP script-src 'self' blocks inline scripts).
(function(){try{var t=localStorage.getItem('tectonic-theme');if(t!=='dark'&&t!=='light')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
